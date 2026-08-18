FROM python:3.12-slim

WORKDIR /app

# 分层：先装依赖，改业务代码时这一层能从缓存命中，不用重装依赖。
COPY pyproject.toml ./
RUN pip install --no-cache-dir -e .

# alembic/ 和 alembic.ini 必须进镜像——启动时要跑迁移。
COPY app/ ./app/
COPY alembic/ ./alembic/
COPY alembic.ini ./

EXPOSE 8000

# --workers 1 是硬约束：每多一个 worker 就多一整份 Python 进程内存
# （见 docs/architecture.md §4.5，VPS 只有 698Mi 可用且 swap 已在使用）。
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1"]
