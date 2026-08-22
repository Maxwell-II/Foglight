"""导出服务：把文章 + 标记渲染成 Markdown，丢给 agent 讨论用。

输出格式的唯一权威是 frontend/src/lib/export.ts（已上线验证），
这里逐行对齐它的实现；Phase 1 后端接管后，前端那份会被删除。
"""

from __future__ import annotations

from dataclasses import dataclass
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


# ---------- 书级导出（Wave 3 B2）----------
#
# ⚠️ 上面的 build_markdown 一个字都没动：书级导出是在它之外**追加**的一层。
#    每一章的正文块由 build_markdown 原样产出，这里只做两件事 ——
#    把各章末尾那句追问指令剥掉，整篇结尾补回一次。

# build_markdown 结尾固定是这两行（"---" + 追问指令），join 之后就是这个后缀。
# 用常量拼出来而不是写死字面量：将来那两行改了，_strip_closing 跟着自动对上。
_CLOSING_BLOCK = "\n---\n" + _CLOSING_INSTRUCTION


@dataclass
class BookChapterView:
    """书级导出里的一章。字段全部来自 Article + 该用户在这一章上的标记。"""

    order_index: int
    title: str
    author: str | None
    source: str
    paragraphs: list[list[str]]
    marks: Sequence[MarkView]


def _strip_closing(markdown: str) -> str:
    """去掉 build_markdown 结尾的「--- + 追问指令」。

    为什么不把 build_markdown 拆成「正文部分 + 结尾部分」两个函数：那要改它的
    实现，而它的输出是已经上线验证过的（test_export.py 逐行锁着）。在外面剥一刀
    风险更小，而且 endswith 对不上时原样返回 —— 宁可多一句指令，也不要截断正文。
    """
    if markdown.endswith(_CLOSING_BLOCK):
        return markdown[: -len(_CLOSING_BLOCK)]
    return markdown


def _chapter_body(markdown: str) -> str:
    """把 build_markdown 的单章输出改造成「书里的一章」该有的样子。

    单章导出是一份独立文档，所以它开头有自己的 h1 页眉：

        # 阅读复盘素材：<章名>
        (空行)
        来源：<出处>
        陌生词 N 处，模糊处 M 处。
        (空行)

    整本拼起来时这一块是有害的：h1 会落在书级的 `## 第 N 章` 之下（h2 套 h1），
    章名紧接着重复一遍，`来源：` 每章重复而整本开头已经写过一次。3 章的导出
    因此会出现 4 个一级标题 —— 而这份东西是要粘给 agent 的，噪音重复 N 遍。

    这里做两件事，**都在 build_markdown 之外**，它的字节输出一个都不变：
      1. 砍掉那个页眉块，只留「陌生词 N 处」那一行（它是逐章有用的信息）
      2. 把章内的 `## 原文` / `## 陌生词标记` 降成 `###`，让层级和书级 `##` 对齐

    找不到预期形状时原样返回 —— 宁可版式难看，也不要截断正文。
    """
    lines = markdown.splitlines()
    if not lines or not lines[0].startswith("# "):
        return markdown

    first_section = next(
        (i for i, line in enumerate(lines) if line.startswith("## ")), None
    )
    if first_section is None:
        return markdown

    # 页眉块里唯一值得留下的是计数行，它是逐章变化的
    count_line = next(
        (line for line in lines[:first_section] if line.startswith("陌生词 ")), ""
    )

    # 只降标题行，不碰正文（正文是 " ".join(词表)，不会以 "## " 开头）
    body = [
        "#" + line if line.startswith("## ") else line
        for line in lines[first_section:]
    ]

    kept = ([count_line, ""] if count_line else []) + body
    return chr(10).join(kept)


def build_book_markdown(
    *,
    book_title: str,
    author: str | None,
    chapters: Sequence[BookChapterView],
) -> str:
    """把若干章的标记拼成一份复盘素材。

    ⚠️ **`_CLOSING_INSTRUCTION` 整篇只出现一次。** 这是这个函数最要紧的一条：
       重复 N 遍会让对面的 agent 每章都问一遍，把复盘变成审讯。

    调用方负责只传「有标记的章」（routers/books.py 里过滤，全空时返回 404 而不是
    一份空壳 Markdown）。这里不再筛，传什么渲染什么。
    """
    unknown_total = sum(1 for ch in chapters for m in ch.marks if m.type == "unknown_word")
    unclear_total = sum(1 for ch in chapters for m in ch.marks if m.type == "unclear")

    indexes = [ch.order_index for ch in chapters]
    if not indexes:
        span = ""
    elif min(indexes) == max(indexes):
        span = f"第 {min(indexes)} 章"
    else:
        span = f"第 {min(indexes)}–{max(indexes)} 章"

    lines: list[str] = []
    lines.append(f"# 阅读复盘素材：《{book_title}》{span}".rstrip())
    lines.append("")
    lines.append(f"来源：{book_title} — {author}" if author else f"来源：{book_title}")
    lines.append(
        f"共 {len(chapters)} 章，陌生词 {unknown_total} 处，模糊处 {unclear_total} 处。"
    )
    lines.append("")

    for chapter in chapters:
        # 章与章之间的分隔。章内那个 h1（build_markdown 自带）保持原样 ——
        # 「逐字不变」优先于版式好看，改它就等于分叉出第二套导出格式。
        lines.append(f"## 第 {chapter.order_index} 章：{chapter.title}")
        lines.append("")
        body = build_markdown(
            title=chapter.title,
            author=chapter.author,
            source=chapter.source,
            paragraphs=chapter.paragraphs,
            marks=chapter.marks,
        )
        lines.append(_chapter_body(_strip_closing(body)).rstrip("\n"))
        lines.append("")

    lines.append("---")
    lines.append(_CLOSING_INSTRUCTION)

    return "\n".join(lines)
