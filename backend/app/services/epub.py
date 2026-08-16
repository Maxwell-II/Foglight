"""epub 导入服务：把 epub 切成 Segment 列表。

算法见 docs/work-packets.md §P3，已在真实文件上验证（62 片段 / 22 篇 600-1200 词）。
用 BeautifulSoup 而非正则解析 HTML —— 正则会因嵌套标签截断段落。
"""

from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass, field
from io import BytesIO

from bs4 import BeautifulSoup
from bs4 import NavigableString, Tag
from bs4.element import Comment
from app.services.segment import Segment

# 行内标签：删除标签本身，不留空格（首字下沉 <b>S</b>ometimes 必须拼回 "Sometimes"）
_INLINE_TAGS = {"b", "i", "em", "strong", "span", "a", "sup", "sub"}

# 短段落且带这个 class = 被 calibre 降级的小标题，拿它当切分点
_SUBHEADING_CLASS = "c10"
_SUBHEADING_MAX_WORDS = 6

# 片段最短长度（词数），不足丢弃
_MIN_SEGMENT_WORDS = 200


# Segment 定义在 app/services/segment.py（契约文件），两个内容管线共用同一个类型


def _tag_text(tag: Tag) -> str:
    """把一个 <p> 标签转成纯文本，遵守行内/块级标签的不同处理规则。"""
    parts: list[str] = []
    for desc in tag.descendants:
        if isinstance(desc, Comment):
            continue
        if isinstance(desc, NavigableString):
            parts.append(str(desc))
        elif isinstance(desc, Tag) and desc.name not in _INLINE_TAGS:
            parts.append(" ")
    text = "".join(parts)
    return re.sub(r"\s+", " ", text).strip()


def _finalize(title: str, paragraphs: list[str]) -> Segment | None:
    word_count = sum(len(p.split()) for p in paragraphs)
    if word_count <= _MIN_SEGMENT_WORDS:
        return None
    return Segment(title=title, paragraphs=paragraphs, word_count=word_count)


def _split_document(html: str) -> list[Segment]:
    soup = BeautifulSoup(html, "lxml")

    h1 = soup.find("h1")
    chapter = h1.get_text(strip=True) if h1 else "?"

    segments: list[Segment] = []
    title = chapter
    paragraphs: list[str] = []

    for p in soup.find_all("p"):
        classes = p.get("class") or []
        text = _tag_text(p)
        if not text:
            continue

        if _SUBHEADING_CLASS in classes and len(text.split()) <= _SUBHEADING_MAX_WORDS:
            seg = _finalize(title, paragraphs)
            if seg is not None:
                segments.append(seg)
            title = f"{chapter} — {text}"
            paragraphs = []
        else:
            paragraphs.append(text)

    seg = _finalize(title, paragraphs)
    if seg is not None:
        segments.append(seg)

    return segments


def parse_epub(data: bytes) -> list[Segment]:
    """epub 二进制 → Segment 列表。"""
    zf = zipfile.ZipFile(BytesIO(data))
    names = sorted(n for n in zf.namelist() if re.search(r"\.(x?html)$", n))

    segments: list[Segment] = []
    for name in names:
        doc = zf.read(name).decode("utf-8", "ignore")
        segments.extend(_split_document(doc))

    return segments
