"""标记路由：新建标记（挂在 session 下）/ 删除标记。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.deps import CurrentUser, DbSession
from app.models import Article, Book, BookReadingMode, BookReadingRun, Mark, ReadingSession
from app.routers.sessions import _get_owned_session
from app.schemas import MarkCreate, MarkOut

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
