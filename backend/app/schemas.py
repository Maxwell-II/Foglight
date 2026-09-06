"""请求 / 响应的数据格式。

命名约定：数据库和 Python 用 snake_case，前端 TypeScript 用 camelCase。
转换在这一层统一做（alias_generator），业务代码里不出现 camelCase。
对应的前端类型见 frontend/src/types.ts，字段必须能一一对上。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

# 枚举的唯一权威在 models.py，这里直接复用，不重复定义
from app.models import License, MarkType, SessionStatus

# 篇幅档位的输入形状：段落间怎么切，唯一实现见 app.services.normalize
ParagraphMode = Literal["blank_line", "single_line"]


class ApiModel(BaseModel):
    """所有对外模型的基类：输出 camelCase，输入两种写法都收。"""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
    )


# ---------- Article ----------


class ArticleSummary(ApiModel):
    """列表页用，不含正文 —— 正文很大，列表不该带。"""

    id: int
    title: str
    author: str | None = None
    source_type: str
    word_count: int
    est_minutes: int
    topics: list[str] = Field(default_factory=list)
    difficulty: float | None = None
    # 篇幅档位（short/medium/long），来自 Article.level property（docs/work-packets-wave2.md §1.7）
    level: str
    # 下面四个都是会话表的派生值，不是数据库列 ——
    # 由 routers/articles.py 的 _attach_session_state 一条 SQL 算完后挂到实例上。
    # 默认值是给「刚导入的文章」兜底（它还没有任何会话），不是业务默认值。
    #
    # 读完过没有（存在 finished 会话）
    is_read: bool = False
    # 最近一个未完成会话。前端有它就直接进去续读，不再新建 ——
    # 每点一次就新建的话，上一次的标记会被孤立、再也回不去（这就是「标记没了」的成因）
    resume_session_id: int | None = None
    # 最近一个标过东西的会话及其标记数。这是回到上一次标记的唯一入口
    last_marks_session_id: int | None = None
    last_marks_count: int = 0
    created_at: datetime


class ArticleDetail(ArticleSummary):
    """阅读页用，带上已分词的正文。"""

    source_url: str | None = None
    source_name: str | None = None
    license: str
    redistributable: bool
    body_paragraphs: list[list[str]]
    book_page_layout: list[dict] | None = None
    book_context: "BookPageContext | None" = None


class EpubImportCandidate(ApiModel):
    """epub 上传但不传 titles 时的候选片段清单条目，不入库。"""

    title: str
    word_count: int


class ArticleImportText(ApiModel):
    """粘贴正文导入。分词由后端做，客户端只给纯文本。"""

    title: str
    author: str | None = None
    source_name: str | None = None
    text: str
    license: License = "copyrighted"
    redistributable: bool = False
    topics: list[str] = Field(default_factory=list)
    # 段落切分方式，见 app.services.normalize；默认按空行分段
    paragraph_mode: ParagraphMode = "blank_line"


class ArticlePreviewRequest(ApiModel):
    """粘贴导入的预览请求。请求体同 ArticleImportText，但 title 可空——预览不落库，不需要标题。"""

    title: str | None = None
    author: str | None = None
    source_name: str | None = None
    text: str
    license: License = "copyrighted"
    redistributable: bool = False
    topics: list[str] = Field(default_factory=list)
    paragraph_mode: ParagraphMode = "blank_line"


class ArticlePreviewResponse(ApiModel):
    """粘贴导入的预览结果。不入库、不写数据库。"""

    paragraph_count: int
    word_count: int
    level: str
    first_paragraphs: list[str]


# ---------- Mark ----------


class MarkCreate(ApiModel):
    type: MarkType
    start_paragraph_idx: int = Field(ge=0)
    start_word_idx: int = Field(ge=0)
    end_paragraph_idx: int = Field(ge=0)
    end_word_idx: int = Field(ge=0)
    surface_text: str
    context: str = ""
    book_run_id: int | None = None


class MarkOut(MarkCreate):
    id: int
    created_at: datetime


# ---------- ReadingSession ----------


class SessionCreate(ApiModel):
    article_id: int


class SessionUpdate(ApiModel):
    status: SessionStatus | None = None
    scroll_position: int | None = Field(default=None, ge=0)


class SessionOut(ApiModel):
    id: int
    article_id: int
    status: str
    scroll_position: int
    started_at: datetime
    finished_at: datetime | None = None


class SessionDetail(SessionOut):
    marks: list[MarkOut] = Field(default_factory=list)


# ---------- Book（Wave 3 §1.9 / §1.11）----------
#
# 书级的三个计数和「下一章」全是派生值，不加数据库列 —— 和 level（§1.7）、
# is_read（Wave 2.5）同一条理由：加列 = 多一个会和事实漂移的冗余字段。
# 算法在 routers/books.py，一条 SQL 聚合完。


class ChapterSummary(ArticleSummary):
    """书里的一章 = ArticleSummary + 书内序号。

    章节就是 Article（§1.9），所以这里继承而不是另起一份 —— 前四个会话派生值
    （isRead / resumeSessionId / lastMarksSessionId / lastMarksCount）由
    routers/articles.py 的 _attach_session_state 挂上，书籍路由直接 import 它复用。

    order_index 不可空：散篇文章才是 NULL，能走到这个模型的一定属于某本书。
    真出现 NULL 是数据完整性问题（§1.10 要求书内连续不重复），宁可在这里报错，
    也不要静默按 0 处理把顺序搞乱。
    """

    order_index: int


class BookNextChapter(ApiModel):
    """§1.11 写死的定义：order_index 最小的、且不存在 finished 会话的那一章。

    ⚠️ 不是「最后读的那章 + 1」—— 跳读之后那个定义会指向已经读过的章。
    """

    article_id: int
    title: str
    order_index: int


class BookSummary(ApiModel):
    """书架用。不含章节列表 —— 一本 62 章的书，书架上不该带 62 条正文元数据。"""

    id: int
    title: str
    author: str | None = None
    chapter_count: int
    finished_chapter_count: int
    # 这本书上一共标了多少处：该用户在本书全部章节、全部会话上的标记总数。
    # 不是「最近一次」的数 —— 那个是章级的 lastMarksCount。
    total_marks: int
    next_chapter: BookNextChapter | None = None
    reading_mode: str = "legacy_chapters"
    page_count: int = 0
    finished_page_count: int = 0
    pending_review_count: int = 0


class BookDetail(BookSummary):
    """目录页用，带上按 order_index 排好的章节。"""

    chapters: list[ChapterSummary] = Field(default_factory=list)


class BookPageContext(ApiModel):
    book_id: int
    reading_mode: str
    section_id: int
    section_title: str
    page_number: int
    page_count: int
    previous_article_id: int | None = None
    next_article_id: int | None = None


class BookSectionOut(ApiModel):
    id: int
    order_index: int
    title: str
    kind: str
    part_title: str | None = None
    first_page: int
    last_page: int
    page_count: int
    finished_page_count: int


class BookToc(ApiModel):
    book_id: int
    title: str
    author: str | None = None
    page_count: int
    finished_page_count: int
    pending_review_count: int
    active_run_id: int | None = None
    resume_article_id: int | None = None
    sections: list[BookSectionOut]


class BookPageSummary(ApiModel):
    article_id: int
    page_number: int
    title: str
    word_count: int
    is_read: bool
    mark_count: int


class ReadingRunOut(ApiModel):
    id: int
    book_id: int
    current_session_id: int | None = None
    recommended_article_id: int
    started_at: datetime
    ended_at: datetime | None = None


class OpenBookPage(ApiModel):
    article_id: int


class OpenBookPageResult(ApiModel):
    run_id: int
    session_id: int
    book_context: BookPageContext


class FinishReadingRunResult(ApiModel):
    run_id: int
    book_id: int
    pending_count: int


class ReviewCandidateMark(ApiModel):
    id: int
    type: str
    surface_text: str
    start_paragraph_idx: int
    start_word_idx: int


class ReviewCandidatePage(ApiModel):
    article_id: int
    page_number: int
    section_title: str
    current_marks: list[ReviewCandidateMark] = Field(default_factory=list)
    earlier_marks: list[ReviewCandidateMark] = Field(default_factory=list)


class ReviewCandidateResponse(ApiModel):
    run_id: int | None = None
    pages: list[ReviewCandidatePage]
    open_batches: list["ReviewBatchSummary"]


class ReviewBatchCreate(ApiModel):
    run_id: int | None = None
    mark_ids: list[int] = Field(min_length=1)
    request_key: str = Field(min_length=8, max_length=64)


class ReviewBatchSummary(ApiModel):
    id: int
    page_numbers: list[int]
    mark_count: int
    created_at: datetime
    handled_at: datetime | None = None


class ReviewBatchDetail(ReviewBatchSummary):
    book_id: int
    markdown: str


ArticleDetail.model_rebuild()
ReviewCandidateResponse.model_rebuild()
