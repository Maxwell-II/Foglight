"""认证路由（Wave 3 A1）。

main.py 已经把这个 router 挂上了（prefix="/api"），所以下面的路径都写全名
`/auth/...`，**不要去改 main.py** —— 那是书籍线也会碰的文件。

请求 / 响应模型直接定义在本文件里，**不写进 schemas.py** —— 那个文件归书籍线，
两条线同时改一个文件正是 Wave 1 最贵的教训。

⚠️ 登录失败返回 **200 + {ok: false}**，不是 401（§A1）。
   401 的语义是"你没权限访问这个资源"，而 /auth/login 本来就该让未登录的人
   访问；更实际的原因是前端给 401 装了全局拦截器（跳登录页），登录失败再触发
   一次跳登录页会绕进循环。

真正的防护是**失败锁定**，不是验证码（§6）。验证码只在连续失败 3 次之后才
出现 —— 本人正常登录永远见不到它。
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.deps import (
    SESSION_COOKIE_NAME,
    CurrentUser,
    DbSession,
    as_utc,
    clear_session_cookie,
    issue_session,
    purge_expired_sessions,
    revoke_session,
    set_session_cookie,
)
from app.models import User
from app.services.captcha import consume_challenge, issue_challenge, purge_expired
from app.services.password import hash_password, verify_password

router = APIRouter(tags=["auth"])

# —— 限流阈值（§A1）。按**账号**锁，不按 IP：单用户应用按 IP 只会在他换网络时误伤自己 ——
CAPTCHA_AFTER_FAILURES = 3
LOCK_AFTER_FAILURES = 8
LOCK_MINUTES = 15

# 邮箱不存在时也走一遍 scrypt，让"没这个邮箱"和"密码不对"耗时接近，
# 不至于靠响应快慢就能枚举出哪个邮箱是真的。
_DUMMY_HASH: str | None = None


def _burn_time() -> None:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password("timing-equalizer-not-a-real-password")
    verify_password("timing-equalizer-not-a-real-password-x", _DUMMY_HASH)


class _AuthModel(BaseModel):
    """本文件内部的基类：输出 camelCase，输入两种写法都收。

    和 schemas.ApiModel 的配置一致，但**故意不 import 它** —— schemas.py 归
    书籍线，两条线并行期间少一条跨文件依赖少一次撞车。
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class LoginIn(_AuthModel):
    email: str = Field(max_length=320)
    password: str = Field(max_length=1024)
    # 只有 needsCaptcha 为 true 之后前端才会带这两个
    captcha_id: str | None = None
    captcha_answer: str | None = None


class LoginOut(_AuthModel):
    ok: bool
    #: true 表示失败次数已达阈值，前端要去取一张验证码再试
    needs_captcha: bool = False
    #: 被锁定时的剩余秒数，未锁定为 0
    locked_for_seconds: int = 0


class MeOut(_AuthModel):
    id: int
    email: str


class CaptchaOut(_AuthModel):
    id: str
    #: 内联 SVG 字符串，前端用 dangerouslySetInnerHTML 渲染
    svg: str


def _locked_seconds(user: User | None, now: datetime) -> int:
    if user is None or user.locked_until is None:
        return 0
    remaining = (as_utc(user.locked_until) - now).total_seconds()
    return max(0, math.ceil(remaining))


def _needs_captcha(user: User | None) -> bool:
    return user is not None and user.failed_login_count >= CAPTCHA_AFTER_FAILURES


@router.post("/auth/login", response_model=LoginOut)
def login(payload: LoginIn, response: Response, db: DbSession) -> LoginOut:
    now = datetime.now(timezone.utc)
    purge_expired(db)  # 顺手清过期验证码，不为它加定时任务

    email = payload.email.strip().lower()
    user = db.query(User).filter(User.email == email).one_or_none() if email else None

    # —— 锁定中：连正确密码也拒绝，且不去碰 scrypt ——
    locked = _locked_seconds(user, now)
    if locked > 0:
        return LoginOut(ok=False, needs_captcha=_needs_captcha(user), locked_for_seconds=locked)

    if user is not None and user.locked_until is not None:
        # 锁已经过期：清零重来。不清零的话第 9 次失败会立刻再次触发锁定
        # （9 >= 8），等于一旦锁过一次就再也解不开。
        user.failed_login_count = 0
        user.locked_until = None
        db.commit()

    # —— 达到阈值后必须先过验证码 ——
    # 验证码答错**不计入失败次数**：计入的话，本人认错一张图就离锁定更近一步，
    # 而攻击者反正也没法靠它试密码，代价全落在他自己身上。
    if _needs_captcha(user):
        if not consume_challenge(db, payload.captcha_id, payload.captcha_answer):
            return LoginOut(ok=False, needs_captcha=True, locked_for_seconds=0)

    if user is None or not user.password_hash:
        _burn_time()
        return LoginOut(ok=False, needs_captcha=_needs_captcha(user), locked_for_seconds=0)

    if not verify_password(payload.password, user.password_hash):
        user.failed_login_count += 1
        if user.failed_login_count >= LOCK_AFTER_FAILURES:
            user.locked_until = now + timedelta(minutes=LOCK_MINUTES)
        db.commit()
        return LoginOut(
            ok=False,
            needs_captcha=_needs_captcha(user),
            locked_for_seconds=_locked_seconds(user, now),
        )

    # —— 成功 ——
    user.failed_login_count = 0
    user.locked_until = None
    purge_expired_sessions(db)
    token, _expires_at = issue_session(db, user)
    set_session_cookie(response, token)
    return LoginOut(ok=True, needs_captcha=False, locked_for_seconds=0)


@router.post("/auth/logout", status_code=204)
def logout(request: Request, response: Response, db: DbSession) -> None:
    """删掉这条 auth_sessions 行 + 清 cookie。

    即使 cookie 已经无效也返回 204：退出登录不该失败，前端拿到 204 就跳登录页。
    """
    revoke_session(db, request.cookies.get(SESSION_COOKIE_NAME))
    clear_session_cookie(response)


@router.get("/auth/me", response_model=MeOut)
def me(user: CurrentUser) -> MeOut:
    """已登录 → {id, email}；否则由 get_current_user 抛 401 {"detail": "未登录"}。"""
    return MeOut(id=user.id, email=user.email or "")


@router.get("/auth/captcha", response_model=CaptchaOut)
def captcha(db: DbSession) -> CaptchaOut:
    challenge_id, svg = issue_challenge(db)
    return CaptchaOut(id=challenge_id, svg=svg)
