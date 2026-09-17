"""内容可见性：谁能看到哪些文章和书。**唯一权威，不许在路由里再写一遍。**

规则只有两条：

1. **公开库** = `created_by IS NULL` **且** `redistributable = True`
2. **自己导入的** = `created_by == 当前用户`（不看 redistributable —— 自己读什么都行，
   tech-plan §4.2 的 A 层就是这个意思）

⚠️ 第 1 条里的 `redistributable` 不是装饰，是这个应用开放注册之后唯一的版权闸门。

   2026-09-17 之前这里只判 `created_by IS NULL`，而库里 74 篇 `created_by IS NULL`
   的 curated 文章**全部是 `copyrighted`**。
   也就是说，一旦补上注册接口，第二个注册的人打开首页看到的就是这 74 篇的完整正文。
   隔离没问题、归属没问题，漏的是"能给别人看"和"我自己能看"被当成了同一件事。

   配套的数据迁移把那 74 篇改判给了它们真正的主人（见
   `alembic/versions/*_private_curated_to_owner.py`），所以现在
   **`created_by IS NULL` 就等于"公开库"**，不再是"没人认领的东西"。
   公开库当前是空的 —— 这是事实，不是 bug，见 `docs/public-release.md` §3①。
"""

from __future__ import annotations

from sqlalchemy import and_, or_
from sqlalchemy.sql.elements import ColumnElement

from app.models import Article, Book


def public_articles() -> ColumnElement[bool]:
    """公开库里的散篇文章。未登录的游客只能看到这些。"""
    return and_(Article.created_by.is_(None), Article.redistributable.is_(True))


def visible_articles(user_id: int) -> ColumnElement[bool]:
    """登录用户能看到的：公开库 + 自己导入的。"""
    return or_(public_articles(), Article.created_by == user_id)


def public_books() -> ColumnElement[bool]:
    """公开库里的书。和文章同一套规则。"""
    return and_(Book.created_by.is_(None), Book.redistributable.is_(True))


def visible_books(user_id: int) -> ColumnElement[bool]:
    return or_(public_books(), Book.created_by == user_id)


def article_visible_to(article: Article, user_id: int) -> bool:
    """给已经取出来的实例用的同一条规则。

    不要写成 `article.created_by != user_id` 的简写 —— 那会漏掉
    `created_by IS NULL` 但不可再分发的情况，也就是上面整段说的那个洞。
    """
    if article.created_by is None:
        return bool(article.redistributable)
    return article.created_by == user_id
