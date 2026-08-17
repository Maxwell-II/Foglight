"""导出服务：把文章 + 标记渲染成 Markdown，丢给 agent 讨论用。

输出格式的唯一权威是 frontend/src/lib/export.ts（已上线验证），
这里逐行对齐它的实现；Phase 1 后端接管后，前端那份会被删除。
"""

from __future__ import annotations

from typing import Protocol, Sequence

_CONTEXT_MAX_CHARS = 240

_CLOSING_INSTRUCTION = "请针对以上标记，先问我对每一处的理解，再解释；不要直接整段翻译。"


class MarkView(Protocol):
    """鸭子类型：任何带这些属性的对象都能传进来，不必是 app.models.Mark。"""

    type: str  # 'unknown_word' / 'unclear'
    start_paragraph_idx: int
    start_word_idx: int
    end_paragraph_idx: int
    end_word_idx: int
    surface_text: str


def _context_for(paragraphs: list[list[str]], p: int) -> str:
    """取标记所在段落作为上下文，太长就截断。对应 export.ts 的 contextFor。"""
    if p < 0 or p >= len(paragraphs):
        return ""
    raw = " ".join(paragraphs[p])
    return f"{raw[:_CONTEXT_MAX_CHARS]}…" if len(raw) > _CONTEXT_MAX_CHARS else raw


def _sort_key(mark: MarkView) -> tuple[int, int]:
    return (mark.start_paragraph_idx, mark.start_word_idx)


def build_markdown(
    *,
    title: str,
    author: str | None,
    source: str,
    paragraphs: list[list[str]],
    marks: Sequence[MarkView],
) -> str:
    unknown = sorted((m for m in marks if m.type == "unknown_word"), key=_sort_key)
    unclear = sorted((m for m in marks if m.type == "unclear"), key=_sort_key)

    lines: list[str] = []
    lines.append(f"# 阅读复盘素材：{title}")
    lines.append("")
    source_line = f"来源：{source} — {author}" if author else f"来源：{source}"
    lines.append(source_line)
    lines.append(f"陌生词 {len(unknown)} 处，模糊处 {len(unclear)} 处。")
    lines.append("")

    lines.append("## 原文")
    lines.append("")
    for words in paragraphs:
        lines.append(" ".join(words))
        lines.append("")

    lines.append("## 陌生词标记")
    lines.append("")
    if not unknown:
        lines.append("（无）")
    for m in unknown:
        context = _context_for(paragraphs, m.start_paragraph_idx)
        lines.append(f"- **{m.surface_text}** — 所在段落：{context}")
    lines.append("")

    lines.append("## 模糊处标记")
    lines.append("")
    if not unclear:
        lines.append("（无）")
    for m in unclear:
        context = _context_for(paragraphs, m.start_paragraph_idx)
        lines.append(f'- **"{m.surface_text}"** — 所在段落：{context}')
    lines.append("")

    lines.append("---")
    lines.append(_CLOSING_INSTRUCTION)

    return "\n".join(lines)
