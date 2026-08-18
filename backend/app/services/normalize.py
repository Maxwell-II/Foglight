"""入库前的文本清洗（W1）：docs/work-packets-wave2.md §1.8 冻结规则的唯一实现。

产出的文本再交给冻结的 tokenize()（docs/work-packets.md §1.1）—— 清洗是
tokenize 的上游独立一步，绝不修改 tokenize.py 本身。
"""

from __future__ import annotations

import re
from typing import Literal

_ZERO_WIDTH_CHARS = "﻿​↵"  # BOM、零宽空格、↵

_BOLD_DOUBLE_STAR_RE = re.compile(r"\*\*(.+?)\*\*")
_BOLD_DOUBLE_UNDERSCORE_RE = re.compile(r"__(.+?)__")
_HEADING_MARKER_RE = re.compile(r"^#{1,6} +", re.MULTILINE)
_EXCESS_BLANK_LINES_RE = re.compile(r"\n{3,}")

ParagraphMode = Literal["blank_line", "single_line"]


def normalize(text: str, *, paragraph_mode: ParagraphMode = "blank_line") -> str:
    """入库前清洗。产出的文本再交给冻结的 tokenize()。

    按顺序执行（docs/work-packets-wave2.md §1.8）：
      1. CRLF / CR → LF
      2. 删 BOM、零宽字符（U+200B、U+FEFF）、↵（U+21B5）
      3. 去成对的 Markdown 强调标记：**bold** / __bold__ → bold
      4. 去行首的 Markdown 标题标记 #～###### 及其后空格
      5. 每行去尾部空白；连续 3 个及以上换行压成 2 个
      6. paragraph_mode == "single_line" 时：把所有单换行升级成空行

    单星号 *i* 和单下划线 _i_ 不处理，弯引号一律保留。
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    for ch in _ZERO_WIDTH_CHARS:
        text = text.replace(ch, "")

    text = _BOLD_DOUBLE_STAR_RE.sub(r"\1", text)
    text = _BOLD_DOUBLE_UNDERSCORE_RE.sub(r"\1", text)

    text = _HEADING_MARKER_RE.sub("", text)

    text = "\n".join(line.rstrip() for line in text.split("\n"))
    text = _EXCESS_BLANK_LINES_RE.sub("\n\n", text)

    if paragraph_mode == "single_line":
        text = text.replace("\n", "\n\n")

    return text
