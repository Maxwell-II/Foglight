"""Google 一键登录的两件事：拼授权跳转地址、拿 code 换 id_token 并读出身份。

零新依赖（public-release.md §3b）：换 token 用已有的 httpx；id_token **不做本地验签**。

为什么可以不验签：id_token 是我们的服务端**自己**通过 TLS 直连
`oauth2.googleapis.com/token`、拿 client_secret 换回来的，中间没有经过浏览器。
能伪造它的人得先能冒充 Google 的 TLS 证书 —— 那种对手面前验签也救不了。
OpenID Connect Core §3.1.3.7 对这种情况也写明了「可以用 TLS 服务端校验代替签名校验」。
（反过来：如果哪天 id_token 改成从前端传进来，就**必须**验签，这条推理不再成立。）

但 `aud` 和 `email_verified` 仍然要看：
- `aud` 不对说明这个 token 不是发给我们这个 client 的（配置错了或串了项目）
- `email_verified` 决定能不能凭这个邮箱去认领一个已有账号 —— 没验证过的邮箱
  谁都能填，拿它去绑已有账号就是接管别人的号
"""

from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

from app.config import settings

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
# 只要这三个非敏感 scope：Google 对它们不走应用验证流程，可以直接发布到生产（§3b）
SCOPES = "openid email profile"
_VALID_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}
_TIMEOUT_SECONDS = 10.0


class GoogleAuthError(Exception):
    """换 token 或读 id_token 的任何一步失败。路由统一把它转成 /login?error=google。"""


@dataclass
class GoogleIdentity:
    sub: str
    email: str | None
    email_verified: bool


def authorization_url(*, state: str, redirect_uri: str) -> str:
    query = urlencode(
        {
            "client_id": settings.google_client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": SCOPES,
            "state": state,
            # 已登录多个 Google 账号的人每次都能选；不加的话会静默用上次那个，
            # 选错了账号他只会看到「怎么是个空账号」
            "prompt": "select_account",
        }
    )
    return f"{AUTH_ENDPOINT}?{query}"


def _decode_segment(segment: str) -> dict:
    padded = segment + "=" * (-len(segment) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except (ValueError, UnicodeError) as exc:
        raise GoogleAuthError("id_token 解码失败") from exc
    if not isinstance(payload, dict):
        raise GoogleAuthError("id_token 载荷不是对象")
    return payload


def _claims_from_id_token(id_token: str) -> dict:
    parts = id_token.split(".")
    if len(parts) != 3:
        raise GoogleAuthError("id_token 不是 JWT")
    return _decode_segment(parts[1])


def _is_true(value: object) -> bool:
    # 规范里是布尔值，但早年的 Google 端点返回过字符串 "true"。两种都认，别的一律不认。
    return value is True or value == "true"


def exchange_code(code: str, *, redirect_uri: str) -> GoogleIdentity:
    """code → token 端点 → id_token → 身份。任何一步不对都抛 GoogleAuthError。

    redirect_uri 必须和发起授权时的**完全一致**，否则 Google 拒绝换码。
    """
    try:
        resp = httpx.post(
            TOKEN_ENDPOINT,
            data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
            headers={"Accept": "application/json"},
            timeout=_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        raise GoogleAuthError("连不上 Google token 端点") from exc

    if resp.status_code != 200:
        raise GoogleAuthError(f"token 端点返回 {resp.status_code}")
    try:
        body = resp.json()
    except ValueError as exc:
        raise GoogleAuthError("token 端点返回的不是 JSON") from exc
    id_token = body.get("id_token") if isinstance(body, dict) else None
    if not isinstance(id_token, str):
        raise GoogleAuthError("token 端点没给 id_token")

    claims = _claims_from_id_token(id_token)

    aud = claims.get("aud")
    audiences = aud if isinstance(aud, list) else [aud]
    if settings.google_client_id not in audiences:
        raise GoogleAuthError("id_token 的 aud 不是本应用")
    if claims.get("iss") not in _VALID_ISSUERS:
        raise GoogleAuthError("id_token 的 iss 不是 Google")
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or exp < time.time():
        raise GoogleAuthError("id_token 已过期")

    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        raise GoogleAuthError("id_token 没有 sub")

    raw_email = claims.get("email")
    email = raw_email.strip().lower() if isinstance(raw_email, str) and raw_email.strip() else None
    return GoogleIdentity(sub=sub, email=email, email_verified=_is_true(claims.get("email_verified")))
