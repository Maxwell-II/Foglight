"""FastAPI 应用入口。

路由挂载留了位置但暂不引入 —— app/routers/ 由其他任务包并行开发中，
它们完成后在下面的「路由挂载」处接上。
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
from app.routers import articles, auth, books, marks, sessions  # noqa: E402

app.include_router(articles.router, prefix="/api")
app.include_router(sessions.router, prefix="/api")
app.include_router(marks.router, prefix="/api")
# Wave 3：两个空壳已经挂好，books.py 和 auth.py 由各自的任务包填内容。
# 这样 main.py 就不再是两条线的共享文件 —— 谁都不用改它。
app.include_router(books.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
