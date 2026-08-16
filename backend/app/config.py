"""应用配置。全部从环境变量读，带可用的默认值。"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # 本地开发默认落在 backend/reading.db；
    # 线上由 docker-compose 注入 sqlite:////data/reading.db（4 个斜杠 = 绝对路径）
    database_url: str = "sqlite:///./reading.db"

    # Phase 1 是单用户，没有登录。这个 id 由 deps.get_current_user() 使用。
    # Phase 3 接入真实认证后此项作废，见 deps.py 的说明。
    single_user_id: int = 1

    # 允许跨域的前端地址（开发时 Vite 跑在 5173）
    cors_origins: list[str] = ["http://localhost:5173"]


settings = Settings()
