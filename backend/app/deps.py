"""FastAPI 依赖。

★ 这个文件是 Phase 3 接入登录的唯一改动点。

Phase 1 没有登录，所有请求都算作配置里那个固定用户。业务代码一律通过
get_current_user() 拿用户，绝不直接读 settings.single_user_id —— 这样
Phase 3 换成"从 session cookie 解析"时，只需要重写下面这一个函数，
路由和业务逻辑一行都不用动。

（这是选 FastAPI 而不是 Next.js 的直接回报之一，见 docs/architecture.md §2.3）
"""

from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models import User

DbSession = Annotated[Session, Depends(get_db)]


def get_current_user(db: DbSession) -> User:
    """Phase 1：返回固定用户，不存在则建出来。

    Phase 3 换成：读 session cookie → 查会话表 → 返回对应 User，
    失效时抛 401。函数签名保持不变。
    """
    user = db.get(User, settings.single_user_id)
    if user is None:
        user = User(id=settings.single_user_id)
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
