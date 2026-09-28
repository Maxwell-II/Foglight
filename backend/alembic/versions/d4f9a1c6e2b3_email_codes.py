"""email_codes 表：注册验证码 / 找回密码验证码

Revision ID: d4f9a1c6e2b3
Revises: c3e8f1a2b7d9
Create Date: 2026-09-28

推翻了 2026-09-17「v1 不做自助重置密码」（public-release.md §2）。
只新建一张表，不碰已有数据：已注册的老账号照常登录，不要求补验证邮箱。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d4f9a1c6e2b3"
down_revision: Union[str, None] = "c3e8f1a2b7d9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "email_codes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("purpose", sa.String(length=16), nullable=False),
        sa.Column("code", sa.String(length=16), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_email_codes_email", "email_codes", ["email"])


def downgrade() -> None:
    op.drop_index("ix_email_codes_email", table_name="email_codes")
    op.drop_table("email_codes")
