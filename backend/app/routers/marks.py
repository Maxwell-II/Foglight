"""标记路由：新建标记（挂在 session 下）/ 删除标记。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.deps import CurrentUser, DbSession
from app.models import Mark, ReadingSession
from app.routers.sessions import _get_owned_session
from app.schemas import MarkCreate, MarkOut

router = APIRouter(tags=["marks"])


@router.post("/sessions/{session_id}/marks", response_model=MarkOut, status_code=201)
def create_mark(
    session_id: int, payload: MarkCreate, db: DbSession, user: CurrentUser
) -> Mark:
    session = _get_owned_session(db, session_id, user.id)

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
