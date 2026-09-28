"""users 加 google_sub / can_import

Revision ID: c3e8f1a2b7d9
Revises: b1c7a2f40d18
Create Date: 2026-09-24

两列都是公开发布这一轮的：

- `google_sub`：Google 一键登录（`docs/public-release.md` §3b）。存 id_token 的
  `sub`，不拿 email 当 Google 身份 —— 用户可以改 Google 账号的邮箱，sub 不变。
  可空（邮箱密码用户没有它），唯一（一个 Google 账号只能对应一个用户）。

- `can_import`：导入入口的开关（§3⑥ + §2「公开版不做用户导入」）。默认 false，
  **只给 id=1 打开** —— 那是 owner 自己，owner 的私有文章和书都是这么
  导进来的，不能因为收紧入口把他自己也关在外面。

⚠️ `server_default` 不能省：users 表已经有 id=1 那一行，NOT NULL 列不带默认值
   加不进去（和 cff4757d8470 里 failed_login_count 踩过的是同一个坑）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c3e8f1a2b7d9"
down_revision: Union[str, None] = "b1c7a2f40d18"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("google_sub", sa.String(length=255), nullable=True))
        batch_op.add_column(
            sa.Column("can_import", sa.Boolean(), server_default=sa.text("0"), nullable=False)
        )
        batch_op.create_unique_constraint("uq_users_google_sub", ["google_sub"])

    # 空库（测试 / 全新部署）里没有 id=1，这条 UPDATE 影响 0 行，不报错。
    op.execute(sa.text("UPDATE users SET can_import = 1 WHERE id = 1"))


def downgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_constraint("uq_users_google_sub", type_="unique")
        batch_op.drop_column("can_import")
        batch_op.drop_column("google_sub")
