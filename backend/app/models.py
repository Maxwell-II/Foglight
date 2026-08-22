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

    # —— 凭据（Wave 3 §1.12）——
    # 两者都可空：id=1 这个用户在建号之前就是空的，不可空会让迁移直接失败。
    # ⚠️ 建号是给 id=1 补上这两列，不是新建用户 —— 全部历史会话和标记都挂在 id=1，
    #    新建一个 id=2 登进去，他的标记会全部变成看不见的孤儿数据。
    email: Mapped[str | None] = mapped_column(String(320), unique=True, nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # —— 登录限流（Wave 3 §A1）。按账号锁，不按 IP：单用户应用按 IP 只会在换网络时误伤自己 ——
    failed_login_count: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    sessions: Mapped[list["ReadingSession"]] = relationship(back_populates="user")
    auth_sessions: Mapped[list["AuthSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Book(Base):
    """一本书 = 章节的有序编组（Wave 3 §1.9）。

    章节**就是 Article** —— 章节需要的一切（分词正文、词数、档位、会话、标记、
    导出）Article 全都有。新建一张 chapters 表等于把这些逐个复制一遍，正是
    Wave 1 最贵的教训（同一个概念存两份，字段一样但会静默错开）。

    为什么不靠 source_name 分组：那是人类可读的出处字符串，改一个字就散架，
    而且挂不了书级的版权字段和归属。库里那 10 章 Models 恰好靠它分在一起，
    那是巧合不是结构。
    """

    __tablename__ = "books"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(500))
    author: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # 和 Article 同一套版权分层（tech-plan.md §4.2）。书几乎必然是 A 层。
    license: Mapped[str] = mapped_column(String(64))
    redistributable: Mapped[bool] = mapped_column(Boolean, default=False)

    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    # passive_deletes=True 不是可选项：没有它，SQLAlchemy 在 session.delete(book)
    # 时会先把子行的 book_id 置空，于是「走 ORM 删」和「走 SQL 删」结果不同 ——
    # 前者留下一堆 book_id=NULL 的孤儿章涌进短文库，后者按数据库的 CASCADE 删掉。
    # 加上它之后交给数据库处理，两条路径一致（app/db.py 每条连接都开了 foreign_keys=ON）。
    #
    # ⚠️ 代价要知道：删书会连章节一起删，而章节又 CASCADE 到 reading_sessions 和
    #    marks —— 也就是删一本书会销毁这本书上的全部标记。正因如此，Wave 3
    #    **不提供删除书的接口**，这条路径目前只可能被人工 SQL 触发。
    chapters: Mapped[list["Article"]] = relationship(
        back_populates="book", order_by="Article.order_index", passive_deletes=True
    )


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

    # —— 书内归属（Wave 3 §1.9）。散篇文章两个都是 NULL ——
    # 删书时章节一起删：书没了，留着孤儿章没有意义。
    book_id: Mapped[int | None] = mapped_column(
        ForeignKey("books.id", ondelete="CASCADE"), nullable=True
    )
    # ⚠️ 书内顺序的唯一权威（§1.10）。任何地方要按书内顺序排一律用它，
    #    禁止拿 id 或 created_at 代替 —— 那两个只是碰巧接近，不是顺序。
    order_index: Mapped[int | None] = mapped_column(Integer, nullable=True)

    book: Mapped["Book | None"] = relationship(back_populates="chapters")

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


class AuthSession(Base):
    """登录会话（Wave 3 §1.13）。

    为什么是数据库支持而不是 JWT：单机单库、需要「退出登录立刻失效」、
    没有跨服务需求。JWT 在这三条下只带来坏处 —— 改密码后旧令牌仍有效，
    真想撤销还是得建一张这样的表。

    ⚠️ 和 ReadingSession 是两回事，名字像但完全无关：
       ReadingSession = 一次阅读；AuthSession = 一次登录。
    """

    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))

    # 存 sha256 摘要，不存明文令牌 —— db 文件会被 deploy/backup.sh 备份到
    # /var/backups 并保留 7 份，明文令牌进备份等于把登录态泄漏面扩大到所有历史备份。
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    user: Mapped["User"] = relationship(back_populates="auth_sessions")


class CaptchaChallenge(Base):
    """一次验证码挑战（Wave 3 §A1）。

    答案存明文是刻意的：它 5 分钟过期、一次性作废，泄漏它的价值等于零。
    哈希它只会让代码看起来更「安全」而不增加任何实际防护 ——
    这种装饰性加密会让人误以为整套东西比实际更结实。
    """

    __tablename__ = "captcha_challenges"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    answer: Mapped[str] = mapped_column(String(16))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used: Mapped[bool] = mapped_column(Boolean, default=False)
