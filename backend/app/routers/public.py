"""游客接口：不需要登录（user-flows.md §6，路径 1）。

「陌生人读完一篇、导出复盘素材，全程不登录」是产品的核心承诺（user-flows.md §0）。
这三条路由就是它的后端。

⚠️ 公开集合只有一个定义：`visibility.public_articles()`。这里**不许**另写一遍
   `created_by IS NULL AND redistributable` —— 那条 redistributable 是开放注册之后
   唯一的版权闸门，两处各写一份，改规则时漏掉一处就是把有版权的正文发给所有人。

游客没有 user_id，所以这里一概不挂会话派生值（isRead / resumeSessionId …）：
ArticleSummary 里它们的默认值（false / null / 0）就是「这个人没读过」的正确答案。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import or_

from app.deps import DbSession
from app.models import Article, Book, BookReadingMode
from app.schemas import ArticleDetail, ArticleSummary, PublicExportRequest
from app.services.export import build_article_markdown
from app.services.mark_positions import first_position_error
from app.visibility import public_articles

router = APIRouter(tags=["public"])


def _get_public_article(db: DbSession, article_id: int) -> Article:
    article = db.query(Article).filter(Article.id == article_id, public_articles()).one_or_none()
    if article is None:
        # 不存在和不公开一律 404：返回 403 等于告诉人「这个 id 上有篇你看不到的文章」
        raise HTTPException(status_code=404, detail="文章不存在")
    return article


@router.get("/public/articles", response_model=list[ArticleSummary])
def list_public_articles(db: DbSession) -> list[Article]:
    # 和 GET /articles 同一个形状、同一个排除：分页书的书页不进散篇列表
    # （它们得从书的目录进，单独拎出来是一页没头没尾的正文）
    return (
        db.query(Article)
        .outerjoin(Book, Book.id == Article.book_id)
        .filter(public_articles())
        .filter(or_(Book.id.is_(None), Book.reading_mode != BookReadingMode.FIXED_PAGES))
        .order_by(Article.created_at.desc())
        .all()
    )


@router.get("/public/articles/{article_id}", response_model=ArticleDetail)
def get_public_article(article_id: int, db: DbSession) -> Article:
    article = _get_public_article(db, article_id)
    # 书内翻页（上一页 / 下一页、阅读批次）全挂在登录接口上，游客阅读器用不到，
    # 这里不算 bookContext —— 给了他也点不动
    article.book_context = None
    return article


@router.post("/public/export")
def export_public(payload: PublicExportRequest, db: DbSession) -> Response:
    """游客导出：和 GET /sessions/{id}/export 调的是同一个 build_article_markdown
    → build_markdown，字节级一致（test_public.py 锁着）。

    服务端不存任何东西：标记在游客的 localStorage 里，这里只负责渲染。
    """
    article = _get_public_article(db, payload.article_id)

    if any(mark.book_run_id is not None for mark in payload.marks):
        # 阅读批次是登录用户读分页书时才有的东西，游客不可能有
        raise HTTPException(status_code=422, detail="游客标记不能带阅读批次")
    error = first_position_error(article.body_paragraphs, payload.marks)
    if error:
        raise HTTPException(status_code=422, detail=error)

    markdown = build_article_markdown(article, payload.marks)
    return Response(content=markdown, media_type="text/markdown; charset=utf-8")
