"""wave3b fixed book pages and review batches

Revision ID: 9d21b80e3f64
Revises: cff4757d8470
Create Date: 2026-09-06
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "9d21b80e3f64"
down_revision: Union[str, None] = "cff4757d8470"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("books") as batch:
        batch.add_column(
            sa.Column(
                "reading_mode",
                sa.String(32),
                nullable=False,
                server_default="legacy_chapters",
            )
        )
        batch.add_column(sa.Column("content_key", sa.String(128), nullable=True))
        batch.add_column(sa.Column("content_manifest", sa.JSON(), nullable=True))
        batch.create_unique_constraint("uq_books_content_key", ["content_key"])

    op.create_table(
        "book_sections",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("book_id", sa.Integer(), nullable=False),
        sa.Column("order_index", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("part_title", sa.String(500), nullable=True),
        sa.ForeignKeyConstraint(["book_id"], ["books.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("book_id", "order_index", name="uq_book_section_order"),
    )

    with op.batch_alter_table("articles") as batch:
        batch.add_column(sa.Column("book_section_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("book_page_layout", sa.JSON(), nullable=True))
        batch.create_foreign_key(
            "fk_articles_section", "book_sections", ["book_section_id"], ["id"],
            ondelete="CASCADE",
        )
        batch.create_unique_constraint("uq_book_page_order", ["book_id", "order_index"])

    op.create_table(
        "book_reading_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("book_id", sa.Integer(), nullable=False),
        sa.Column("current_session_id", sa.Integer(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["book_id"], ["books.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["current_session_id"], ["reading_sessions.id"], ondelete="SET NULL"
        ),
    )
    op.create_index(
        "uq_active_book_run",
        "book_reading_runs",
        ["user_id", "book_id"],
        unique=True,
        sqlite_where=sa.text("ended_at IS NULL"),
    )

    with op.batch_alter_table("marks") as batch:
        batch.add_column(sa.Column("book_run_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_marks_book_run", "book_reading_runs", ["book_run_id"], ["id"],
            ondelete="SET NULL",
        )

    op.create_table(
        "review_batches",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("book_id", sa.Integer(), nullable=False),
        sa.Column("source_run_id", sa.Integer(), nullable=True),
        sa.Column("request_key", sa.String(64), nullable=False),
        sa.Column("markdown_snapshot", sa.Text(), nullable=False),
        sa.Column("page_numbers", sa.JSON(), nullable=False),
        sa.Column("mark_count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("handled_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["book_id"], ["books.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["source_run_id"], ["book_reading_runs.id"], ondelete="SET NULL"
        ),
        sa.UniqueConstraint("user_id", "request_key", name="uq_review_request"),
    )
    op.create_table(
        "review_batch_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("batch_id", sa.Integer(), nullable=False),
        sa.Column("mark_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["batch_id"], ["review_batches.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["mark_id"], ["marks.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("batch_id", "mark_id", name="uq_batch_mark"),
    )


def downgrade() -> None:
    op.drop_table("review_batch_items")
    op.drop_table("review_batches")
    with op.batch_alter_table("marks") as batch:
        batch.drop_constraint("fk_marks_book_run", type_="foreignkey")
        batch.drop_column("book_run_id")
    op.drop_index("uq_active_book_run", table_name="book_reading_runs")
    op.drop_table("book_reading_runs")
    with op.batch_alter_table("articles") as batch:
        batch.drop_constraint("uq_book_page_order", type_="unique")
        batch.drop_constraint("fk_articles_section", type_="foreignkey")
        batch.drop_column("book_page_layout")
        batch.drop_column("book_section_id")
    op.drop_table("book_sections")
    with op.batch_alter_table("books") as batch:
        batch.drop_constraint("uq_books_content_key", type_="unique")
        batch.drop_column("content_manifest")
        batch.drop_column("content_key")
        batch.drop_column("reading_mode")
