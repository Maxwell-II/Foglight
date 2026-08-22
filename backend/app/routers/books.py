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

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy import func, or_

from app.deps import CurrentUser, DbSession
from app.models import Article, Book, Mark, ReadingSession, SessionStatus
from app.routers.articles import _attach_session_state
from app.schemas import BookDetail, BookNextChapter, BookSummary, ChapterSummary
from app.services.export import BookChapterView, build_book_markdown

router = APIRouter(tags=["books"])


def _visible_books(db: DbSession, user_id: int):
    """和文章同一套可见性：curated（created_by 为空）对所有人可见，自己导入的只对自己可见。"""
    return db.query(Book).filter(or_(Book.created_by.is_(None), Book.created_by == user_id))


def _get_visible_book(db: DbSession, book_id: int, user_id: int) -> Book:
    book = _visible_books(db, user_id).filter(Book.id == book_id).one_or_none()
    if book is None:
        raise HTTPException(status_code=404, detail="书不存在")
    return book


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

    result: list[BookSummary] = []
    for book in books:
        chapters = by_book.get(book.id, [])
        result.append(
            BookSummary(
                id=book.id,
                title=book.title,
                author=book.author,
                chapter_count=len(chapters),
                finished_chapter_count=sum(1 for c in chapters if c[0] in finished),
                total_marks=sum(marks_total.get(c[0], 0) for c in chapters),
                next_chapter=_next_chapter(chapters, finished),
            )
        )
    return result


@router.get("/books/{book_id}", response_model=BookDetail)
def get_book(book_id: int, db: DbSession, user: CurrentUser) -> BookDetail:
    """目录页：书 + 按 order_index 排好的章节。

    章节的四个会话派生值由 _attach_session_state 挂上（import 复用，不另写一份）。
    """
    book = _get_visible_book(db, book_id, user.id)

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
