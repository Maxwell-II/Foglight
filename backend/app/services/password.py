"""密码哈希（Wave 3 §1.13）。

stdlib `hashlib.scrypt`，**零新依赖** —— 不许加 bcrypt / argon2-cffi / passlib，
`pyproject.toml` 是契约文件，本轮一个新依赖都不加（VPS 可用内存 698Mi，
容器上限 256m）。

存储格式（单一字符串存进 `users.password_hash`）::

    scrypt$16384$8$1$<salt_b64>$<hash_b64>

参数写进字符串本身，是为了将来能在**不清空用户表**的前提下升级参数：
verify 时按字符串里记的参数算，而不是按当前代码里的常量算。所以下面那四个
常量只影响**新**建的哈希，改它们不会让已存的哈希验不过。

⚠️ 分隔符是 `$`，而 base64 标准字母表（A-Za-z0-9+/=）里没有 `$`，
   所以 `split("$")` 永远是 6 段，不会被 salt 或 hash 的内容切错。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

# 参数写死（§1.13 逐字）。内存开销 128 * N * r = 16 MB/次，容器 256m 装得下。
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32

_SALT_BYTES = 16
_SCHEME = "scrypt"

# scrypt 要的内存是 128 * N * r，OpenSSL 默认 maxmem 是 32MB，16MB 刚好放得下。
# 显式写出来，免得将来有人调大 N 之后撞上一个"OpenSSL 内部报错"式的谜题。
_MAXMEM = 64 * 1024 * 1024


def _derive(password: str, salt: bytes, n: int, r: int, p: int, dklen: int) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=n,
        r=r,
        p=p,
        dklen=dklen,
        maxmem=_MAXMEM,
    )


def hash_password(password: str) -> str:
    """算一条新哈希。salt 每次独立（`secrets.token_bytes(16)`）。"""
    if not password:
        raise ValueError("password must not be empty")
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = _derive(password, salt, _SCRYPT_N, _SCRYPT_R, _SCRYPT_P, _SCRYPT_DKLEN)
    return "$".join(
        [
            _SCHEME,
            str(_SCRYPT_N),
            str(_SCRYPT_R),
            str(_SCRYPT_P),
            base64.b64encode(salt).decode("ascii"),
            base64.b64encode(digest).decode("ascii"),
        ]
    )


def verify_password(password: str, stored: str | None) -> bool:
    """比对密码。

    ⚠️ 比对必须走 `hmac.compare_digest`，**不许用 `==`** —— `==` 在第一个不同
       的字节就返回，比对耗时会泄漏"前几位对了"，这是标准的时序侧信道。

    stored 为 None / 空 / 格式不对 / 参数不是数字 → 一律 False，不抛异常：
    id=1 那个用户在建号之前 password_hash 就是 NULL，登录接口不该因此 500。
    """
    if not password or not stored:
        return False

    parts = stored.split("$")
    if len(parts) != 6:
        return False

    scheme, n_raw, r_raw, p_raw, salt_b64, hash_b64 = parts
    if scheme != _SCHEME:
        return False

    try:
        n, r, p = int(n_raw), int(r_raw), int(p_raw)
        salt = base64.b64decode(salt_b64, validate=True)
        expected = base64.b64decode(hash_b64, validate=True)
    except (ValueError, TypeError):
        return False

    if n <= 1 or n & (n - 1) or r < 1 or p < 1 or not salt or not expected:
        # n 必须是 >1 的 2 的幂，否则 hashlib.scrypt 直接抛 ValueError
        return False

    try:
        actual = _derive(password, salt, n, r, p, len(expected))
    except ValueError:
        # 参数超出 maxmem 之类：当作验不过，不要把 500 抛给登录接口
        return False

    return hmac.compare_digest(actual, expected)
