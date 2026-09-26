"""书籍路由（Wave 3 B1 / B2）：书架 / 目录 / 书级导出。

⚠️ 这是规划方建的空壳：main.py 已经把它挂上了，书籍线的执行 agent 只需要在
这里填内容，**不要去改 main.py** —— 那是登录线也会碰的文件，改它就撞车。

要实现的接口见 docs/work-packets-wave3.md 第 3 节 B1 / B2。

书 = 章节的有序编组（§1.9），章节**就是 Article**。所以这里一行阅读逻辑都不新写：
  - 章节的会话派生值 → 直接 import routers/articles.py 的 _attach_session_state
  - 章节的导出正文   → 直接调 services/export.py 的 build_markdown
写第二份的话，两份规则会静默错开 —— 那是 Wave 1 最贵的教训。

书级的计数和「下一章」全是派生值，不加数据库列（§1.11）。聚合走**一条 SQL**，
不用 relationship 逐章查：一本 62 章的书那样会打 62 次查询。
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError

from app.deps import CurrentUser, DbSession, WritingUser
from app.visibility import visible_books
from app.config import settings
from app.models import (
    Article,
    Book,
    BookReadingMode,
    BookReadingRun,
    BookSection,
    Mark,
    ReadingSession,
    ReviewBatch,
    ReviewBatchItem,
    SessionStatus,
)
from app.routers.articles import _attach_session_state
from app.schemas import (
    BookDetail,
    BookNextChapter,
    BookPageContext,
    BookPageSummary,
    BookSectionOut,
    BookSummary,
    BookToc,
    ChapterSummary,
    FinishReadingRunResult,
    OpenBookPage,
    OpenBookPageResult,
    ReadingRunOut,
    ReviewBatchCreate,
    ReviewBatchDetail,
    ReviewBatchSummary,
    ReviewCandidateMark,
    ReviewCandidatePage,
    ReviewCandidateResponse,
)
from app.services.export import (
    BookChapterView,
    build_book_markdown,
    build_page_review_markdown,
)

router = APIRouter(tags=["books"])


def _visible_books(db: DbSession, user_id: int):
    """规则见 app/visibility.py —— 那里是唯一权威，这里不重写一遍。"""
    return db.query(Book).filter(visible_books(user_id))


def _get_visible_book(db: DbSession, book_id: int, user_id: int) -> Book:
    book = _visible_books(db, user_id).filter(Book.id == book_id).one_or_none()
    if book is None:
        raise HTTPException(status_code=404, detail="书不存在")
    return book


def _get_fixed_book(db: DbSession, book_id: int, user_id: int) -> Book:
    book = _get_visible_book(db, book_id, user_id)
    if book.reading_mode != BookReadingMode.FIXED_PAGES:
        raise HTTPException(status_code=409, detail="这本书使用旧章节阅读模式")
    return book


def _pending_marks_query(db: DbSession, book_id: int, user_id: int):
    handled_ids = (
        select(ReviewBatchItem.mark_id)
        .join(ReviewBatch, ReviewBatch.id == ReviewBatchItem.batch_id)
        .where(ReviewBatch.handled_at.is_not(None), ReviewBatch.user_id == user_id)
    )
    return (
        db.query(Mark, Article)
        .join(ReadingSession, ReadingSession.id == Mark.session_id)
        .join(Article, Article.id == ReadingSession.article_id)
        .filter(
            ReadingSession.user_id == user_id,
            Article.book_id == book_id,
            ~Mark.id.in_(handled_ids),
        )
    )


def _pending_counts(db: DbSession, book_ids: list[int], user_id: int) -> dict[int, int]:
    if not book_ids:
        return {}
    handled_ids = (
        select(ReviewBatchItem.mark_id)
        .join(ReviewBatch, ReviewBatch.id == ReviewBatchItem.batch_id)
        .where(ReviewBatch.handled_at.is_not(None), ReviewBatch.user_id == user_id)
    )
    rows = (
        db.query(Article.book_id, func.count(Mark.id))
        .join(ReadingSession, ReadingSession.article_id == Article.id)
        .join(Mark, Mark.session_id == ReadingSession.id)
        .filter(
            Article.book_id.in_(book_ids),
            ReadingSession.user_id == user_id,
            ~Mark.id.in_(handled_ids),
        )
        .group_by(Article.book_id)
        .all()
    )
    return {book_id: count for book_id, count in rows}


def _page_context(db: DbSession, book: Book, article: Article) -> BookPageContext:
    rows = (
        db.query(Article.id, Article.order_index)
        .filter(Article.book_id == book.id)
        .order_by(Article.order_index)
        .all()
    )
    position = next(i for i, row in enumerate(rows) if row.id == article.id)
    section = db.get(BookSection, article.book_section_id)
    return BookPageContext(
        book_id=book.id,
        reading_mode=book.reading_mode,
        section_id=section.id,
        section_title=section.title,
        page_number=article.order_index,
        page_count=len(rows),
        previous_article_id=rows[position - 1].id if position else None,
        next_article_id=rows[position + 1].id if position + 1 < len(rows) else None,
    )


def _chapter_stats(
    db: DbSession, article_ids: list[int], user_id: int
) -> tuple[set[int], dict[int, int]]:
    """**一条 SQL** 拿到两件事：哪些章读完过、每章一共标了多少处。

    返回 (读完过的 article_id 集合, {article_id: 标记总数})。

    形状照抄 _attach_session_state：会话左连标记、按会话聚合，Python 侧再归并。
    左连接必须是 outer —— 用 inner join 的话「读完但一个标记都没标」的会话会整行
    消失，finishedChapterCount 就会少算，而且只在他读完却没标东西时才出错，
    是那种上线很久才被发现的偏差。

    is_read 只认 FINISHED（不认 abandoned），和 _attach_session_state 同口径。
    标记总数是**全部会话**的和，不是最近一次 —— 最近一次那个数是章级的
    lastMarksCount，两个问题不同。
    """
    if not article_ids:
        return set(), {}

    rows = (
        db.query(
            ReadingSession.article_id,
            ReadingSession.status,
            func.count(Mark.id),
        )
        .outerjoin(Mark, Mark.session_id == ReadingSession.id)
        .filter(
            ReadingSession.user_id == user_id,
            ReadingSession.article_id.in_(article_ids),
        )
        .group_by(ReadingSession.id)
        .all()
    )

    finished: set[int] = set()
    marks_total: dict[int, int] = {}
    for article_id, status, mark_count in rows:
        if status == SessionStatus.FINISHED:
            finished.add(article_id)
        if mark_count:
            marks_total[article_id] = marks_total.get(article_id, 0) + mark_count
    return finished, marks_total


def _next_chapter(
    ordered: list[tuple[int, str, int]], finished: set[int]
) -> BookNextChapter | None:
    """§1.11 写死的定义：order_index 最小的、且不存在 finished 会话的那一章。

    ⚠️ 不是「最后读的那章 + 1」—— 跳读之后那个定义会指向已经读过的章。
    ordered 必须已经按 order_index 升序（调用方用 ORDER BY 保证，§1.10）。
    """
    for article_id, title, order_index in ordered:
        if article_id not in finished:
            return BookNextChapter(article_id=article_id, title=title, order_index=order_index)
    return None


@router.get("/books", response_model=list[BookSummary])
def list_books(db: DbSession, user: CurrentUser) -> list[BookSummary]:
    """书架。总共三条查询，和书数、章数都无关（不是 N+1）。"""
    books = _visible_books(db, user.id).order_by(Book.created_at.desc(), Book.id.desc()).all()
    if not books:
        return []

    # 只取需要的四列。整行 ORM 会把 body_paragraphs（整章正文的 JSON）也拖进来，
    # 书架页根本用不到 —— 62 章的书那是几百 KB 白读。
    chapter_rows = (
        db.query(Article.book_id, Article.id, Article.title, Article.order_index)
        .filter(Article.book_id.in_([b.id for b in books]))
        .order_by(Article.book_id, Article.order_index)
        .all()
    )

    by_book: dict[int, list[tuple[int, str, int]]] = {}
    for book_id, article_id, title, order_index in chapter_rows:
        by_book.setdefault(book_id, []).append((article_id, title, order_index))

    finished, marks_total = _chapter_stats(db, [r[1] for r in chapter_rows], user.id)
    fixed_ids = [book.id for book in books if book.reading_mode == BookReadingMode.FIXED_PAGES]
    pending_counts = _pending_counts(db, fixed_ids, user.id)

    result: list[BookSummary] = []
    for book in books:
        chapters = by_book.get(book.id, [])
        is_fixed = book.reading_mode == BookReadingMode.FIXED_PAGES
        result.append(
            BookSummary(
                id=book.id,
                title=book.title,
                author=book.author,
                chapter_count=len(chapters),
                finished_chapter_count=sum(1 for c in chapters if c[0] in finished),
                total_marks=sum(marks_total.get(c[0], 0) for c in chapters),
                next_chapter=_next_chapter(chapters, finished),
                reading_mode=book.reading_mode,
                page_count=len(chapters) if is_fixed else 0,
                finished_page_count=sum(1 for c in chapters if c[0] in finished) if is_fixed else 0,
                pending_review_count=pending_counts.get(book.id, 0),
            )
        )
    return result


@router.get("/books/{book_id}", response_model=BookDetail)
def get_book(book_id: int, db: DbSession, user: CurrentUser) -> BookDetail:
    """目录页：书 + 按 order_index 排好的章节。

    章节的四个会话派生值由 _attach_session_state 挂上（import 复用，不另写一份）。
    """
    book = _get_visible_book(db, book_id, user.id)

    if book.reading_mode == BookReadingMode.FIXED_PAGES:
        rows = (
            db.query(Article.id, Article.title, Article.order_index)
            .filter(Article.book_id == book.id)
            .order_by(Article.order_index)
            .all()
        )
        finished, marks_total = _chapter_stats(db, [row.id for row in rows], user.id)
        ordered = [(row.id, row.title, row.order_index) for row in rows]
        return BookDetail(
            id=book.id,
            title=book.title,
            author=book.author,
            chapter_count=0,
            finished_chapter_count=0,
            total_marks=sum(marks_total.values()),
            next_chapter=_next_chapter(ordered, finished),
            reading_mode=book.reading_mode,
            page_count=len(rows),
            finished_page_count=len(finished),
            pending_review_count=_pending_marks_query(db, book.id, user.id).count(),
            chapters=[],
        )

    chapters = (
        db.query(Article)
        .filter(Article.book_id == book.id)
        # §1.10：书内顺序的唯一权威是 order_index，禁止拿 id / created_at 代替
        .order_by(Article.order_index)
        .all()
    )
    _attach_session_state(db, chapters, user.id)

    article_ids = [c.id for c in chapters]
    finished, marks_total = _chapter_stats(db, article_ids, user.id)
    ordered = [(c.id, c.title, c.order_index) for c in chapters]

    return BookDetail(
        id=book.id,
        title=book.title,
        author=book.author,
        chapter_count=len(chapters),
        finished_chapter_count=sum(1 for c in chapters if c.id in finished),
        total_marks=sum(marks_total.get(cid, 0) for cid in article_ids),
        next_chapter=_next_chapter(ordered, finished),
        reading_mode=book.reading_mode,
        page_count=len(chapters) if book.reading_mode == BookReadingMode.FIXED_PAGES else 0,
        finished_page_count=(
            sum(1 for c in chapters if c.id in finished)
            if book.reading_mode == BookReadingMode.FIXED_PAGES
            else 0
        ),
        pending_review_count=(
            _pending_marks_query(db, book.id, user.id).count()
            if book.reading_mode == BookReadingMode.FIXED_PAGES
            else 0
        ),
        chapters=[ChapterSummary.model_validate(c) for c in chapters],
    )


@router.get("/books/{book_id}/export")
def export_book(
    book_id: int,
    db: DbSession,
    user: CurrentUser,
    # from 是 Python 关键字，只能靠 alias 接住查询串里的 ?from=1
    from_: Annotated[int | None, Query(alias="from", ge=1)] = None,
    to: Annotated[int | None, Query(ge=1)] = None,
) -> Response:
    """按章区间导出标记。闭区间，按 order_index；两个都省略 = 整本。

    ⚠️ 没有「按页导出」这回事（§0.2）：页是重排后的视口产物，换个字号就变。
       本项目的坐标是 (段序号, 词序号)，按章选才是能对得上的口径。
    """
    book = _get_visible_book(db, book_id, user.id)

    query = db.query(Article).filter(Article.book_id == book.id)
    if from_ is not None:
        query = query.filter(Article.order_index >= from_)
    if to is not None:
        query = query.filter(Article.order_index <= to)
    chapters = query.order_by(Article.order_index).all()

    marks_by_article: dict[int, list[Mark]] = {}
    if chapters:
        # 一条 SQL 取回这些章上该用户的全部标记。marks 挂在会话上（models.py 的既定
        # 设计：重读是新的一组），所以要经 reading_sessions 才能过滤到「他的」标记。
        rows = (
            db.query(ReadingSession.article_id, Mark)
            .join(ReadingSession, Mark.session_id == ReadingSession.id)
            .filter(
                ReadingSession.user_id == user.id,
                ReadingSession.article_id.in_([c.id for c in chapters]),
            )
            .order_by(Mark.id)
            .all()
        )
        for article_id, mark in rows:
            marks_by_article.setdefault(article_id, []).append(mark)

    # 只取有标记的章。没标记的章带进来只会让复盘素材里塞满没问题要问的正文。
    views = [
        BookChapterView(
            order_index=c.order_index,
            title=c.title,
            author=c.author,
            source=c.source_name or c.source_url or "",
            paragraphs=c.body_paragraphs,
            marks=marks_by_article[c.id],
        )
        for c in chapters
        if marks_by_article.get(c.id)
    ]
    if not views:
        # 空壳 Markdown 比报错更糟：他会以为导出成功、粘给 agent 之后才发现没内容。
        raise HTTPException(status_code=404, detail="这个范围里还没有标记")

    markdown = build_book_markdown(
        book_title=book.title,
        author=book.author,
        chapters=views,
    )
    return Response(content=markdown, media_type="text/markdown; charset=utf-8")


# ---------- Wave 3B fixed-page reading ----------


@router.get("/books/{book_id}/toc", response_model=BookToc)
def get_book_toc(book_id: int, db: DbSession, user: CurrentUser) -> BookToc:
    book = _get_fixed_book(db, book_id, user.id)
    pages = (
        db.query(Article)
        .filter(Article.book_id == book.id)
        .order_by(Article.order_index)
        .all()
    )
    finished, _marks = _chapter_stats(db, [page.id for page in pages], user.id)
    active = (
        db.query(BookReadingRun)
        .filter(
            BookReadingRun.user_id == user.id,
            BookReadingRun.book_id == book.id,
            BookReadingRun.ended_at.is_(None),
        )
        .one_or_none()
    )
    by_section: dict[int, list[Article]] = {}
    for page in pages:
        by_section.setdefault(page.book_section_id, []).append(page)
    sections = []
    for section in book.sections:
        section_pages = by_section.get(section.id, [])
        if not section_pages:
            continue
        sections.append(
            BookSectionOut(
                id=section.id,
                order_index=section.order_index,
                title=section.title,
                kind=section.kind,
                part_title=section.part_title,
                first_page=section_pages[0].order_index,
                last_page=section_pages[-1].order_index,
                page_count=len(section_pages),
                finished_page_count=sum(page.id in finished for page in section_pages),
            )
        )
    resume_article_id = None
    if active and active.current_session_id:
        current = db.get(ReadingSession, active.current_session_id)
        resume_article_id = current.article_id if current else None
    return BookToc(
        book_id=book.id,
        title=book.title,
        author=book.author,
        page_count=len(pages),
        finished_page_count=len(finished),
        pending_review_count=_pending_marks_query(db, book.id, user.id).count(),
        active_run_id=active.id if active else None,
        resume_article_id=resume_article_id,
        sections=sections,
    )


@router.get("/books/{book_id}/pages", response_model=list[BookPageSummary])
def get_book_pages(
    book_id: int,
    db: DbSession,
    user: CurrentUser,
    section_id: Annotated[int, Query(alias="sectionId", ge=1)],
) -> list[BookPageSummary]:
    book = _get_fixed_book(db, book_id, user.id)
    section = db.get(BookSection, section_id)
    if section is None or section.book_id != book.id:
        raise HTTPException(status_code=404, detail="目录章节不存在")
    pages = (
        db.query(Article)
        .filter(Article.book_id == book.id, Article.book_section_id == section.id)
        .order_by(Article.order_index)
        .all()
    )
    finished, mark_counts = _chapter_stats(db, [page.id for page in pages], user.id)
    return [
        BookPageSummary(
            article_id=page.id,
            page_number=page.order_index,
            title=page.title,
            word_count=page.word_count,
            is_read=page.id in finished,
            mark_count=mark_counts.get(page.id, 0),
        )
        for page in pages
    ]


def _recommended_page(db: DbSession, book: Book, user_id: int, run: BookReadingRun | None) -> Article:
    if run and run.current_session_id:
        session = db.get(ReadingSession, run.current_session_id)
        if session:
            current = db.get(Article, session.article_id)
            if current and session.status != SessionStatus.FINISHED:
                return current
            if current:
                following = (
                    db.query(Article)
                    .filter(Article.book_id == book.id, Article.order_index > current.order_index)
                    .order_by(Article.order_index)
                    .first()
                )
                if following:
                    return following
                return current
    pages = (
        db.query(Article)
        .filter(Article.book_id == book.id)
        .order_by(Article.order_index)
        .all()
    )
    finished, _ = _chapter_stats(db, [page.id for page in pages], user_id)
    return next((page for page in pages if page.id not in finished), pages[-1])


@router.post("/books/{book_id}/reading-runs", response_model=ReadingRunOut)
def start_reading_run(book_id: int, db: DbSession, user: WritingUser) -> ReadingRunOut:
    book = _get_fixed_book(db, book_id, user.id)
    run = (
        db.query(BookReadingRun)
        .filter(
            BookReadingRun.user_id == user.id,
            BookReadingRun.book_id == book.id,
            BookReadingRun.ended_at.is_(None),
        )
        .one_or_none()
    )
    if run is None:
        previous = (
            db.query(BookReadingRun)
            .filter(BookReadingRun.user_id == user.id, BookReadingRun.book_id == book.id)
            .order_by(BookReadingRun.id.desc())
            .first()
        )
        run = BookReadingRun(
            user_id=user.id,
            book_id=book.id,
            current_session_id=previous.current_session_id if previous else None,
        )
        db.add(run)
        try:
            db.commit()
            db.refresh(run)
        except IntegrityError:
            db.rollback()
            run = (
                db.query(BookReadingRun)
                .filter(
                    BookReadingRun.user_id == user.id,
                    BookReadingRun.book_id == book.id,
                    BookReadingRun.ended_at.is_(None),
                )
                .one()
            )
    page = _recommended_page(db, book, user.id, run)
    return ReadingRunOut(
        id=run.id,
        book_id=book.id,
        current_session_id=run.current_session_id,
        recommended_article_id=page.id,
        started_at=run.started_at,
        ended_at=run.ended_at,
    )


@router.post(
    "/books/{book_id}/reading-runs/{run_id}/open-page",
    response_model=OpenBookPageResult,
)
def open_book_page(
    book_id: int,
    run_id: int,
    payload: OpenBookPage,
    db: DbSession,
    user: WritingUser,
) -> OpenBookPageResult:
    book = _get_fixed_book(db, book_id, user.id)
    run = db.get(BookReadingRun, run_id)
    if run is None or run.user_id != user.id or run.book_id != book.id:
        raise HTTPException(status_code=404, detail="阅读批次不存在")
    if run.ended_at is not None:
        raise HTTPException(status_code=409, detail="阅读批次已经结束")
    article = db.get(Article, payload.article_id)
    if article is None or article.book_id != book.id:
        raise HTTPException(status_code=404, detail="书页不存在")
    session = (
        db.query(ReadingSession)
        .filter(ReadingSession.user_id == user.id, ReadingSession.article_id == article.id)
        .order_by(ReadingSession.id.desc())
        .first()
    )
    if session is None:
        session = ReadingSession(user_id=user.id, article_id=article.id)
        db.add(session)
        db.flush()
    run.current_session_id = session.id
    db.commit()
    return OpenBookPageResult(
        run_id=run.id,
        session_id=session.id,
        book_context=_page_context(db, book, article),
    )


@router.post(
    "/books/{book_id}/reading-runs/{run_id}/finish",
    response_model=FinishReadingRunResult,
)
def finish_reading_run(
    book_id: int, run_id: int, db: DbSession, user: CurrentUser
) -> FinishReadingRunResult:
    book = _get_fixed_book(db, book_id, user.id)
    run = db.get(BookReadingRun, run_id)
    if run is None or run.user_id != user.id or run.book_id != book.id:
        raise HTTPException(status_code=404, detail="阅读批次不存在")
    if run.ended_at is None:
        run.ended_at = datetime.now(timezone.utc)
        db.commit()
    pending = _pending_marks_query(db, book.id, user.id).count()
    return FinishReadingRunResult(run_id=run.id, book_id=book.id, pending_count=pending)


def _batch_summary(batch: ReviewBatch) -> ReviewBatchSummary:
    return ReviewBatchSummary(
        id=batch.id,
        page_numbers=batch.page_numbers,
        mark_count=batch.mark_count,
        created_at=batch.created_at,
        handled_at=batch.handled_at,
    )


@router.get("/books/{book_id}/review-candidates", response_model=ReviewCandidateResponse)
def review_candidates(
    book_id: int,
    db: DbSession,
    user: CurrentUser,
    run_id: Annotated[int | None, Query(alias="runId", ge=1)] = None,
) -> ReviewCandidateResponse:
    book = _get_fixed_book(db, book_id, user.id)
    run = None
    if run_id is not None:
        run = db.get(BookReadingRun, run_id)
        if run is None or run.user_id != user.id or run.book_id != book.id:
            raise HTTPException(status_code=404, detail="阅读批次不存在")
    rows = _pending_marks_query(db, book.id, user.id).order_by(Article.order_index, Mark.id).all()
    grouped: dict[int, ReviewCandidatePage] = {}
    for mark, article in rows:
        page = grouped.setdefault(
            article.id,
            ReviewCandidatePage(
                article_id=article.id,
                page_number=article.order_index,
                section_title=article.title,
            ),
        )
        item = ReviewCandidateMark(
            id=mark.id,
            type=mark.type,
            surface_text=mark.surface_text,
            start_paragraph_idx=mark.start_paragraph_idx,
            start_word_idx=mark.start_word_idx,
        )
        if run and mark.book_run_id == run.id:
            page.current_marks.append(item)
        else:
            page.earlier_marks.append(item)
    batches = (
        db.query(ReviewBatch)
        .filter(
            ReviewBatch.user_id == user.id,
            ReviewBatch.book_id == book.id,
            ReviewBatch.handled_at.is_(None),
        )
        .order_by(ReviewBatch.id.desc())
        .all()
    )
    return ReviewCandidateResponse(
        run_id=run.id if run else None,
        pages=list(grouped.values()),
        open_batches=[_batch_summary(batch) for batch in batches],
    )


@router.post("/books/{book_id}/review-batches", response_model=ReviewBatchDetail, status_code=201)
def create_review_batch(
    book_id: int,
    payload: ReviewBatchCreate,
    db: DbSession,
    user: WritingUser,
) -> ReviewBatchDetail:
    book = _get_fixed_book(db, book_id, user.id)
    mark_ids = list(dict.fromkeys(payload.mark_ids))
    if len(mark_ids) != len(payload.mark_ids):
        raise HTTPException(status_code=422, detail="标记不能重复选择")
    existing = (
        db.query(ReviewBatch)
        .filter(ReviewBatch.user_id == user.id, ReviewBatch.request_key == payload.request_key)
        .one_or_none()
    )
    if existing:
        existing_ids = sorted(item.mark_id for item in existing.items if item.mark_id is not None)
        if existing.book_id != book.id or existing_ids != sorted(mark_ids):
            raise HTTPException(status_code=409, detail="requestKey 已用于另一批内容")
        return ReviewBatchDetail(
            **_batch_summary(existing).model_dump(),
            book_id=book.id,
            markdown=existing.markdown_snapshot,
        )
    run = None
    if payload.run_id is not None:
        run = db.get(BookReadingRun, payload.run_id)
        if run is None or run.user_id != user.id or run.book_id != book.id:
            raise HTTPException(status_code=404, detail="阅读批次不存在")
    rows = (
        db.query(Mark, Article)
        .join(ReadingSession, ReadingSession.id == Mark.session_id)
        .join(Article, Article.id == ReadingSession.article_id)
        .filter(
            Mark.id.in_(mark_ids),
            ReadingSession.user_id == user.id,
            Article.book_id == book.id,
        )
        .all()
    )
    if len(rows) != len(mark_ids):
        raise HTTPException(status_code=404, detail="有标记不存在")
    handled_ids = {
        value
        for (value,) in (
            db.query(ReviewBatchItem.mark_id)
            .join(ReviewBatch, ReviewBatch.id == ReviewBatchItem.batch_id)
            .filter(ReviewBatch.handled_at.is_not(None), ReviewBatchItem.mark_id.in_(mark_ids))
            .all()
        )
    }
    if handled_ids:
        raise HTTPException(status_code=409, detail="有标记已经处理，请刷新选择")
    by_page: dict[int, tuple[Article, list[Mark]]] = {}
    for mark, article in rows:
        by_page.setdefault(article.id, (article, []))[1].append(mark)
    views = [
        BookChapterView(
            order_index=article.order_index,
            title=article.title,
            author=article.author,
            source=article.source_name or "",
            paragraphs=article.body_paragraphs,
            marks=marks,
            layout=article.book_page_layout,
        )
        for article, marks in sorted(by_page.values(), key=lambda row: row[0].order_index)
    ]
    markdown = build_page_review_markdown(
        book_title=book.title,
        author=book.author,
        content_key=book.content_key,
        pages=views,
    )
    batch = ReviewBatch(
        user_id=user.id,
        book_id=book.id,
        source_run_id=run.id if run else None,
        request_key=payload.request_key,
        markdown_snapshot=markdown,
        page_numbers=[view.order_index for view in views],
        mark_count=len(mark_ids),
    )
    db.add(batch)
    db.flush()
    db.add_all([ReviewBatchItem(batch_id=batch.id, mark_id=mark_id) for mark_id in mark_ids])
    db.commit()
    db.refresh(batch)
    return ReviewBatchDetail(
        **_batch_summary(batch).model_dump(), book_id=book.id, markdown=markdown
    )


def _owned_batch(db: DbSession, book_id: int, batch_id: int, user_id: int) -> ReviewBatch:
    batch = db.get(ReviewBatch, batch_id)
    if batch is None or batch.user_id != user_id or batch.book_id != book_id:
        raise HTTPException(status_code=404, detail="回顾批次不存在")
    return batch


@router.get("/books/{book_id}/review-batches", response_model=list[ReviewBatchSummary])
def list_review_batches(
    book_id: int,
    db: DbSession,
    user: CurrentUser,
    cursor: Annotated[int | None, Query(ge=1)] = None,
) -> list[ReviewBatchSummary]:
    _get_fixed_book(db, book_id, user.id)
    query = (
        db.query(ReviewBatch)
        .filter(ReviewBatch.user_id == user.id, ReviewBatch.book_id == book_id)
    )
    if cursor is not None:
        query = query.filter(ReviewBatch.id < cursor)
    batches = query.order_by(ReviewBatch.id.desc()).limit(50).all()
    return [_batch_summary(batch) for batch in batches]


@router.get("/books/{book_id}/review-batches/{batch_id}", response_model=ReviewBatchDetail)
def get_review_batch(
    book_id: int, batch_id: int, db: DbSession, user: CurrentUser
) -> ReviewBatchDetail:
    _get_fixed_book(db, book_id, user.id)
    batch = _owned_batch(db, book_id, batch_id, user.id)
    return ReviewBatchDetail(
        **_batch_summary(batch).model_dump(),
        book_id=book_id,
        markdown=batch.markdown_snapshot,
    )


@router.get("/books/{book_id}/review-batches/{batch_id}/export")
def export_review_batch(
    book_id: int, batch_id: int, db: DbSession, user: CurrentUser
) -> Response:
    _get_fixed_book(db, book_id, user.id)
    batch = _owned_batch(db, book_id, batch_id, user.id)
    return Response(content=batch.markdown_snapshot, media_type="text/markdown; charset=utf-8")


@router.post("/books/{book_id}/review-batches/{batch_id}/handle", response_model=ReviewBatchSummary)
def handle_review_batch(
    book_id: int, batch_id: int, db: DbSession, user: CurrentUser
) -> ReviewBatchSummary:
    _get_fixed_book(db, book_id, user.id)
    batch = _owned_batch(db, book_id, batch_id, user.id)
    if batch.handled_at is None:
        batch.handled_at = datetime.now(timezone.utc)
        db.commit()
    return _batch_summary(batch)


@router.get("/books/{book_id}/assets/{asset_key}")
def get_book_asset(book_id: int, asset_key: str, db: DbSession, user: CurrentUser):
    book = _get_fixed_book(db, book_id, user.id)
    allowed = {item["key"] for item in (book.content_manifest or {}).get("assets", [])}
    if asset_key not in allowed or Path(asset_key).name != asset_key:
        raise HTTPException(status_code=404, detail="插图不存在")
    path = settings.book_assets_dir / book.content_key / asset_key
    if not path.is_file():
        raise HTTPException(status_code=404, detail="插图不存在")
    return FileResponse(path)
