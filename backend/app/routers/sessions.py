"""阅读会话路由：开始阅读 / 会话详情 / 更新进度 / 导出 Markdown。"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import or_

from app.deps import CurrentUser, DbSession
from app.models import Article, ReadingSession, SessionStatus
from app.routers.articles import _get_visible_article
from app.schemas import SessionCreate, SessionDetail, SessionOut, SessionUpdate
from app.services.export import build_markdown

router = APIRouter(tags=["sessions"])

_FINISHED_STATUSES = {SessionStatus.FINISHED, SessionStatus.ABANDONED}


def _get_owned_session(db: DbSession, session_id: int, user_id: int) -> ReadingSession:
    session = db.get(ReadingSession, session_id)
    if session is None or session.user_id != user_id:
        raise HTTPException(status_code=404, detail="会话不存在")
    return session


@router.post("/sessions", response_model=SessionOut, status_code=201)
def create_session(payload: SessionCreate, db: DbSession, user: CurrentUser) -> ReadingSession:
    _get_visible_article(db, payload.article_id, user.id)  # 404 若文章不存在/不可见

    session = ReadingSession(user_id=user.id, article_id=payload.article_id)
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.get("/sessions/{session_id}", response_model=SessionDetail)
def get_session(session_id: int, db: DbSession, user: CurrentUser) -> ReadingSession:
    return _get_owned_session(db, session_id, user.id)


@router.patch("/sessions/{session_id}", response_model=SessionOut)
def update_session(
    session_id: int, payload: SessionUpdate, db: DbSession, user: CurrentUser
) -> ReadingSession:
    session = _get_owned_session(db, session_id, user.id)

    updates = payload.model_dump(exclude_unset=True)
    if "status" in updates:
        session.status = updates["status"]
        # finished_at 只在第一次进入终止状态时打上，重复 PATCH 不覆盖。
        if updates["status"] in _FINISHED_STATUSES and session.finished_at is None:
            session.finished_at = datetime.now(timezone.utc)
    if "scroll_position" in updates:
        session.scroll_position = updates["scroll_position"]

    db.commit()
    db.refresh(session)
    return session


@router.get("/sessions/{session_id}/export")
def export_session(session_id: int, db: DbSession, user: CurrentUser) -> Response:
    session = _get_owned_session(db, session_id, user.id)
    article = db.get(Article, session.article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="文章不存在")

    markdown = build_markdown(
        title=article.title,
        author=article.author,
        source=article.source_name or article.source_url or "",
        paragraphs=article.body_paragraphs,
        marks=session.marks,
    )
    return Response(content=markdown, media_type="text/markdown; charset=utf-8")
