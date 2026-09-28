"""验证码（Wave 3 §A1 / §6）。零依赖，自绘 SVG 矢量描边字模。

⚠️ 这里最重要的一条，也是整个 A1 包唯一一个"做错了就完全没有意义"的点：

    **绝对不许用 `<text>` 标签渲染答案。**

    SVG 是文本格式。`<text>ABCD</text>` 里的答案在源码里明文可见，
    `curl | grep` 一行就拿到了 —— 那等于把答案直接送给脚本，验证码
    形同虚设，而人眼看上去一切正常（图片是花的），所以做错了不会被发现。

    正确做法：每个字符用一组 `<path>` **线段**画出来，答案只以「几何形状」
    的方式存在于输出里。下面的 `_GLYPHS` 就是手写的折线字模。
    `tests/test_auth.py::test_captcha_svg_never_contains_the_answer` 锁着这条。

定位说明（§6）：这是**学习项，不是安全项**。单用户、不开放注册、跑在 HTTPS
后面，真实攻击面只有"有人猜密码"，挡住它的是强密码 + 失败锁定，不是验证码。
所以它只在连续失败 3 次之后才出现 —— 让本人天天付出成本、让攻击者几乎不付
出成本，是常见的设计错误。
"""

from __future__ import annotations

import math
import random
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models import CaptchaChallenge

# 去掉 0/O/1/I/l —— 它们在任何字形下都难分，只会让本人认不出自己的验证码
ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

CAPTCHA_LENGTH = 4
CAPTCHA_TTL_SECONDS = 300  # 5 分钟

# —— 画布尺寸 ——
_CELL_W = 38
_PAD_X = 12
_HEIGHT = 60
_WIDTH = _PAD_X * 2 + _CELL_W * CAPTCHA_LENGTH

# 字模坐标系：x ∈ [0, 10]，y ∈ [0, 14]（y 向下）。中心 (5, 7)。
_GLYPH_W = 10
_GLYPH_H = 14
_GLYPH_CX = _GLYPH_W / 2
_GLYPH_CY = _GLYPH_H / 2

# 每个字符 → 若干条折线 → 若干个点。手写，约 100 行，零依赖。
_GLYPHS: dict[str, list[list[tuple[int, int]]]] = {
    "2": [[(0, 3), (2, 0), (6, 0), (9, 3), (7, 7), (0, 14), (9, 14)]],
    "3": [[(0, 1), (5, 0), (9, 3), (5, 7), (2, 7)], [(5, 7), (9, 10), (5, 14), (0, 12)]],
    "4": [[(7, 0), (0, 10), (9, 10)], [(7, 0), (7, 14)]],
    "5": [[(9, 0), (1, 0), (0, 6), (4, 5), (8, 7), (8, 11), (4, 14), (0, 12)]],
    "6": [[(8, 0), (3, 2), (0, 8), (1, 13), (5, 14), (9, 11), (7, 7), (2, 7), (0, 9)]],
    "7": [[(0, 0), (9, 0), (3, 14)]],
    "8": [
        [(5, 0), (1, 2), (2, 6), (5, 7), (8, 6), (9, 2), (5, 0)],
        [(5, 7), (1, 9), (1, 13), (5, 14), (9, 13), (9, 9), (5, 7)],
    ],
    "9": [[(2, 14), (7, 12), (9, 6), (8, 1), (3, 0), (0, 3), (2, 7), (7, 7), (9, 5)]],
    "A": [[(0, 14), (5, 0), (10, 14)], [(2, 9), (8, 9)]],
    "B": [
        [(0, 0), (0, 14)],
        [(0, 0), (6, 0), (9, 3), (6, 7), (0, 7)],
        [(6, 7), (9, 10), (6, 14), (0, 14)],
    ],
    "C": [[(9, 2), (5, 0), (1, 4), (1, 10), (5, 14), (9, 12)]],
    "D": [[(0, 0), (0, 14)], [(0, 0), (5, 0), (9, 5), (9, 9), (5, 14), (0, 14)]],
    "E": [[(9, 0), (0, 0), (0, 14), (9, 14)], [(0, 7), (6, 7)]],
    "F": [[(9, 0), (0, 0), (0, 14)], [(0, 7), (6, 7)]],
    "G": [[(9, 2), (5, 0), (1, 4), (1, 10), (5, 14), (9, 11), (9, 8), (5, 8)]],
    "H": [[(0, 0), (0, 14)], [(9, 0), (9, 14)], [(0, 7), (9, 7)]],
    "J": [[(8, 0), (8, 10), (5, 14), (1, 12)]],
    "K": [[(0, 0), (0, 14)], [(9, 0), (0, 8)], [(3, 5), (9, 14)]],
    "L": [[(0, 0), (0, 14), (9, 14)]],
    "M": [[(0, 14), (0, 0), (5, 7), (10, 0), (10, 14)]],
    "N": [[(0, 14), (0, 0), (9, 14), (9, 0)]],
    "P": [[(0, 14), (0, 0), (6, 0), (9, 3), (6, 7), (0, 7)]],
    "Q": [[(5, 0), (1, 3), (1, 11), (5, 14), (9, 11), (9, 3), (5, 0)], [(6, 10), (10, 14)]],
    "R": [[(0, 14), (0, 0), (6, 0), (9, 3), (6, 7), (0, 7)], [(5, 7), (9, 14)]],
    "S": [[(9, 2), (5, 0), (1, 2), (1, 5), (8, 9), (8, 12), (4, 14), (0, 12)]],
    "T": [[(0, 0), (10, 0)], [(5, 0), (5, 14)]],
    "U": [[(0, 0), (0, 10), (4, 14), (8, 10), (8, 0)]],
    "V": [[(0, 0), (5, 14), (10, 0)]],
    "W": [[(0, 0), (2, 14), (5, 5), (8, 14), (10, 0)]],
    "X": [[(0, 0), (9, 14)], [(9, 0), (0, 14)]],
    "Y": [[(0, 0), (5, 7), (10, 0)], [(5, 7), (5, 14)]],
    "Z": [[(0, 0), (9, 0), (0, 14), (9, 14)]],
}

# 字模表和字母表必须逐字对上：少一个字符会在生成时 KeyError，
# 而那要等到某次随机抽中它才发作 —— 那种 bug 只在线上出现。
assert set(_GLYPHS) == set(ALPHABET), "glyph table and ALPHABET disagree"

# 背景固定浅色 + 笔画固定深色：SVG 内联在页面里，跟随主题会让深色模式下
# 描边和背景撞在一起变成一团黑，那时候用户会以为是接口坏了。
#
# ⚠️ 这几个色值刻意挑成「任意 4 个连续字符里必定有一个字母表之外的字符」
#    （小写十六进制字母 a-f 和数字 0/1 都不在 ALPHABET 里）。
#    这样整份 SVG 里就不存在任何一段长度 ≥4 的「全是字母表字符」的连续片段，
#    也就从结构上保证了**任何**一个 4 位答案都不可能在输出里出现 ——
#    比"这次这个答案没出现"强得多。
#    test_captcha_svg_structurally_cannot_contain_any_answer 钉着这条；
#    换色值时把它跑一遍，别挑出 "#8a8577" 这种（里面藏着 "8577"）。
_BG = "#f2efe6"
_INK_SHADES = ("#1f293d", "#33404d", "#243b53", "#3a2f2a")
_NOISE = "#8a857a"


def _fmt(value: float) -> str:
    return f"{value:.1f}".rstrip("0").rstrip(".")


def _path_d(points: list[tuple[float, float]]) -> str:
    head = points[0]
    rest = " ".join(f"{_fmt(x)} {_fmt(y)}" for x, y in points[1:])
    return f"M {_fmt(head[0])} {_fmt(head[1])} L {rest}"


def _place(
    stroke: list[tuple[int, int]],
    cx: float,
    cy: float,
    scale: float,
    angle_deg: float,
    slant: float,
) -> list[tuple[float, float]]:
    """把字模坐标变换到画布坐标：缩放 + 斜切 + 旋转 + 平移。

    变换在 Python 里算完，输出只剩下裸的 `<path d="...">` —— 不用 SVG 的
    `transform` 属性，是为了让输出里除了坐标数字之外没有别的东西。
    """
    rad = math.radians(angle_deg)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    placed: list[tuple[float, float]] = []
    for x, y in stroke:
        dx = (x - _GLYPH_CX) * scale
        dy = (y - _GLYPH_CY) * scale
        dx += dy * slant  # 斜切：让同一个字模每次的骨架都不一样
        placed.append((cx + dx * cos_a - dy * sin_a, cy + dx * sin_a + dy * cos_a))
    return placed


def render_svg(answer: str, rng: random.Random | None = None) -> str:
    """把答案画成 SVG。**只用 `<path>`，绝不用 `<text>`**（见模块开头）。

    rng 可注入，方便测试复现；默认用 `secrets.SystemRandom()`。
    """
    rnd = rng or secrets.SystemRandom()
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{_WIDTH}" height="{_HEIGHT}" '
        f'viewBox="0 0 {_WIDTH} {_HEIGHT}" role="img">',
        f'<rect width="{_WIDTH}" height="{_HEIGHT}" rx="6" fill="{_BG}"/>',
    ]

    # 干扰线：压在字符下面，让"连通域切分"这类朴素分割变难
    for _ in range(4):
        pts = [
            (rnd.uniform(0, _WIDTH), rnd.uniform(0, _HEIGHT)),
            (rnd.uniform(0, _WIDTH), rnd.uniform(0, _HEIGHT)),
            (rnd.uniform(0, _WIDTH), rnd.uniform(0, _HEIGHT)),
        ]
        parts.append(
            f'<path d="{_path_d(pts)}" fill="none" stroke="{_NOISE}" '
            f'stroke-width="{_fmt(rnd.uniform(0.8, 1.6))}" opacity="0.55"/>'
        )

    for index, char in enumerate(answer.upper()):
        strokes = _GLYPHS[char]
        cx = _PAD_X + _CELL_W * index + _CELL_W / 2 + rnd.uniform(-3, 3)
        cy = _HEIGHT / 2 + rnd.uniform(-3, 3)
        scale = rnd.uniform(2.0, 2.5)
        angle = rnd.uniform(-24, 24)
        slant = rnd.uniform(-0.28, 0.28)
        color = rnd.choice(_INK_SHADES)
        width = _fmt(rnd.uniform(2.1, 3.0))
        for stroke in strokes:
            placed = _place(stroke, cx, cy, scale, angle, slant)
            parts.append(
                f'<path d="{_path_d(placed)}" fill="none" stroke="{color}" '
                f'stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>'
            )

    # 噪点：压在字符上面
    for _ in range(45):
        parts.append(
            f'<circle cx="{_fmt(rnd.uniform(0, _WIDTH))}" cy="{_fmt(rnd.uniform(0, _HEIGHT))}" '
            f'r="{_fmt(rnd.uniform(0.4, 1.3))}" fill="{_NOISE}" opacity="0.5"/>'
        )

    parts.append("</svg>")
    return "".join(parts)


def new_answer(rng: random.Random | None = None) -> str:
    rnd = rng or secrets.SystemRandom()
    return "".join(rnd.choice(ALPHABET) for _ in range(CAPTCHA_LENGTH))


# —— 这里不 import app.deps：services 是被 deps/routers 用的一层，反过来
#    依赖会绕成环。三行的时区兜底宁可写两遍。 ——
def _as_utc(value: datetime) -> datetime:
    """SQLite 的 DATETIME 不存时区，读回来是 naive 的。库里存的一律是 UTC。"""
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def purge_expired(db: Session) -> int:
    """删掉过期的挑战。

    在登录 / 取验证码的接口里顺手调一下就够了，**不要为它加定时任务** ——
    这张表最多也就攒下几十行。
    """
    now = datetime.now(timezone.utc)
    deleted = (
        db.query(CaptchaChallenge)
        .filter(CaptchaChallenge.expires_at < now)
        .delete(synchronize_session=False)
    )
    return int(deleted)


def issue_challenge(db: Session) -> tuple[str, str]:
    """建一条挑战并返回 (id, svg)。答案以**明文小写**入库。

    明文是刻意的（§2.1）：它 5 分钟过期、一次性作废，泄漏它的价值等于零。
    哈希它只会让代码看起来更"安全"而不增加任何实际防护 —— 这种装饰性加密
    会让人误以为整套东西比实际更结实。
    """
    purge_expired(db)
    answer = new_answer()
    challenge = CaptchaChallenge(
        id=secrets.token_urlsafe(16),
        answer=answer.lower(),
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=CAPTCHA_TTL_SECONDS),
        used=False,
    )
    db.add(challenge)
    db.commit()
    return challenge.id, render_svg(answer)


def consume_challenge(db: Session, challenge_id: str | None, answer: str | None) -> bool:
    """校验并**一次性作废**。大小写不敏感。

    ⚠️ 作废发生在"答案对不对"之前：答错也把它烧掉，否则同一张图可以无限次
       重试，验证码就退化成一个摆设。调用方要在返回 False 时让前端换一张。
    """
    if not challenge_id:
        return False

    challenge = db.get(CaptchaChallenge, challenge_id)
    if challenge is None:
        return False

    expired = _as_utc(challenge.expires_at) <= datetime.now(timezone.utc)
    already_used = bool(challenge.used)

    challenge.used = True
    db.commit()

    if expired or already_used or not answer:
        return False
    return answer.strip().lower() == challenge.answer.lower()
