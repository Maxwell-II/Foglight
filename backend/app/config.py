"""应用配置。全部从环境变量读，带可用的默认值。"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/ 目录。数据库默认值必须锚在这里，不能用相对路径 ——
# 否则 `python seed/load_seed.py`（从仓库根跑）和 `uvicorn`（从 backend/ 跑）
# 会各自连到不同的 reading.db，症状是灌完种子后接口查不到任何文章。
_BACKEND_DIR = Path(__file__).resolve().parent.parent
_DEFAULT_DB = _BACKEND_DIR / "reading.db"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # 线上由 docker-compose 注入 sqlite:////data/reading.db（4 个斜杠 = 绝对路径）
    database_url: str = f"sqlite:///{_DEFAULT_DB}"

    # Phase 1 是单用户，没有登录。这个 id 由 deps.get_current_user() 使用。
    # Phase 3 接入真实认证后此项作废，见 deps.py 的说明。
    single_user_id: int = 1

    # 允许跨域的前端地址（开发时 Vite 跑在 5173）
    cors_origins: list[str] = ["http://localhost:5173"]


settings = Settings()
