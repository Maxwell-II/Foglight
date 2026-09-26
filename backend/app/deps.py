"""FastAPI 依赖。

★ 这个文件是接入登录的唯一改动点，Wave 3 §1.12 已核实这句话仍然成立：
  articles.py / sessions.py / marks.py 的每一个路由都通过 CurrentUser 拿用户，
  没有任何一处写死用户 id —— 所以下面这个函数从"返回固定用户"换成
  "读 cookie 查会话表"之后，业务路由一行都不用改。

  （这是选 FastAPI 而不是 Next.js 的直接回报之一，见 docs/architecture.md §2.3）

现在的行为（Wave 3 A1）::

    读 reading_session cookie -> 查 auth_sessions -> 未过期则返回对应 User
                                                  -> 否则 401 {"detail": "未登录"}

⚠️ 401 不带 `WWW-Authenticate` 头，也**绝不 302 跳转**（§1.12(c)）：
   - 302 会被 fetch 静默跟随，前端拿回一坨 HTML，报错变成"JSON 解析失败"，
     完全指错方向；
   - `WWW-Authenticate` 会让浏览器弹出原生 Basic Auth 对话框，那是 nginx
     那一层的东西，和本应用的登录页冲突。
"""

from __future__ import annotations

import hashlib
import ipaddress
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models import AuthSession, User
from app.services.ratelimit import SlidingWindowLimiter

DbSession = Annotated[Session, Depends(get_db)]

# —— Cookie 属性（§1.13，写死，不要改）——
SESSION_COOKIE_NAME = "reading_session"
SESSION_COOKIE_PATH = "/"
SESSION_COOKIE_SAMESITE = "lax"

UNAUTHENTICATED_DETAIL = "未登录"

# 令牌长度：32 字节熵，token_urlsafe 出来 43 个字符
_TOKEN_BYTES = 32


def as_utc(value: datetime) -> datetime:
    """SQLite 的 DATETIME 列不存时区，读回来一律是 naive 的。

    库里存进去的都是 UTC（models._utcnow），所以 naive 值直接补上 UTC 即可。
    不补的话 `naive < aware` 会直接 TypeError —— 而它只在"会话过期"这条
    冷路径上发作，平时测不出来。
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def hash_token(token: str) -> str:
    """存进 auth_sessions 的是这个摘要，不是明文令牌。

    理由（§1.13）：db 文件会被 deploy/backup.sh 备份到 /var/backups 并保留
    7 份，明文令牌进备份等于把登录态泄漏面扩大到所有历史备份。
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def issue_session(db: Session, user: User) -> tuple[str, datetime]:
    """建一条登录会话，返回 (明文令牌, 过期时间)。明文只回给调用方写进 cookie。"""
    token = secrets.token_urlsafe(_TOKEN_BYTES)
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.session_ttl_days)
    db.add(AuthSession(user_id=user.id, token_hash=hash_token(token), expires_at=expires_at))
    db.commit()
    return token, expires_at


def revoke_session(db: Session, token: str | None) -> bool:
    """退出登录：删掉这一行。删行而不是打标记 —— 要的就是"立刻失效"。"""
    if not token:
        return False
    deleted = (
        db.query(AuthSession)
        .filter(AuthSession.token_hash == hash_token(token))
        .delete(synchronize_session=False)
    )
    db.commit()
    return bool(deleted)


def purge_expired_sessions(db: Session) -> int:
    """顺手清理过期会话。和验证码一样，不为它加定时任务。"""
    deleted = (
        db.query(AuthSession)
        .filter(AuthSession.expires_at < datetime.now(timezone.utc))
        .delete(synchronize_session=False)
    )
    return int(deleted)


def set_session_cookie(response: Response, token: str) -> None:
    """写登录 cookie。

    ⚠️ `secure` 必须走 settings.session_cookie_secure，**不许写死 True** ——
       本地开发跑在 http，写死 True 会让浏览器根本不发这条 cookie，而且
       不报任何错，症状是"登录返回 200 但下一个请求就 401"，极难判断。
       线上由 deploy/docker-compose.yml 注入 SESSION_COOKIE_SECURE=true。
    """
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=settings.session_ttl_days * 24 * 60 * 60,
        httponly=True,  # JS 读不到，XSS 偷不走
        secure=settings.session_cookie_secure,
        samesite=SESSION_COOKIE_SAMESITE,
        path=SESSION_COOKIE_PATH,
    )


def clear_session_cookie(response: Response) -> None:
    """删 cookie。属性必须和写入时一致，否则浏览器认不出是同一条，删不掉。"""
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path=SESSION_COOKIE_PATH,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite=SESSION_COOKIE_SAMESITE,
    )


def get_current_user(request: Request, db: DbSession) -> User:
    """读 session cookie → 查会话表 → 返回对应 User，失效时抛 401。"""
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail=UNAUTHENTICATED_DETAIL)

    auth_session = (
        db.query(AuthSession).filter(AuthSession.token_hash == hash_token(token)).one_or_none()
    )
    if auth_session is None:
        raise HTTPException(status_code=401, detail=UNAUTHENTICATED_DETAIL)

    if as_utc(auth_session.expires_at) <= datetime.now(timezone.utc):
        # 过期就地删掉：下次不用再算一遍，也不留着占 unique 索引
        db.delete(auth_session)
        db.commit()
        raise HTTPException(status_code=401, detail=UNAUTHENTICATED_DETAIL)

    user = db.get(User, auth_session.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail=UNAUTHENTICATED_DETAIL)
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


# —— 导入权限（public-release.md §3⑥ + §2「公开版不做用户导入」）——

IMPORT_FORBIDDEN_DETAIL = "没有导入权限"


def get_import_user(user: CurrentUser) -> User:
    """导入 / 预览三条路由的门：登录之外还要 can_import。

    为什么不是"登录就能导入"：§2 拍板公开版不给用户导入入口，而这三条是全项目
    最贵的入口（分词整篇正文、解析整本 epub）。只靠前端不给按钮等于没挡 ——
    接口一直在，任何注册用户都能直接打。can_import 默认 false，迁移只给 id=1 开。
    """
    if not user.can_import:
        raise HTTPException(status_code=403, detail=IMPORT_FORBIDDEN_DETAIL)
    return user


ImportUser = Annotated[User, Depends(get_import_user)]


# —— 单用户写入配额（2026-09-26）——
#
# 注册挡得住「一个 IP 刷一万个号」，挡不住「一个号写一百万行」：建会话、加标记、
# 迁移游客标记这几条每打一次就往 SQLite 里多一行，原来没有任何上限，一个脚本
# 就能把库撑爆（整机可用 698Mi）。这里按用户 id 计两个数：
#
# - 每分钟 60 个写请求：挡刷接口。真人标得再快也是几秒一处
# - 每天 2000 行：挡灌库。迁移一个请求就能写几百行，所以按**行数**扣，不按请求数。
#   库里最重的一天是 8 次会话、几十处标记，2000 是它的几十倍
#
# 只管**新增行**的路由。PATCH 进度、删标记不长库，不扣；刷它们的流量归 nginx 的
# limit_req 管（deploy/nginx.conf）。计数在内存里，前提同 services/ratelimit.py 顶部。

WRITES_PER_MINUTE = 60
ROWS_PER_DAY = 2000
_writes_per_minute = SlidingWindowLimiter(WRITES_PER_MINUTE, 60)
_rows_per_day = SlidingWindowLimiter(ROWS_PER_DAY, 24 * 60 * 60)


def reset_write_quotas() -> None:
    """清空写入配额。给测试用；线上等价于重启进程。"""
    _writes_per_minute.reset()
    _rows_per_day.reset()


def charge_writes(user_id: int, rows: int = 1) -> None:
    """扣一次写请求 + `rows` 行配额，超了抛 429 且什么都不扣。"""
    for limiter, n, detail in (
        (_writes_per_minute, 1, "操作太频繁，请稍后再试"),
        (_rows_per_day, rows, "今天写入的记录太多了，明天再试"),
    ):
        if limiter.is_limited(user_id, n):
            raise HTTPException(
                status_code=429,
                detail=detail,
                headers={"Retry-After": str(limiter.retry_after(user_id, n))},
            )
    _writes_per_minute.add(user_id)
    _rows_per_day.add(user_id, rows)


def get_writing_user(user: CurrentUser) -> User:
    """新增一行的路由用它代替 CurrentUser：登录 + 扣一行配额。"""
    charge_writes(user.id)
    return user


WritingUser = Annotated[User, Depends(get_writing_user)]


# —— 客户端 IP（登录 / 注册限流用）——


def client_ip(request: Request) -> str:
    """限流用的客户端标识。

    优先取 nginx 设的 `X-Real-IP`（deploy/nginx.conf 里是 `$remote_addr`，
    nginx 会**覆盖**客户端自带的同名头）。信它是安全的，前提是后端端口
    只绑在 127.0.0.1（deploy/docker-compose.yml 的 `127.0.0.1:8001:8000`）——
    公网绕不过 nginx，就伪造不了这个头。本地开发直连 uvicorn 时它可以被伪造，
    那无所谓。

    没有这个头（测试 / 本地直连）就退回 `request.client.host`。

    IPv6 按 /64 归并：一个家庭宽带通常直接分到一整段 /64，逐地址计数的话
    攻击者每次换一个地址就能让「单 IP 上限」形同虚设。
    """
    raw = (request.headers.get("x-real-ip") or "").strip()
    if not raw and request.client is not None:
        raw = request.client.host
    if not raw:
        return "unknown"
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        # TestClient 的 host 是 "testclient"，不是合法 IP；原样用作键即可
        return raw
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    return str(ip)
