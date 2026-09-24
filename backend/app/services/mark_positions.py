"""标记位置的越界校验。

登录用户的标记（POST /sessions/{id}/marks）是阅读器当场点出来的，位置天然落在
正文里。游客导出和标记迁移不一样：标记来自 localStorage，可能是旧版本正文上标的、
被手改过的、或者干脆是伪造的。不校验的后果：

- 导出：`_context_for` 对越界段号返回空串，Markdown 里出现一条没有上下文的标记 ——
  不崩，但交付物是坏的，而且用户看不出为什么
- 迁移：越界的标记会原样进数据库，之后阅读器在那篇文章上渲染它时才出问题

所以两处都在入口一次性校验，不合法就整个请求 422。
"""

from __future__ import annotations

from typing import Protocol, Sequence


class _Positioned(Protocol):
    start_paragraph_idx: int
    start_word_idx: int
    end_paragraph_idx: int
    end_word_idx: int


def _in_bounds(paragraphs: list[list[str]], p: int, w: int) -> bool:
    return 0 <= p < len(paragraphs) and 0 <= w < len(paragraphs[p])


def first_position_error(
    paragraphs: list[list[str]], marks: Sequence[_Positioned]
) -> str | None:
    """返回第一条不合法标记的说明；全部合法返回 None。

    合法 = 起止两个位置都落在正文里（段号、词号都不越界），且起点不在终点之后。
    后一条和前端 lib/pos.ts 的 normalize 同口径：阅读器存下来的永远是 [前, 后]。
    """
    for index, mark in enumerate(marks):
        start = (mark.start_paragraph_idx, mark.start_word_idx)
        end = (mark.end_paragraph_idx, mark.end_word_idx)
        if not _in_bounds(paragraphs, *start) or not _in_bounds(paragraphs, *end):
            return f"第 {index + 1} 条标记的位置超出正文范围"
        if start > end:
            return f"第 {index + 1} 条标记的起点在终点之后"
    return None
