"""把不可再分发的 curated 内容改判给它真正的主人

Revision ID: b1c7a2f40d18
Revises: 9d21b80e3f64
Create Date: 2026-09-17

为什么需要这次迁移（`docs/public-release.md` §3① / `app/visibility.py`）：

`created_by IS NULL` 一直被当成"curated，所有人可见"。单用户时这没问题——
"所有人"就是 owner 自己。但库里 74 篇 curated **全部是 `copyrighted`**，
所以一旦开放注册，这个语义就变成
"把 74 篇有版权的正文发给每一个注册的人"。

可见性规则因此改成了「公开库 = `created_by IS NULL` **且** `redistributable`」。
但**只改规则会连 owner 自己也看不到这 74 篇** —— 那是 owner 每天在读的东西。
所以这次迁移把它们改判给现有的那个用户：改完之后

    created_by IS NULL  ⟺  公开库（当前为空，这是事实不是 bug）
    created_by = <owner>   ⟺  owner 的私人书架

⚠️ **只在库里恰好有一个用户时执行。** 多于一个就无法判断该给谁，
   与其猜一个不如原样不动、让人工来处理 —— 猜错的后果是把 A 的阅读材料
   划给 B，而这类错误没有任何症状。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b1c7a2f40d18"
down_revision: Union[str, None] = "9d21b80e3f64"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _sole_user_id(conn) -> int | None:
    rows = conn.execute(sa.text("SELECT id FROM users ORDER BY id")).fetchall()
    return rows[0][0] if len(rows) == 1 else None


def upgrade() -> None:
    conn = op.get_bind()
    owner = _sole_user_id(conn)
    if owner is None:
        # 空库（测试和全新部署）或已经多用户。两种情况都不该猜。
        return

    for table in ("articles", "books"):
        conn.execute(
            sa.text(
                f"UPDATE {table} SET created_by = :owner "
                "WHERE created_by IS NULL AND redistributable = 0"
            ),
            {"owner": owner},
        )


def downgrade() -> None:
    """不可逆，故意留空。

    回滚要做的是"把刚才改判的那些再置回 NULL"，但迁移之后**没有任何字段记得
    哪些是它改的** —— 用户自己导入的不可再分发文章和被改判的 curated 文章
    现在长得一模一样。置回去会把他自己导入的 311 篇一起变成公开库内容，
    那正是这次迁移要防的事，方向还反了。

    真要回滚：先恢复 `reading.db.before-*` 快照，再降级。
    """
