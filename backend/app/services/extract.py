"""网页抓取 + 按标题切分（P4）。

产出统一的 Segment 结构（见 docs/work-packets.md §1.2），与 epub.py 共用下游处理。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import httpx
from bs4 import BeautifulSoup, Tag
from readability import Document
from app.services.segment import Segment


# Segment 定义在 app/services/segment.py（契约文件），两个内容管线共用同一个类型


class FetchError(Exception):
    """抓取或正文提取失败时抛出，绝不返回空字符串。"""


_HEADING_TAGS = ("h1", "h2", "h3", "h4", "h5", "h6")
_BODY_HEADING_TAGS = ("h2", "h3", "h4", "h5", "h6")  # 不含 h1，h1 只作标题用

# 跨多篇文章重复出现的推广/导航类小标题（实测样本），无论落在 h2/h3 都过滤掉。
# 这是黑名单兜底；下面的 class 特征匹配才是主力，二者配合使用。
_NOISE_TITLES = {
    "table of contents",
    "get your shit together - here's how",
    "what the hell are you doing with your life?",
}

# 订阅/推广/分享类容器的 class 名特征：这类块不管标题是否命中黑名单，
# 结构上就不是正文，直接整块剔除。
_NOISE_CLASS_RE = re.compile(
    r"opt-in|promo|newsletter|subscribe|sharedaddy|share-btn|social-share",
    re.IGNORECASE,
)

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# 标题一般很短且不以句子结尾标点收尾；用于在纯文本 paragraphs 里重新识别
# 切分点（split_by_headings 拿到的 Segment 已经没有 DOM 信息了）。
_MAX_HEADING_WORDS = 8
_SENTENCE_END = (".", "!", "?", ":", ";", ",")


def fetch_article(url: str) -> Segment:
    """抓取网页正文，返回未切分的整篇 Segment。

    抓取失败（网络错误 / 非 2xx / 正文提取不到）一律抛 FetchError，不返回空字符串。
    """
    try:
        response = httpx.get(
            url,
            headers={"User-Agent": _USER_AGENT},
            follow_redirects=True,
            timeout=20.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise FetchError(f"抓取失败：{url}（{exc}）") from exc

    html = response.text

    soup = BeautifulSoup(html, "lxml")
    scope = soup.find("article") or soup.find("main") or soup.body or soup

    # h1 优先：readability 的 title() 常年带站点名后缀，且找不到 <title> 时
    # 会返回占位字符串 "[no-title]" 而非空串，不能只凭真假值判断。
    title = ""
    scope_h1 = scope.find("h1")
    if scope_h1:
        title = scope_h1.get_text(strip=True)
    if not title:
        try:
            candidate = Document(html).title().strip()
        except Exception:
            candidate = ""
        if candidate and candidate != "[no-title]":
            title = candidate
    if not title:
        page_h1 = soup.find("h1")
        title = page_h1.get_text(strip=True) if page_h1 else ""
    if not title:
        raise FetchError(f"未能提取标题：{url}")

    headings = scope.find_all(["h2", "h3"])
    if not headings:
        raise FetchError(f"未找到正文结构（无 h2/h3 小标题）：{url}")

    container = _common_ancestor(headings)
    _strip_noise(container)

    paragraphs = _extract_paragraphs(container)
    if not paragraphs:
        raise FetchError(f"正文提取为空：{url}")

    word_count = sum(len(p.split()) for p in paragraphs)
    return Segment(title=title, paragraphs=paragraphs, word_count=word_count)


def split_by_headings(seg: Segment, target: tuple[int, int] = (600, 1200)) -> list[Segment]:
    """按小标题（h2/h3，用短段落启发式重新识别）切成目标长度的片段。

    贪心累积：碰到新标题时，只要当前片段已经达到下限就切一刀；
    没达到下限就继续并入，避免产出一堆几十词的碎片。
    """
    lo, _hi = target
    segments: list[Segment] = []
    current: list[str] = []
    current_heading: str | None = None
    current_words = 0

    def flush() -> None:
        if not current:
            return
        title = f"{seg.title} — {current_heading}" if current_heading else seg.title
        segments.append(
            Segment(title=title, paragraphs=list(current), word_count=current_words)
        )

    for paragraph in seg.paragraphs:
        is_heading = _looks_like_heading(paragraph)
        if is_heading and current and current_words >= lo:
            flush()
            current = []
            current_words = 0
            current_heading = paragraph
        elif is_heading:
            # 没达到下限、不切段，但要记住"目前为止最新的标题"，
            # 这样合并进来的片段仍然标注它实际覆盖的小节。
            current_heading = paragraph
        current.append(paragraph)
        current_words += len(paragraph.split())

    flush()
    return segments


def _looks_like_heading(paragraph: str) -> bool:
    words = paragraph.split()
    if not (1 <= len(words) <= _MAX_HEADING_WORDS):
        return False
    return paragraph.rstrip()[-1:] not in _SENTENCE_END


def _normalize_heading(text: str) -> str:
    text = " ".join(text.split()).strip().lower()
    text = text.replace("’", "'").replace("—", "-").replace("–", "-")
    return text


def _common_ancestor(nodes: list[Tag]) -> Tag:
    chains: list[list[Tag]] = []
    for node in nodes:
        chain: list[Tag] = []
        current: Tag | None = node
        while current is not None:
            chain.append(current)
            current = current.parent
        chains.append(list(reversed(chain)))

    shortest = min(len(chain) for chain in chains)
    idx = 0
    while idx < shortest and all(chain[idx] is chains[0][idx] for chain in chains):
        idx += 1
    return chains[0][idx - 1]


def _strip_noise(container: Tag) -> None:
    for tag in container.find_all(["script", "style", "nav", "form"]):
        tag.decompose()

    for el in list(container.find_all(True)):
        if getattr(el, "decomposed", False):
            continue
        classes = " ".join(el.get("class") or [])
        if _NOISE_CLASS_RE.search(classes):
            el.decompose()

    for heading in list(container.find_all(_BODY_HEADING_TAGS)):
        if getattr(heading, "decomposed", False):
            continue
        if _normalize_heading(heading.get_text()) not in _NOISE_TITLES:
            continue
        node: Tag = heading
        while True:
            parent = node.parent
            if parent is None or parent is container:
                break
            other_headings = [
                h for h in parent.find_all(_BODY_HEADING_TAGS) if h is not heading
            ]
            if other_headings:
                break
            node = parent
        node.decompose()


def _extract_paragraphs(container: Tag) -> list[str]:
    paragraphs: list[str] = []
    for el in container.find_all(list(_BODY_HEADING_TAGS) + ["p", "li"]):
        text = " ".join(el.get_text(" ", strip=True).split())
        if text:
            paragraphs.append(text)
    return paragraphs
