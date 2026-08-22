"""wave3 books and auth

Revision ID: cff4757d8470
Revises: 447dea3e2f06
Create Date: 2026-08-22 14:39:06.471881

自动生成后手工修了两处，都会在真实库上炸（见下面的 ⚠️ 注释）：
  1. failed_login_count 是 NOT NULL 但没有 server_default —— users 表已有一行数据
  2. 约束全是匿名的（None），downgrade 时 drop 不掉
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'cff4757d8470'
down_revision: Union[str, None] = '447dea3e2f06'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'captcha_challenges',
        sa.Column('id', sa.String(length=32), nullable=False),
        sa.Column('answer', sa.String(length=16), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('used', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.PrimaryKeyConstraint('id'),
    )

    op.create_table(
        'auth_sessions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('auth_sessions', schema=None) as batch_op:
        batch_op.create_index('ix_auth_sessions_token_hash', ['token_hash'], unique=True)

    op.create_table(
        'books',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(length=500), nullable=False),
        sa.Column('author', sa.String(length=200), nullable=True),
        sa.Column('license', sa.String(length=64), nullable=False),
        sa.Column('redistributable', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('created_by', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )

    with op.batch_alter_table('articles', schema=None) as batch_op:
        batch_op.add_column(sa.Column('book_id', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('order_index', sa.Integer(), nullable=True))
        # ⚠️ 必须显式命名。自动生成的是 None，SQLite 上 downgrade 时
        #    drop_constraint(None) 会直接报错，回滚路径等于不存在。
        batch_op.create_foreign_key(
            'fk_articles_book_id_books', 'books', ['book_id'], ['id'], ondelete='CASCADE'
        )

    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('email', sa.String(length=320), nullable=True))
        batch_op.add_column(sa.Column('password_hash', sa.String(length=255), nullable=True))
        # ⚠️ server_default 不能省。users 表已经有 id=1 那一行（owner 所有历史
        #    会话和标记的归属），加一个 NOT NULL 且无默认值的列，batch 重建表时
        #    这一行会拿到 NULL，直接违反约束、迁移失败。
        batch_op.add_column(
            sa.Column('failed_login_count', sa.Integer(), nullable=False, server_default='0')
        )
        batch_op.add_column(sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True))
        batch_op.create_unique_constraint('uq_users_email', ['email'])


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_constraint('uq_users_email', type_='unique')
        batch_op.drop_column('locked_until')
        batch_op.drop_column('failed_login_count')
        batch_op.drop_column('password_hash')
        batch_op.drop_column('email')

    with op.batch_alter_table('articles', schema=None) as batch_op:
        batch_op.drop_constraint('fk_articles_book_id_books', type_='foreignkey')
        batch_op.drop_column('order_index')
        batch_op.drop_column('book_id')

    op.drop_table('books')

    with op.batch_alter_table('auth_sessions', schema=None) as batch_op:
        batch_op.drop_index('ix_auth_sessions_token_hash')

    op.drop_table('auth_sessions')
    op.drop_table('captcha_challenges')
