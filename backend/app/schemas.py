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
    created_at: datetime


class ArticleDetail(ArticleSummary):
    """阅读页用，带上已分词的正文。"""

    source_url: str | None = None
    source_name: str | None = None
    license: str
    redistributable: bool
    body_paragraphs: list[list[str]]


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
