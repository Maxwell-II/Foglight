"""数据库连接与会话。

SQLite 有几个默认行为很坑，必须在每条连接建立时用 PRAGMA 纠正 ——
尤其是外键：SQLite 默认**不强制**外键约束，忘了开的话删掉一个 session
后它的 marks 会变成孤儿数据，而且不报任何错。
"""

from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

_is_sqlite = settings.database_url.startswith("sqlite")

engine = create_engine(
    settings.database_url,
    # SQLite 默认禁止跨线程复用连接，而 FastAPI 在线程池里跑同步路由
    connect_args={"check_same_thread": False} if _is_sqlite else {},
    future=True,
)


@event.listens_for(engine, "connect")
def _apply_sqlite_pragmas(dbapi_connection, _connection_record) -> None:
    """每条新连接都要设一遍 —— PRAGMA 是连接级的，不是数据库级的。"""
    if not _is_sqlite:
        return
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")      # 读写不互相阻塞
    cursor.execute("PRAGMA foreign_keys=ON")       # ⚠️ 默认是 OFF，必须显式打开
    cursor.execute("PRAGMA busy_timeout=5000")     # 写锁冲突时等待而非直接报错
    cursor.execute("PRAGMA synchronous=NORMAL")    # WAL 下的安全/性能平衡点
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    """FastAPI 依赖：每个请求一个会话，结束时关闭。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
