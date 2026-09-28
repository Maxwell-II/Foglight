"""认证路由（Wave 3 A1）。

main.py 统一以 prefix="/api" 挂载这个 router，所以下面的路径都写全名 `/auth/...`。

请求 / 响应模型直接定义在本文件里，**不写进 schemas.py**：schemas.py 是文章和书的
数据形状，认证的模型放在一起，改登录不会碰到阅读那一侧的文件。

⚠️ 登录失败返回 **200 + {ok: false}**，不是 401（§A1）。
   401 的语义是"你没权限访问这个资源"，而 /auth/login 本来就该让未登录的人
   访问；更实际的原因是前端给 401 装了全局拦截器（跳登录页），登录失败再触发
   一次跳登录页会绕进循环。

真正的防护是**失败锁定**，不是验证码（§6）。验证码只在连续失败 3 次之后才
出现 —— 本人正常登录永远见不到它。

2026-09-24 起锁定改成两个维度（public-release.md §3④）：

- **(email, IP) 这一对**：3 次要验证码、8 次锁 15 分钟。原来按账号锁，
  多用户下那等于「任何人对着你的邮箱连错 8 次就能把你锁住，可无限续」。
  现在攻击者只锁得住他自己那个 IP 上的尝试，受害者从自己的 IP 照常登录。
- **单个 IP 的全局上限**：跨所有账号，15 分钟 30 次失败 → 429。
  上一条单独用会放过「一个 IP 对着一万个邮箱各试 7 次」的撞库。

2026-09-26 补了两处：

- **注册必须过验证码**。原来只有「单 IP 每小时 5 次」，换代理就能绕开，
  脚本注册的成本是零；现在每注册一个号要人认一张图。
- **取验证码按 IP 限流**。/auth/captcha 不用登录、每打一次写一行库，
  原来是全站唯一一个任何人都能无限写库的入口。

2026-09-28 起注册和找回密码都走邮件验证码（推翻了 09-17 的「v1 不做自助重置」）：

- 注册两步：/auth/register-code 发码（要图形验证码）→ /auth/register 凭码建号。
  没通过邮件验证就不建账号，库里不会有未验证的账号。
- 找回两步：/auth/reset-code → /auth/reset。发码接口对「邮箱存不存在」回一样的话，
  信放到后台任务里发，免得靠响应快慢分辨出哪个邮箱注册过。
- 发码比登录限得更严：发一封信要花服务商额度、伤发信信誉，还能被拿去轰炸别人
  的邮箱。阈值见下面 CODE_*。

计数在进程内存里，理由和前提见 app/services/ratelimit.py 顶部。
"""

from __future__ import annotations

import hmac
import re
import secrets
from typing import Annotated
from urllib.parse import quote, unquote

import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel
from sqlalchemy.exc import IntegrityError

from app.config import settings
from app.deps import (
    SESSION_COOKIE_NAME,
    CurrentUser,
    DbSession,
    clear_session_cookie,
    client_ip,
    issue_session,
    purge_expired_sessions,
    revoke_session,
    set_session_cookie,
)
from app.models import AuthSession, User
from app.services import google_oauth, mailer
from app.services.captcha import consume_challenge, issue_challenge, purge_expired
from app.services.email_codes import CODE_TTL_MINUTES, consume_code, issue_code
from app.services.password import hash_password, verify_password
from app.services.ratelimit import LoginFailureTracker, SlidingWindowLimiter

logger = logging.getLogger(__name__)

router = APIRouter(tags=["auth"])

# —— 限流阈值 ——
# (email, IP) 这一对：阈值沿用 Wave 3 §A1 的数，只是键从账号换成了账号 × IP
CAPTCHA_AFTER_FAILURES = 3
LOCK_AFTER_FAILURES = 8
LOCK_MINUTES = 15
# 单个 IP 跨所有账号的失败上限。30 次足够一个人在几个账号之间记混密码，
# 又远低于撞库需要的量级
IP_FAILURE_LIMIT = 30
IP_FAILURE_WINDOW_SECONDS = 15 * 60
# 取验证码：单 IP 10 分钟 30 张。本人登录连错、注册认错图、手动换图，
# 十分钟里也用不到十张
CAPTCHA_LIMIT = 30
CAPTCHA_WINDOW_SECONDS = 10 * 60
# 发邮件验证码（注册和找回共用）。每封都要先过图形验证码，另外：
# 同一邮箱 60 秒 1 封、一天 5 封 —— 挡的是拿我们去轰炸别人的邮箱；
CODE_EMAIL_COOLDOWN_SECONDS = 60
CODE_EMAIL_DAILY_LIMIT = 5
# 同一 IP 一小时 10 封；
CODE_IP_LIMIT = 10
CODE_IP_WINDOW_SECONDS = 60 * 60
# 全站一天 80 封：Resend 免费档是每天 100、每月 3000，超了会被停号。
# ⚠️ 计数在内存里，重启进程会清零 —— 所以留了 20 封的余量，别把它调到 100。
CODE_GLOBAL_DAILY_LIMIT = 80
_DAY_SECONDS = 24 * 60 * 60

login_failures = LoginFailureTracker(
    captcha_after=CAPTCHA_AFTER_FAILURES,
    lock_after=LOCK_AFTER_FAILURES,
    lock_seconds=LOCK_MINUTES * 60,
)
login_ip_failures = SlidingWindowLimiter(IP_FAILURE_LIMIT, IP_FAILURE_WINDOW_SECONDS)
captcha_requests = SlidingWindowLimiter(CAPTCHA_LIMIT, CAPTCHA_WINDOW_SECONDS)
code_email_cooldown = SlidingWindowLimiter(1, CODE_EMAIL_COOLDOWN_SECONDS)
code_email_daily = SlidingWindowLimiter(CODE_EMAIL_DAILY_LIMIT, _DAY_SECONDS)
code_ip_hourly = SlidingWindowLimiter(CODE_IP_LIMIT, CODE_IP_WINDOW_SECONDS)
code_global_daily = SlidingWindowLimiter(CODE_GLOBAL_DAILY_LIMIT, _DAY_SECONDS)
_GLOBAL = "global"


def reset_rate_limits() -> None:
    """清空全部内存计数。给测试用；线上等价于重启进程。"""
    login_failures.reset()
    login_ip_failures.reset()
    captcha_requests.reset()
    code_email_cooldown.reset()
    code_email_daily.reset()
    code_ip_hourly.reset()
    code_global_daily.reset()


def _too_many(detail: str, limiter: SlidingWindowLimiter, key: str) -> HTTPException:
    return HTTPException(
        status_code=429,
        detail=detail,
        headers={"Retry-After": str(limiter.retry_after(key))},
    )

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

    和 schemas.ApiModel 的配置一致，但**故意不 import 它** —— 认证不依赖
    阅读那一侧的模块，两边可以各自改动。
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
    #: 能不能看到导入入口。公开版默认 false，只有 owner 是 true（§3⑥）
    can_import: bool = False


def _me(user: User) -> MeOut:
    return MeOut(id=user.id, email=user.email or "", can_import=bool(user.can_import))


class ProvidersOut(_AuthModel):
    #: 两个 Google 环境变量都配了才是 true；前端据此决定显不显示 Google 按钮
    google: bool


# 基本格式校验：有且只有一个 @，两边非空，域名里有点，全程没有空白。
# 不追求 RFC 5322 —— 真正的校验是「能收到信」，那由邮件验证码负责。
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class _EmailIn(_AuthModel):
    email: str = Field(max_length=320)

    @field_validator("email")
    @classmethod
    def _normalize_email(cls, value: str) -> str:
        # 先 trim 再转小写，和 /auth/login 的口径一致 —— 注册存进去的和登录查的
        # 不是同一个写法，就会出现「注册成功但登不进去」。发码和凭码两步也必须
        # 同一个口径，否则码存在 A@x.com 名下、校验时查的是 a@x.com。
        value = value.strip().lower()
        if not _EMAIL_RE.match(value):
            raise ValueError("邮箱格式不对")
        return value


class SendCodeIn(_EmailIn):
    # 每发一封都要过图形验证码
    captcha_id: str = Field(max_length=64)
    captcha_answer: str = Field(max_length=16)


class SendCodeOut(_AuthModel):
    #: 多少秒后才能再发。前端据此给「重新发送」按钮倒计时
    cooldown_seconds: int


class RegisterIn(_EmailIn):
    code: str = Field(max_length=16)
    password: str = Field(min_length=8, max_length=1024)


class ResetIn(_EmailIn):
    code: str = Field(max_length=16)
    new_password: str = Field(min_length=8, max_length=1024)


class CaptchaOut(_AuthModel):
    id: str
    #: 内联 SVG 字符串，前端用 dangerouslySetInnerHTML 渲染
    svg: str


@router.post("/auth/login", response_model=LoginOut)
def login(payload: LoginIn, request: Request, response: Response, db: DbSession) -> LoginOut:
    ip = client_ip(request)

    # —— 单 IP 全局上限：跨所有账号，超了连密码都不看 ——
    # 放在最前面：被挡下的请求不碰 scrypt、不碰数据库，撞库打不出 CPU 开销
    if login_ip_failures.is_limited(ip):
        raise _too_many("尝试次数过多，请稍后再试", login_ip_failures, ip)

    purge_expired(db)  # 顺手清过期验证码，不为它加定时任务

    email = payload.email.strip().lower()
    key = (email, ip)

    # —— 锁定中：连正确密码也拒绝，且不去碰 scrypt ——
    locked = login_failures.locked_for(key)
    if locked > 0:
        return LoginOut(
            ok=False, needs_captcha=login_failures.needs_captcha(key), locked_for_seconds=locked
        )

    # —— 达到阈值后必须先过验证码 ——
    # 验证码答错**不计入失败次数**：计入的话，本人认错一张图就离锁定更近一步，
    # 而攻击者反正也没法靠它试密码，代价全落在他自己身上。
    if login_failures.needs_captcha(key):
        if not consume_challenge(db, payload.captcha_id, payload.captcha_answer):
            return LoginOut(ok=False, needs_captcha=True, locked_for_seconds=0)

    user = db.query(User).filter(User.email == email).one_or_none() if email else None

    if user is None or not user.password_hash:
        _burn_time()
        ok = False
    else:
        ok = verify_password(payload.password, user.password_hash)

    if not ok:
        # 不存在的邮箱也照样计数：旧实现只给真账号计数，于是「连错 3 次后要不要
        # 验证码」本身就能告诉攻击者这个邮箱是不是真的
        login_failures.record_failure(key)
        login_ip_failures.add(ip)
        return LoginOut(
            ok=False,
            needs_captcha=login_failures.needs_captcha(key),
            locked_for_seconds=login_failures.locked_for(key),
        )

    # —— 成功 ——
    # 只清这一对。单 IP 的失败计数不清：否则攻击者拿自己注册的号登一次就能把
    # 全局上限归零，然后接着撞别人的库
    login_failures.clear(key)
    purge_expired_sessions(db)
    token, _expires_at = issue_session(db, user)
    set_session_cookie(response, token)
    return LoginOut(ok=True, needs_captcha=False, locked_for_seconds=0)


MAIL_UNAVAILABLE_DETAIL = "邮件验证码暂不可用"
WRONG_CODE_DETAIL = "邮件验证码不对或已过期"
WRONG_CAPTCHA_DETAIL = "验证码不对，请换一张再试"


def _gate_send(db: DbSession, payload: SendCodeIn, ip: str) -> None:
    """两个发码接口共用的关卡。顺序有讲究：

    1. 没配发信 → 503，先于一切，免得人认完图才被告知不可用
    2. 单 IP 上限 → 429，不碰数据库
    3. 图形验证码 → 400。答错不占任何发信名额：图已经作废，再试要再取一张
    4. 单邮箱冷却 / 单邮箱每日 / 全站每日 → 429

    通过之后才记 IP 这一次；邮箱和全站的名额由调用方在**真发**的时候记。
    """
    if settings.mail_mode == "off":
        raise HTTPException(status_code=503, detail=MAIL_UNAVAILABLE_DETAIL)
    if code_ip_hourly.is_limited(ip):
        raise _too_many("发送太频繁，请稍后再试", code_ip_hourly, ip)
    if not consume_challenge(db, payload.captcha_id, payload.captcha_answer):
        raise HTTPException(status_code=400, detail=WRONG_CAPTCHA_DETAIL)
    if code_email_cooldown.is_limited(payload.email):
        raise _too_many("刚发过，请稍等再重发", code_email_cooldown, payload.email)
    if code_email_daily.is_limited(payload.email):
        raise _too_many("这个邮箱今天收的验证码太多了，明天再试", code_email_daily, payload.email)
    if code_global_daily.is_limited(_GLOBAL):
        raise _too_many("今天的验证码发完了，请明天再试", code_global_daily, _GLOBAL)
    code_ip_hourly.add(ip)


def _charge_send(email: str) -> None:
    code_email_cooldown.add(email)
    code_email_daily.add(email)
    code_global_daily.add(_GLOBAL)


@router.post("/auth/register-code", response_model=SendCodeOut)
def send_register_code(payload: SendCodeIn, request: Request, db: DbSession) -> SendCodeOut:
    """注册第一步：往这个邮箱发 6 位验证码。

    已注册 → 409，并且照样占 IP 名额：否则「该邮箱已注册」就是不限次数的邮箱枚举接口。
    注册页本来就该告诉人「这个邮箱注册过了，去登录」，所以这里不装作不知道 ——
    装的是找回那一边。

    信同步发：发不出去要当场告诉人（502），不能让他对着空收件箱干等。
    """
    ip = client_ip(request)
    _gate_send(db, payload, ip)
    if db.query(User.id).filter(User.email == payload.email).first() is not None:
        raise HTTPException(status_code=409, detail="该邮箱已注册")

    code = issue_code(db, payload.email, mailer.PURPOSE_REGISTER)
    _charge_send(payload.email)
    try:
        mailer.send_code(payload.email, code, mailer.PURPOSE_REGISTER, CODE_TTL_MINUTES)
    except mailer.MailUnavailable:
        raise HTTPException(status_code=503, detail=MAIL_UNAVAILABLE_DETAIL) from None
    except mailer.MailError:
        logger.exception("register code mail failed")
        raise HTTPException(status_code=502, detail="邮件发送失败，请稍后再试") from None
    return SendCodeOut(cooldown_seconds=CODE_EMAIL_COOLDOWN_SECONDS)


@router.post("/auth/register", response_model=MeOut, status_code=201)
def register(payload: RegisterIn, response: Response, db: DbSession) -> MeOut:
    """注册第二步：邮件验证码 + 密码，建号并登录（写 cookie）。

    格式不对由 RegisterIn 抛 422。验证码不对 → 400；同一封信的码累计输错 5 次作废，
    暴力猜的上限由此而来，这一步不再单独按 IP 限流。
    """
    if not consume_code(db, payload.email, mailer.PURPOSE_REGISTER, payload.code):
        raise HTTPException(status_code=400, detail=WRONG_CODE_DETAIL)

    user = User(email=payload.email, password_hash=hash_password(payload.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        # 发码之后、凭码之前，这个邮箱被别的路注册了（比如同一个邮箱走了 Google）
        db.rollback()
        raise HTTPException(status_code=409, detail="该邮箱已注册") from None
    db.refresh(user)

    token, _expires_at = issue_session(db, user)
    set_session_cookie(response, token)
    return _me(user)


def _send_reset_mail(email: str, code: str) -> None:
    """后台任务：响应已经回去了，失败只能记日志。用户等 60 秒可以重发。"""
    try:
        mailer.send_code(email, code, mailer.PURPOSE_RESET, CODE_TTL_MINUTES)
    except (mailer.MailError, mailer.MailUnavailable):
        logger.exception("reset code mail failed")


@router.post("/auth/reset-code", response_model=SendCodeOut)
def send_reset_code(
    payload: SendCodeIn, request: Request, background: BackgroundTasks, db: DbSession
) -> SendCodeOut:
    """找回第一步。**不透露邮箱是否注册过**：

    - 存不存在都回同样的 200，前端统一说「如果这个邮箱注册过，验证码已发出」
    - 限流对两种邮箱一视同仁（冷却和每日上限都记），429 也不泄漏
    - 信在后台任务里发：同步发的话，存在的邮箱要多等一次 Resend 往返，
      掐表就能分辨出来

    唯一的例外是全站每日名额只在真发的时候扣 —— 它是替服务商额度记账的。
    用 Google 注册、没有密码的账号也能走这里：收得到信就证明邮箱是他的，
    设一个密码等于多一条登录方式。
    """
    ip = client_ip(request)
    _gate_send(db, payload, ip)
    code_email_cooldown.add(payload.email)
    code_email_daily.add(payload.email)

    if db.query(User.id).filter(User.email == payload.email).first() is not None:
        code_global_daily.add(_GLOBAL)
        code = issue_code(db, payload.email, mailer.PURPOSE_RESET)
        background.add_task(_send_reset_mail, payload.email, code)
    return SendCodeOut(cooldown_seconds=CODE_EMAIL_COOLDOWN_SECONDS)


@router.post("/auth/reset", response_model=MeOut)
def reset_password(payload: ResetIn, request: Request, response: Response, db: DbSession) -> MeOut:
    """找回第二步：验证码 + 新密码。改完**踢掉这个账号的所有登录**，当前设备重新登录。

    踢掉全部是找回密码的本意 —— 来找回的人往往是怀疑密码泄漏了，别处那个
    登录态可能就是别人的。
    """
    if not consume_code(db, payload.email, mailer.PURPOSE_RESET, payload.code):
        raise HTTPException(status_code=400, detail=WRONG_CODE_DETAIL)
    user = db.query(User).filter(User.email == payload.email).one_or_none()
    if user is None:
        # 发码之后账号被删了。和码不对回一样的话
        raise HTTPException(status_code=400, detail=WRONG_CODE_DETAIL)

    user.password_hash = hash_password(payload.new_password)
    db.query(AuthSession).filter(AuthSession.user_id == user.id).delete(synchronize_session=False)
    db.commit()
    # 本人在这个 IP 上连错过密码才来找回的：把这一对的失败计数清掉，别让他改完还被锁着
    login_failures.clear((payload.email, client_ip(request)))

    token, _expires_at = issue_session(db, user)
    set_session_cookie(response, token)
    return _me(user)


@router.get("/auth/providers", response_model=ProvidersOut)
def providers() -> ProvidersOut:
    return ProvidersOut(google=settings.google_enabled)


@router.post("/auth/logout", status_code=204)
def logout(request: Request, response: Response, db: DbSession) -> None:
    """删掉这条 auth_sessions 行 + 清 cookie。

    即使 cookie 已经无效也返回 204：退出登录不该失败，前端拿到 204 就跳登录页。
    """
    revoke_session(db, request.cookies.get(SESSION_COOKIE_NAME))
    clear_session_cookie(response)


@router.get("/auth/me", response_model=MeOut)
def me(user: CurrentUser) -> MeOut:
    """已登录 → {id, email, canImport}；否则由 get_current_user 抛 401 {"detail": "未登录"}。"""
    return _me(user)


@router.get("/auth/captcha", response_model=CaptchaOut)
def captcha(request: Request, db: DbSession) -> CaptchaOut:
    ip = client_ip(request)
    if captcha_requests.is_limited(ip):
        raise _too_many("验证码刷新太频繁，请稍后再试", captcha_requests, ip)
    captcha_requests.add(ip)
    challenge_id, svg = issue_challenge(db)
    return CaptchaOut(id=challenge_id, svg=svg)


# ---------- Google 一键登录（public-release.md §3b）----------
#
# 两条路由，拿到用户后直接调已有的 issue_session + set_session_cookie，登录态那套一字不改。
#
# CSRF：start 生成随机 state，一份放进 HttpOnly cookie、一份带去 Google；
# callback 两份必须相等（hmac.compare_digest）。攻击者可以骗你的浏览器访问
# 带着**他的** code 的 callback（把你登进他的账号，之后你的标记全记在他名下），
# 但他造不出你浏览器里那个 cookie 的值。
#
# cookie 用 SameSite=Lax 而不是 Strict：从 accounts.google.com 跳回来是跨站的
# 顶层 GET 导航，Strict 下浏览器不带 cookie，每一次都会判成 state 不匹配。

OAUTH_STATE_COOKIE = "foglight_oauth_state"
_OAUTH_COOKIE_PATH = "/api/auth/google"
_OAUTH_STATE_TTL_SECONDS = 10 * 60
DEFAULT_NEXT = "/library"
_LOGIN_ERROR_GOOGLE = "/login?error=google"
_LOGIN_ERROR_UNAVAILABLE = "/login?error=google_unavailable"


def safe_next(raw: str | None) -> str:
    """登录后跳去哪。只接受本站的相对路径，其余一律回落到 /library。

    `//evil.com` 是协议相对 URL，浏览器会跳出站外 —— 开放重定向的经典形态。
    反斜杠同理：浏览器把 `/\\evil.com` 当成 `//evil.com`。控制字符（含换行）
    一并拒绝，免得有人往 Location 头里塞东西。
    """
    if not raw or len(raw) > 2048:
        return DEFAULT_NEXT
    if not raw.startswith("/") or raw.startswith("//"):
        return DEFAULT_NEXT
    if "\\" in raw or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in raw):
        return DEFAULT_NEXT
    return raw


def _google_redirect_uri(request: Request) -> str:
    """回调地址。start 和 callback 必须算出同一个值，Google 换码时会逐字比对。

    配了 GOOGLE_REDIRECT_URI 就用它；否则按 nginx 转发的头推：
    `X-Forwarded-Proto`（deploy/nginx.conf 设成 $scheme）+ `Host`（$host）。
    线上结果是 https://read.rnuxay.xyz/api/auth/google/callback。

    不用 request.url 直接拼：容器里 uvicorn 收到的是 nginx 转来的 http 请求，
    request.url.scheme 永远是 http，拼出来 Google 会拒。
    """
    if settings.google_redirect_uri:
        return settings.google_redirect_uri
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme).split(",")[0].strip()
    host = request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}{_OAUTH_COOKIE_PATH}/callback"


def _clear_state_cookie(response: Response) -> None:
    response.delete_cookie(
        key=OAUTH_STATE_COOKIE,
        path=_OAUTH_COOKIE_PATH,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="lax",
    )


def _fail(url: str = _LOGIN_ERROR_GOOGLE) -> RedirectResponse:
    response = RedirectResponse(url, status_code=302)
    _clear_state_cookie(response)
    return response


@router.get("/auth/google/start")
def google_start(
    request: Request, next_: Annotated[str | None, Query(alias="next")] = None
) -> RedirectResponse:
    if not settings.google_enabled:
        return RedirectResponse(_LOGIN_ERROR_UNAVAILABLE, status_code=302)

    state = secrets.token_urlsafe(32)
    response = RedirectResponse(
        google_oauth.authorization_url(state=state, redirect_uri=_google_redirect_uri(request)),
        status_code=302,
    )
    # next 跟 state 一起放进 cookie，不带去 Google。token_urlsafe 的字母表里没有 "."，
    # 所以第一个 "." 就是分隔符；next 整体 percent-encode，里面的 "." 不会干扰。
    response.set_cookie(
        key=OAUTH_STATE_COOKIE,
        value=f"{state}.{quote(safe_next(next_), safe='')}",
        max_age=_OAUTH_STATE_TTL_SECONDS,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="lax",
        path=_OAUTH_COOKIE_PATH,
    )
    return response


def _resolve_google_user(db: DbSession, identity: google_oauth.GoogleIdentity) -> User | None:
    """按 §2 契约的顺序找人。返回 None 表示这次登录不能成立。

    1. google_sub 已绑定 → 就是他
    2. email 命中已有用户**且** Google 说邮箱已验证 → 把 sub 绑上去
       （没验证过的邮箱谁都能填，拿它认领已有账号 = 接管别人的号）
    3. 否则新建用户，password_hash 为 NULL
    """
    user = db.query(User).filter(User.google_sub == identity.sub).one_or_none()
    if user is not None:
        return user

    existing = (
        db.query(User).filter(User.email == identity.email).one_or_none()
        if identity.email
        else None
    )
    if existing is not None and identity.email_verified:
        if existing.google_sub is not None:
            # 这个邮箱的账号已经绑了**另一个** Google 账号（sub 不同）。
            # 不覆盖：覆盖等于让后来者把原绑定挤掉。宁可这次登录失败让人来问。
            return None
        existing.google_sub = identity.sub
        user = existing
    else:
        # 邮箱只在「已验证且没人占用」时才记下。未验证的邮箱不记：记了它就占住了
        # 唯一约束，真正拥有这个邮箱的人以后来注册会被告知「该邮箱已注册」。
        keep_email = identity.email if identity.email_verified and existing is None else None
        user = User(email=keep_email, password_hash=None, google_sub=identity.sub)
        db.add(user)

    try:
        db.commit()
    except IntegrityError:
        # 并发的两次回调抢同一个 sub / email。让这次失败，重试会走第 1 条
        db.rollback()
        return None
    db.refresh(user)
    return user


@router.get("/auth/google/callback")
def google_callback(
    request: Request,
    db: DbSession,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> RedirectResponse:
    # 用户在 Google 那边点了取消，会带着 ?error=access_denied 回来
    if error or not code or not state or not settings.google_enabled:
        return _fail()

    cookie = request.cookies.get(OAUTH_STATE_COOKIE) or ""
    expected_state, _sep, encoded_next = cookie.partition(".")
    if not expected_state or not hmac.compare_digest(
        expected_state.encode("utf-8"), state.encode("utf-8")
    ):
        return _fail()

    try:
        identity = google_oauth.exchange_code(code, redirect_uri=_google_redirect_uri(request))
    except google_oauth.GoogleAuthError:
        return _fail()

    user = _resolve_google_user(db, identity)
    if user is None:
        return _fail()

    purge_expired_sessions(db)
    token, _expires_at = issue_session(db, user)
    # cookie 里的 next 在 start 时校验过，这里再校验一遍：cookie 终究是客户端的东西
    response = RedirectResponse(safe_next(unquote(encoded_next)), status_code=302)
    _clear_state_cookie(response)
    set_session_cookie(response, token)
    return response
