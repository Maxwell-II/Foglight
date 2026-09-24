"""标记路由：新建标记（挂在 session 下）/ 删除标记 / 游客标记迁移。"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from app.deps import CurrentUser, DbSession
from app.models import (
    Article,
    Book,
    BookReadingMode,
    BookReadingRun,
    Mark,
    ReadingSession,
    SessionStatus,
)
from app.routers.sessions import _get_owned_session
from app.schemas import MarkCreate, MarkOut, MarksImportRequest, MarksImportResult
from app.services.mark_positions import first_position_error
from app.visibility import visible_articles

router = APIRouter(tags=["marks"])


@router.post("/sessions/{session_id}/marks", response_model=MarkOut, status_code=201)
def create_mark(
    session_id: int, payload: MarkCreate, db: DbSession, user: CurrentUser
) -> Mark:
    session = _get_owned_session(db, session_id, user.id)
    article = db.get(Article, session.article_id)
    book = db.get(Book, article.book_id) if article and article.book_id else None
    if book and book.reading_mode == BookReadingMode.FIXED_PAGES:
        if payload.book_run_id is None:
            raise HTTPException(status_code=409, detail="分页书标记缺少当前阅读批次")
        run = db.get(BookReadingRun, payload.book_run_id)
        if (
            run is None
            or run.user_id != user.id
            or run.book_id != book.id
            or run.ended_at is not None
            or run.current_session_id != session.id
        ):
            raise HTTPException(status_code=409, detail="阅读批次已结束或与当前页面不一致")
    elif payload.book_run_id is not None:
        raise HTTPException(status_code=409, detail="此内容不接受书籍阅读批次")

    mark = Mark(session_id=session.id, **payload.model_dump())
    db.add(mark)
    db.commit()
    db.refresh(mark)
    return mark


@router.delete("/marks/{mark_id}", status_code=204)
def delete_mark(mark_id: int, db: DbSession, user: CurrentUser) -> None:
    mark = db.get(Mark, mark_id)
    if mark is None:
        raise HTTPException(status_code=404, detail="标记不存在")

    session = db.get(ReadingSession, mark.session_id)
    if session is None or session.user_id != user.id:
        raise HTTPException(status_code=404, detail="标记不存在")

    db.delete(mark)
    db.commit()


@router.post("/marks/import", response_model=MarksImportResult)
def import_marks(payload: MarksImportRequest, db: DbSession, user: CurrentUser) -> MarksImportResult:
    """游客注册 / 登录后，把 localStorage 里的标记搬进账号（user-flows.md 路径 2）。

    每一项新建一个 ReadingSession —— 不并进已有会话：标记挂在会话上、重读是新的
    一组（public-release.md §2 保留的设计），本地那一次阅读就是独立的一次。

    ⚠️ **全部成功或全部不写。** 先把整个请求校验完，再一次性写入、一次 commit。
       前端的约定是「成功后才清本地」（user-flows.md 路径 2 第 3 步）：
       要是写了一半就报错，前端不清本地、用户重试，已写进去的那一半就会重复一份。

    **看不到的文章是例外：跳过，不报错**，id 放进 skippedArticleIds 返回。
    （不存在、下架、不在公开库，一律这么处理，不区分 —— 对调用方都是「这篇搬不了」。）
    理由：游客本地的记录里只要有一篇后来被下架，整请求 422 的话这台浏览器就
    **永远**迁移不了，剩下那些好好的标记也跟着陪葬。跳过的项不写任何东西，
    所以「全有或全无」对真正要写的那部分仍然成立。
    其余错误（下标越界、带阅读批次、超数量上限）照旧整个请求 422。
    """
    # —— 第一遍：只校验，不写 ——
    article_ids = {item.article_id for item in payload.sessions}
    articles: dict[int, Article] = {}
    if article_ids:
        # 可见性只问 visibility，不在这里另写规则
        rows = (
            db.query(Article)
            .filter(Article.id.in_(article_ids), visible_articles(user.id))
            .all()
        )
        articles = {article.id: article for article in rows}
    skipped = sorted(article_ids - articles.keys())

    fixed_book_ids = {
        book_id
        for (book_id,) in db.query(Book.id)
        .filter(
            Book.id.in_({a.book_id for a in articles.values() if a.book_id is not None}),
            Book.reading_mode == BookReadingMode.FIXED_PAGES,
        )
        .all()
    }

    for index, item in enumerate(payload.sessions):
        # 阅读批次对每一项都查，包括要跳过的：带批次说明请求本身是错的，
        # 不是「这篇搬不了」
        if any(mark.book_run_id is not None for mark in item.marks):
            raise HTTPException(status_code=422, detail=f"第 {index + 1} 项的标记不能带阅读批次")
        article = articles.get(item.article_id)
        if article is None:
            continue  # 跳过的项：没有正文可对，下标也无从校验
        if article.book_id in fixed_book_ids:
            # 分页书的标记必须挂在一次阅读批次上（create_mark 同一条规则），
            # 游客那边没有批次，搬进来会变成一堆来路不明的待复盘项
            raise HTTPException(status_code=422, detail=f"第 {index + 1} 项是分页书的书页，不能迁移")
        error = first_position_error(article.body_paragraphs, item.marks)
        if error:
            raise HTTPException(status_code=422, detail=f"第 {index + 1} 项：{error}")

    # —— 第二遍：一次写完 ——
    now = datetime.now(timezone.utc)
    to_import = [item for item in payload.sessions if item.article_id in articles]
    imported_marks = 0
    try:
        for item in to_import:
            session = ReadingSession(
                user_id=user.id,
                article_id=item.article_id,
                status=SessionStatus.FINISHED if item.finished else SessionStatus.READING,
                finished_at=now if item.finished else None,
            )
            session.marks = [Mark(**mark.model_dump()) for mark in item.marks]
            imported_marks += len(item.marks)
            db.add(session)
        db.commit()
    except Exception:
        db.rollback()
        raise

    return MarksImportResult(
        imported_sessions=len(to_import),
        imported_marks=imported_marks,
        skipped_article_ids=skipped,
    )
