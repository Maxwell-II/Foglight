"""正文分词（P2）：docs/work-packets.md §1.1 冻结规则的唯一实现。

前后端、各处代码的分词规则必须逐字一致，否则标记（第几段、第几个词）会落到
错的词上——所以这里只做 §1.1 允许的三件事：按空行分段、按空白分词、去首尾
空白，不小写化、不去标点、不做词形还原（那些是 saved_words 层的事）。
"""

from __future__ import annotations

import re

_PARAGRAPH_SPLIT_RE = re.compile(r"\n\s*\n")


def tokenize(text: str) -> list[list[str]]:
    """正文 → 段落数组 → 词数组。

    冻结规则（docs/work-packets.md §1.1），不得更改：
      1. 段落分隔：连续两个及以上换行，正则 r'\\n\\s*\\n'
      2. 段内分词：str.split() 按空白切，标点跟着词走 —— "dog." 是一个词，不拆
      3. 每段去首尾空白；空段落丢弃
      4. 不小写化、不做词形还原、不去标点
         （那些是 saved_words 层的事，不在这里做）
    """
    paragraphs: list[list[str]] = []
    for chunk in _PARAGRAPH_SPLIT_RE.split(text):
        stripped = chunk.strip()
        if not stripped:
            continue
        paragraphs.append(stripped.split())
    return paragraphs
