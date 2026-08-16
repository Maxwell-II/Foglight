"""Segment —— 内容管线的统一产出结构。

★ 契约文件：由规划方维护，任务包不得修改。

docs/work-packets.md §1.2 规定 epub 导入和网页抓取「都产出这个结构」，
但当时没写明它住在哪，结果两个包各自定义了一份同名 dataclass。
字段虽然一样，但类型不同：isinstance 判断会失败，两边独立演化后会静默错开。
统一放这里，两个服务都从这里导入。
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Segment:
    """一个可独立阅读的片段。

    title       片段标题；长文切分后形如「章节名 — 小节名」
    paragraphs  纯文本段落，**尚未分词**
                （分词由 tokenize() 统一负责，见 work-packets.md §1.1）
    word_count  sum(len(p.split()) for p in paragraphs)
    """

    title: str
    paragraphs: list[str] = field(default_factory=list)
    word_count: int = 0
