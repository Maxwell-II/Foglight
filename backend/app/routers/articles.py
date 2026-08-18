"""文章相关路由：列表 / 详情 / 粘贴导入 / epub 导入。

URL 导入不在这里实现——MVP 明确排除（architecture.md §7 / §5 标了 [Phase 2]）。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy import or_

from app.deps import CurrentUser, DbSession
from app.models import Article, License, SourceType
from app.schemas import (
    ArticleDetail,
    ArticleImportText,
    ArticlePreviewRequest,
    ArticlePreviewResponse,
    ArticleSummary,
    EpubImportCandidate,
)
from app.services.epub import parse_epub
from app.services.normalize import normalize
from app.services.tokenize import tokenize

router = APIRouter(tags=["articles"])


def _est_minutes(word_count: int) -> int:
    """200 词/分钟，和 seed/extract_samples.py 的估算口径保持一致。"""
    return max(1, round(word_count / 200))


def _get_visible_article(db: DbSession, article_id: int, user_id: int) -> Article:
    """curated（created_by 为空）对所有人可见；用户自己导入的只对自己可见。"""
    article = db.get(Article, article_id)
    if article is None or (article.created_by is not None and article.created_by != user_id):
        raise HTTPException(status_code=404, detail="文章不存在")
    return article


@router.get("/articles", response_model=list[ArticleSummary])
def list_articles(db: DbSession, user: CurrentUser) -> list[Article]:
    return (
        db.query(Article)
        .filter(or_(Article.created_by.is_(None), Article.created_by == user.id))
        .order_by(Article.created_at.desc())
        .all()
    )


@router.get("/articles/{article_id}", response_model=ArticleDetail)
def get_article(article_id: int, db: DbSession, user: CurrentUser) -> Article:
    return _get_visible_article(db, article_id, user.id)


@router.post("/articles/preview/text", response_model=ArticlePreviewResponse)
def preview_text(payload: ArticlePreviewRequest) -> ArticlePreviewResponse:
    """粘贴导入前的预览：分段、计数、篇幅档位。不入库、不写数据库。"""
    body_paragraphs = tokenize(normalize(payload.text, paragraph_mode=payload.paragraph_mode))
    word_count = sum(len(p) for p in body_paragraphs)
    # 借用 Article.level 这一个唯一实现（§1.7），不额外造一份阈值判断——
    # 这个 Article 实例只在内存里算完这一次就丢弃，从不 add 进 session。
    level = Article(word_count=word_count).level
    return ArticlePreviewResponse(
        paragraph_count=len(body_paragraphs),
        word_count=word_count,
        level=level,
        first_paragraphs=[" ".join(p) for p in body_paragraphs[:3]],
    )


@router.post("/articles/import/text", response_model=ArticleDetail, status_code=201)
def import_text(payload: ArticleImportText, db: DbSession, user: CurrentUser) -> Article:
    body_paragraphs = tokenize(normalize(payload.text, paragraph_mode=payload.paragraph_mode))
    word_count = sum(len(p) for p in body_paragraphs)

    article = Article(
        title=payload.title,
        author=payload.author,
        source_type=SourceType.USER_TEXT,
        source_name=payload.source_name,
        license=payload.license,
        redistributable=payload.redistributable,
        body_paragraphs=body_paragraphs,
        word_count=word_count,
        est_minutes=_est_minutes(word_count),
        topics=payload.topics,
        created_by=user.id,
    )
    db.add(article)
    db.commit()
    db.refresh(article)
    return article


@router.post("/articles/import/epub")
async def import_epub(
    db: DbSession,
    user: CurrentUser,
    file: Annotated[UploadFile, File()],
    titles: Annotated[list[str], Form()] = [],  # noqa: B006 - FastAPI Form 需要可变默认值来识别重复字段
):
    """两段式：不传 titles 只探测候选片段，传了才真正入库。"""
    data = await file.read()
    segments = parse_epub(data)

    if not titles:
        candidates = [
            EpubImportCandidate(title=seg.title, word_count=seg.word_count) for seg in segments
        ]
        return JSONResponse(
            status_code=200, content=[c.model_dump(by_alias=True) for c in candidates]
        )

    wanted = set(titles)
    source_name = file.filename.rsplit(".", 1)[0] if file.filename else None

    imported: list[Article] = []
    for seg in segments:
        if seg.title not in wanted:
            continue
        body_paragraphs = tokenize("\n\n".join(seg.paragraphs))
        word_count = sum(len(p) for p in body_paragraphs)
        article = Article(
            title=seg.title,
            author=None,
            source_type=SourceType.EPUB,
            source_name=source_name,
            license=License.COPYRIGHTED,
            redistributable=False,
            body_paragraphs=body_paragraphs,
            word_count=word_count,
            est_minutes=_est_minutes(word_count),
            topics=[],
            created_by=user.id,
        )
        db.add(article)
        imported.append(article)

    db.commit()
    for article in imported:
        db.refresh(article)

    return JSONResponse(
        status_code=201,
        content=[ArticleDetail.model_validate(a).model_dump(mode="json", by_alias=True) for a in imported],
    )
