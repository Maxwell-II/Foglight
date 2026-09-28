"""发验证码邮件（注册 / 找回密码，2026-09-28）。

服务商是 Resend：一个 HTTPS 请求，用已有的 httpx，零新依赖（不装 `resend` 包）。
换服务商只动这个文件和几个环境变量 —— 路由只认 `send_code()` 和两个异常。

三种模式见 config.Settings.mail_mode：

- resend：真发
- console：本地没配 key，验证码打进日志，开发时照样能走完注册
- off：线上没配 key，抛 MailUnavailable，路由转成 503「暂不可用」
  ⚠️ 线上绝不能落到 console —— docker 日志谁都能 `docker logs` 看，
     里面的验证码能直接拿去重置别人的密码。

邮件故意只有纯文字 + 最简单的 HTML，没有链接、没有图片：新域名没有发信信誉，
QQ / Gmail 对带链接的陌生来信更狠（2026-09-28 实测，两家都进了垃圾箱）。
"""

from __future__ import annotations

import logging

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

RESEND_ENDPOINT = "https://api.resend.com/emails"
_TIMEOUT_SECONDS = 10.0

PURPOSE_REGISTER = "register"
PURPOSE_RESET = "reset"

_SUBJECTS = {
    PURPOSE_REGISTER: "Foglight 注册验证码：{code}",
    PURPOSE_RESET: "Foglight 重置密码验证码：{code}",
}
_ACTIONS = {
    PURPOSE_REGISTER: "注册 Foglight",
    PURPOSE_RESET: "重置 Foglight 的密码",
}


class MailUnavailable(Exception):
    """线上没配发信（mail_mode == "off"）。"""


class MailError(Exception):
    """服务商拒收或连不上。"""


def _bodies(code: str, purpose: str, ttl_minutes: int) -> tuple[str, str]:
    action = _ACTIONS[purpose]
    text = (
        f"你正在{action}，验证码是 {code}，{ttl_minutes} 分钟内有效。\n\n"
        "如果不是你本人操作，忽略这封邮件即可。\n\n— Foglight"
    )
    html = (
        f"<p>你正在{action}，验证码是 "
        f'<strong style="font-size:20px;letter-spacing:2px">{code}</strong>，'
        f"{ttl_minutes} 分钟内有效。</p>"
        "<p>如果不是你本人操作，忽略这封邮件即可。</p><p>— Foglight</p>"
    )
    return text, html


def send_code(to: str, code: str, purpose: str, ttl_minutes: int) -> None:
    mode = settings.mail_mode
    if mode == "off":
        raise MailUnavailable
    if mode == "console":
        logger.warning("[mail:console] %s code for %s: %s", purpose, to, code)
        return

    text, html = _bodies(code, purpose, ttl_minutes)
    try:
        resp = httpx.post(
            RESEND_ENDPOINT,
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json={
                "from": settings.mail_from,
                "to": [to],
                "subject": _SUBJECTS[purpose].format(code=code),
                "text": text,
                "html": html,
            },
            timeout=_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        raise MailError(f"resend unreachable: {exc.__class__.__name__}") from exc
    if resp.status_code >= 300:
        # 响应体里是 Resend 的错误说明（key 无效 / 域名未验证 / 超额），不含验证码
        logger.error("resend rejected (%s): %s", resp.status_code, resp.text[:300])
        raise MailError(f"resend returned {resp.status_code}")
