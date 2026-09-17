"""文章相关路由：列表 / 详情 / 粘贴导入 / epub 导入。

URL 导入不在这里实现——MVP 明确排除（architecture.md §7 / §5 标了 [Phase 2]）。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy import func, or_

from app.deps import CurrentUser, DbSession
from app.visibility import article_visible_to, visible_articles, visible_books
from app.models import (
    Article,
    Book,
    BookReadingMode,
    BookSection,
    License,
    Mark,
    ReadingSession,
    SessionStatus,
    SourceType,
)
from app.schemas import (
    ArticleDetail,
    ArticleImportText,
    ArticlePreviewRequest,
    ArticlePreviewResponse,
    ArticleSummary,
    BookPageContext,
    EpubImportCandidate,
)
from app.services.epub import parse_epub
from app.services.normalize import normalize
from app.services.tokenize import tokenize

router = APIRouter(tags=["articles"])


def _est_minutes(word_count: int) -> int:
    """200 词/分钟，和 seed/extract_samples.py 的估算口径保持一致。"""
    return max(1, round(word_count / 200))


def _attach_session_state(db: DbSession, articles: list[Article], user_id: int) -> list[Article]:
    """给每篇挂上「这个用户在它上面留下过什么」，供 ArticleSummary 读取。

    挂四个派生值：
      is_read              读完过没有（存在 finished 会话）
      resume_session_id    最近一个未完成**且有进度**的会话（标过东西或滚动过）。
                           「有进度」这个限定是必须的：点开两秒就退出也会留下一个
                           未完成会话，把它当成「读到一半」是假信息 —— 他没读到一半，
                           只是瞄了一眼。空会话一律当不存在，重新点开等于重新开始
      last_marks_session_id / last_marks_count
                           最近一个「标过东西」的会话及其标记数，不论读完没读完。
                           这是回到上一次标记的唯一入口。marks 挂在 session 上
                           是 models.py 的既定设计（重读是新的一组），但那个设计
                           一直缺一个「回到上一次」的口子，缺口就表现为「标记没了」。

    都不加数据库列 —— 和 level 同一条理由（§1.7）：会话表的派生值，加列就多一个
    会和事实漂移的冗余字段。也不用 relationship 逐篇查，那是 N+1（84 篇打 84 次）。
    下面是**一条** SQL：会话左连标记、按会话聚合，Python 侧再按文章归并。

    is_read 只认 FINISHED。abandoned 是「点开了没读完」，不是读完 —— 这和 sessions.py
    里 _FINISHED_STATUSES 把两者并列的口径不同：那里问「会话结束了吗」，
    这里问「他读完了吗」，是两个问题。
    """
    if not articles:
        return articles

    rows = (
        db.query(
            ReadingSession.article_id,
            ReadingSession.id,
            ReadingSession.status,
            ReadingSession.scroll_position,
            func.count(Mark.id),
        )
        .outerjoin(Mark, Mark.session_id == ReadingSession.id)
        .filter(
            ReadingSession.user_id == user_id,
            ReadingSession.article_id.in_([a.id for a in articles]),
        )
        .group_by(ReadingSession.id)
        .order_by(ReadingSession.id)
        .all()
    )

    # 按 id 升序扫一遍，后面的覆盖前面的 —— 于是每个槽位留下的都是「最近的那个」。
    # 用自增 id 而不是 started_at 排序：同一秒里连点两下，时间戳分不出先后。
    state: dict[int, dict] = {}
    for article_id, session_id, status, scroll_position, mark_count in rows:
        slot = state.setdefault(
            article_id,
            {"is_read": False, "resume": None, "marks_session": None, "marks_count": 0},
        )
        if status == SessionStatus.FINISHED:
            slot["is_read"] = True
        if status == SessionStatus.READING and (mark_count > 0 or scroll_position > 0):
            slot["resume"] = session_id
        if mark_count > 0:
            slot["marks_session"] = session_id
            slot["marks_count"] = mark_count

    for article in articles:
        slot = state.get(article.id)
        article.is_read = bool(slot and slot["is_read"])
        article.resume_session_id = slot["resume"] if slot else None
        article.last_marks_session_id = slot["marks_session"] if slot else None
        article.last_marks_count = slot["marks_count"] if slot else 0
    return articles


def _get_visible_article(db: DbSession, article_id: int, user_id: int) -> Article:
    """规则见 app/visibility.py —— 那里是唯一权威，这里不重写一遍。"""
    article = db.get(Article, article_id)
    if article is None or not article_visible_to(article, user_id):
        raise HTTPException(status_code=404, detail="文章不存在")
    return article


@router.get("/articles", response_model=list[ArticleSummary])
def list_articles(db: DbSession, user: CurrentUser) -> list[Article]:
    articles = (
        db.query(Article)
        .outerjoin(Book, Book.id == Article.book_id)
        .filter(visible_articles(user.id))
        .filter(or_(Book.id.is_(None), Book.reading_mode != BookReadingMode.FIXED_PAGES))
        .order_by(Article.created_at.desc())
        .all()
    )
    return _attach_session_state(db, articles, user.id)


@router.get("/articles/{article_id}", response_model=ArticleDetail)
def get_article(article_id: int, db: DbSession, user: CurrentUser) -> Article:
    article = _get_visible_article(db, article_id, user.id)
    article.book_context = None
    if article.book_id is not None:
        book = db.get(Book, article.book_id)
        if book is not None and book.reading_mode == BookReadingMode.FIXED_PAGES:
            section = db.get(BookSection, article.book_section_id)
            pages = (
                db.query(Article.id, Article.order_index)
                .filter(Article.book_id == book.id)
                .order_by(Article.order_index)
                .all()
            )
            position = next(i for i, row in enumerate(pages) if row.id == article.id)
            article.book_context = BookPageContext(
                book_id=book.id,
                reading_mode=book.reading_mode,
                section_id=section.id,
                section_title=section.title,
                page_number=article.order_index,
                page_count=len(pages),
                previous_article_id=pages[position - 1].id if position > 0 else None,
                next_article_id=pages[position + 1].id if position + 1 < len(pages) else None,
            )
    return _attach_session_state(db, [article], user.id)[0]


@router.post("/articles/preview/text", response_model=ArticlePreviewResponse)
def preview_text(payload: ArticlePreviewRequest) -> ArticlePreviewResponse:
    """粘贴导入前的预览：分段、计数、篇幅档位。不入库、不写数据库。"""
    body_paragraphs = tokenize(normalize(payload.text, paragraph_mode=payload.paragraph_mode))
    word_count = sum(len(p) for p in body_paragraphs)
    # 借用 Article.level 这一个唯一实现（§1.7），不额外造一份阈值判断——
    # 这个 Article 实例只在内存里算完这一次就丢弃，从不 add 进 session。
    level = Article(word_count=word_count).level
    return ArticlePreviewResponse(
        paragraph_count=len(body_paragraphs),
        word_count=word_count,
        level=level,
        first_paragraphs=[" ".join(p) for p in body_paragraphs[:3]],
    )


@router.post("/articles/import/text", response_model=ArticleDetail, status_code=201)
def import_text(payload: ArticleImportText, db: DbSession, user: CurrentUser) -> Article:
    body_paragraphs = tokenize(normalize(payload.text, paragraph_mode=payload.paragraph_mode))
    word_count = sum(len(p) for p in body_paragraphs)

    article = Article(
        title=payload.title,
        author=payload.author,
        source_type=SourceType.USER_TEXT,
        source_name=payload.source_name,
        license=payload.license,
        redistributable=payload.redistributable,
        body_paragraphs=body_paragraphs,
        word_count=word_count,
        est_minutes=_est_minutes(word_count),
        topics=payload.topics,
        created_by=user.id,
    )
    db.add(article)
    db.commit()
    db.refresh(article)
    return article


@router.post("/articles/import/epub")
async def import_epub(
    db: DbSession,
    user: CurrentUser,
    file: Annotated[UploadFile, File()],
    titles: Annotated[list[str], Form()] = [],  # noqa: B006 - FastAPI Form 需要可变默认值来识别重复字段
    book_title: Annotated[str | None, Form(alias="bookTitle")] = None,
):
    """两段式：不传 titles 只探测候选片段，传了才真正入库（入库即建书，Wave 3 B3）。"""
    data = await file.read()
    segments = parse_epub(data)

    # —— 第一段：只探测，不入库。⚠️ 这一段的行为一个字都不许变 ——
    # 它是解析质量的人工闸门：先看清切出来是什么，再决定导哪几章。
    if not titles:
        candidates = [
            EpubImportCandidate(title=seg.title, word_count=seg.word_count) for seg in segments
        ]
        return JSONResponse(
            status_code=200, content=[c.model_dump(by_alias=True) for c in candidates]
        )

    wanted = set(titles)
    source_name = file.filename.rsplit(".", 1)[0] if file.filename else None

    # ⚠️ order_index 按 segments 的**原始顺序**，不是 titles 表单里的顺序 ——
    #    表单里的勾选顺序是浏览器给的，和书内顺序无关（§1.10：order_index 是
    #    书内顺序的唯一权威，从 1 开始、连续、不重复）。
    selected = [seg for seg in segments if seg.title in wanted]
    if not selected:
        # 一章都没匹配上就不建书。空书会留在书架上占位，而且下次同名导入还会被判重挡住。
        return JSONResponse(status_code=201, content=[])

    resolved_book_title = (book_title or source_name or "未命名").strip() or "未命名"

    # 判重：同名书重复导入直接报错，不产生第二本 —— 两本同名书之后再也分不清
    # 哪本上有他的标记，而标记是这个产品唯一不可再生的数据。
    existing = (
        db.query(Book)
        .filter(Book.title == resolved_book_title, visible_books(user.id))
        .first()
    )
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=f"这本书已经导入过了（书 id={existing.id}）。要加章节请先删掉旧的那本。",
        )

    book = Book(
        title=resolved_book_title,
        author=None,
        # 书和章同一套版权分层（tech-plan.md §4.2）。epub 几乎必然是 A 层。
        license=License.COPYRIGHTED,
        redistributable=False,
        created_by=user.id,
    )
    db.add(book)
    db.flush()  # 拿到 book.id，章节才好带着 book_id 一起进去

    imported: list[Article] = []
    for order_index, seg in enumerate(selected, start=1):
        body_paragraphs = tokenize("\n\n".join(seg.paragraphs))
        word_count = sum(len(p) for p in body_paragraphs)
        article = Article(
            title=seg.title,
            author=None,
            source_type=SourceType.EPUB,
            source_name=source_name,
            license=License.COPYRIGHTED,
            redistributable=False,
            body_paragraphs=body_paragraphs,
            word_count=word_count,
            est_minutes=_est_minutes(word_count),
            topics=[],
            created_by=user.id,
            book_id=book.id,
            order_index=order_index,
        )
        db.add(article)
        imported.append(article)

    db.commit()
    for article in imported:
        db.refresh(article)

    return JSONResponse(
        status_code=201,
        content=[ArticleDetail.model_validate(a).model_dump(mode="json", by_alias=True) for a in imported],
    )
