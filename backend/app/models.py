"""数据表定义。结构以 docs/architecture.md §4.2 为准。

关于枚举字段（source_type / license / status / type）为什么用普通字符串而不是
SQLAlchemy Enum：Enum 在 SQLite 上会落成 VARCHAR + CHECK 约束，而 SQLite 改
CHECK 约束必须重建整张表。将来多一种来源类型就要做一次表重建，不值得。
取值范围由 Pydantic 层（schemas.py）校验，下面的常量是唯一权威。
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import JSON


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


# —— 枚举取值：唯一权威，schemas.py 直接引用这些类做校验 ——
# 用 StrEnum 而不是 SQLAlchemy Enum 列：值仍以普通字符串入库，
# 校验放在 Pydantic 层，这样新增一种取值不需要重建 SQLite 表。


class SourceType(StrEnum):
    CURATED = "curated"
    USER_URL = "user_url"
    USER_TEXT = "user_text"
    EPUB = "epub"
    AI_GENERATED = "ai_generated"


class License(StrEnum):
    CC_BY = "CC BY 4.0"
    CC_BY_ND = "CC BY-ND 4.0"
    PUBLIC_DOMAIN = "public_domain"
    COPYRIGHTED = "copyrighted"
    AI_GENERATED = "ai_generated"


class SessionStatus(StrEnum):
    READING = "reading"
    FINISHED = "finished"
    ABANDONED = "abandoned"


class MarkType(StrEnum):
    UNKNOWN_WORD = "unknown_word"
    UNCLEAR = "unclear"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    sessions: Mapped[list["ReadingSession"]] = relationship(back_populates="user")


class Article(Base):
    __tablename__ = "articles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(500))
    author: Mapped[str | None] = mapped_column(String(200), nullable=True)

    source_type: Mapped[str] = mapped_column(String(32))
    source_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    # 人类可读的出处，导出 Markdown 的「来源」行要用它。
    # 例：书名 "Models: Attract Women Through Honesty"、站点名 "markmanson.net"。
    # 没有它就只能拿 source_type 顶替，导出会变成"来源：epub"，很难看。
    source_name: Mapped[str | None] = mapped_column(String(300), nullable=True)

    # —— 版权分层（docs/tech-plan.md §4.2）——
    # redistributable 决定这篇将来能不能公开给别人。必须逐篇标注，
    # 否则以后想开放服务时得回头人工审几百篇。
    license: Mapped[str] = mapped_column(String(64))
    redistributable: Mapped[bool] = mapped_column(Boolean, default=False)

    # 已分词的正文：list[list[str]]，第一层段落、第二层词。
    # 分词规则见 docs/work-packets.md §1.1 —— 由后端唯一负责，前端只渲染。
    body_paragraphs: Mapped[list[list[str]]] = mapped_column(JSON)

    word_count: Mapped[int] = mapped_column(Integer)
    est_minutes: Mapped[int] = mapped_column(Integer)
    topics: Mapped[list[str]] = mapped_column(JSON, default=list)

    # 落在 NGSL 前 3000 词之外的 token 占比，0.0–1.0。P6 未接入前为空。
    difficulty: Mapped[float | None] = mapped_column(Float, nullable=True)

    # 用户自己导入的文章归属；curated 的为 NULL
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    sessions: Mapped[list["ReadingSession"]] = relationship(back_populates="article")

    # 篇幅档位：word_count 的纯函数，不加数据库列（docs/work-packets-wave2.md §1.7）。
    # 唯一实现——前端不许自己再算一遍，改阈值只改这一处，全库立刻生效。
    @property
    def level(self) -> str:
        if self.word_count < 400:
            return "short"
        if self.word_count < 900:
            return "medium"
        return "long"


class ReadingSession(Base):
    __tablename__ = "reading_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    article_id: Mapped[int] = mapped_column(ForeignKey("articles.id", ondelete="CASCADE"))

    status: Mapped[str] = mapped_column(String(16), default="reading")
    scroll_position: Mapped[int] = mapped_column(Integer, default=0)

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    user: Mapped["User"] = relationship(back_populates="sessions")
    article: Mapped["Article"] = relationship(back_populates="sessions")
    marks: Mapped[list["Mark"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class Mark(Base):
    """一条标记。

    挂在 session 而不是 article 上：同一篇重读是新的一组标记，
    可以对比"第二次读还标不标这个词" —— 这是个有价值的信号。

    定位用（段序号，词序号），不用字符偏移：正文重新清洗后字符偏移会整体错位。
    陌生词是 start == end 的特例，两种标记共用一套结构。
    """

    __tablename__ = "marks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("reading_sessions.id", ondelete="CASCADE")
    )

    type: Mapped[str] = mapped_column(String(16))

    start_paragraph_idx: Mapped[int] = mapped_column(Integer)
    start_word_idx: Mapped[int] = mapped_column(Integer)
    end_paragraph_idx: Mapped[int] = mapped_column(Integer)
    end_word_idx: Mapped[int] = mapped_column(Integer)

    # 冗余存一份原文和上下文，导出与查询时不必回头重新拼
    surface_text: Mapped[str] = mapped_column(Text)
    context: Mapped[str] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    session: Mapped["ReadingSession"] = relationship(back_populates="marks")
