"""邮件验证码的签发与校验（2026-09-28）。发信本身在 mailer.py，限流在路由里。

和 captcha.py 是同一个形状：一张表、短过期、用完即删。不同的是验证码输错
**不**立刻作废 —— 6 位数字是人从邮件里抄过来的，抄错一位就要重新收信太折磨人；
改成累计输错 MAX_ATTEMPTS 次才作废。暴力猜的上限因此是「每封信 5 次」，
而每封信都要过图形验证码 + 每邮箱每天 5 封的限额。
"""

from __future__ import annotations

import hmac
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models import EmailCode

CODE_LENGTH = 6
CODE_TTL_MINUTES = 10
MAX_ATTEMPTS = 5


# 不 import app.deps 的理由同 captcha.py：services 被 deps/routers 用，反过来会绕成环
def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def purge_expired(db: Session) -> None:
    """在发码接口里顺手调，不加定时任务 —— 这张表最多攒下几十行。不 commit，跟着调用方一起提交。"""
    db.query(EmailCode).filter(EmailCode.expires_at < datetime.now(timezone.utc)).delete(
        synchronize_session=False
    )


def issue_code(db: Session, email: str, purpose: str) -> str:
    """新建一条并返回验证码。同一 (email, purpose) 的旧码一并删掉 —— 重发之后旧信里的码失效。"""
    purge_expired(db)
    db.query(EmailCode).filter(EmailCode.email == email, EmailCode.purpose == purpose).delete(
        synchronize_session=False
    )
    # secrets 而不是 random：random 的状态可以从连续输出里推出来
    code = f"{secrets.randbelow(10**CODE_LENGTH):0{CODE_LENGTH}d}"
    db.add(
        EmailCode(
            email=email,
            purpose=purpose,
            code=code,
            attempts=0,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=CODE_TTL_MINUTES),
        )
    )
    db.commit()
    return code


def consume_code(db: Session, email: str, purpose: str, code: str | None) -> bool:
    """对了就删掉并返回 True（一次性）；错了记一次，满 MAX_ATTEMPTS 次删掉。"""
    # 取最新一条而不是 one_or_none：两次发码请求并发时 issue_code 的「先删后插」
    # 可能各插一条，one_or_none 会直接抛异常把接口打成 500
    row = (
        db.query(EmailCode)
        .filter(EmailCode.email == email, EmailCode.purpose == purpose)
        .order_by(EmailCode.id.desc())
        .first()
    )
    if row is None:
        return False
    if _as_utc(row.expires_at) <= datetime.now(timezone.utc):
        db.delete(row)
        db.commit()
        return False

    given = (code or "").strip()
    if given and hmac.compare_digest(given.encode("utf-8"), row.code.encode("utf-8")):
        db.delete(row)
        db.commit()
        return True

    row.attempts += 1
    if row.attempts >= MAX_ATTEMPTS:
        db.delete(row)
    db.commit()
    return False
