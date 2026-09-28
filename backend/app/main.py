"""FastAPI 应用入口。

路由在文件末尾统一挂载，每个 router 管自己的路径前缀以外的一切 ——
新增接口只改对应的 app/routers/*.py，不用动这个文件。
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings

app = FastAPI(
    title="reading-saas",
    description="短阅读标记器后端",
    version="0.1.0",
)

# 开发时前端跑在 5173，和后端不同源，需要放行。
# 线上前后端同域（nginx 统一入口），这条不生效也无妨。
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    """部署验活用。nginx 和 docker healthcheck 都可以打这个。"""
    return {"status": "ok"}


# —— 路由挂载 ——
from app.routers import articles, auth, books, marks, public, sessions  # noqa: E402

app.include_router(articles.router, prefix="/api")
app.include_router(sessions.router, prefix="/api")
app.include_router(marks.router, prefix="/api")
# 书籍和认证各自一个 router：两块功能互不 import，改一边不会碰到另一边。
app.include_router(books.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
# 游客接口（不需要登录）。单独一个 router，公开面一眼看得全
app.include_router(public.router, prefix="/api")
