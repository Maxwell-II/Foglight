"""应用配置。全部从环境变量读，带可用的默认值。"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/ 目录。数据库默认值必须锚在这里，不能用相对路径 ——
# 否则 `python seed/load_seed.py`（从仓库根跑）和 `uvicorn`（从 backend/ 跑）
# 会各自连到不同的 reading.db，症状是灌完种子后接口查不到任何文章。
_BACKEND_DIR = Path(__file__).resolve().parent.parent
_DEFAULT_DB = _BACKEND_DIR / "reading.db"
_DEFAULT_BOOK_ASSETS = _BACKEND_DIR / "book-assets"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # 线上由 docker-compose 注入 sqlite:////data/reading.db（4 个斜杠 = 绝对路径）
    database_url: str = f"sqlite:///{_DEFAULT_DB}"
    book_assets_dir: Path = _DEFAULT_BOOK_ASSETS

    # 允许跨域的前端地址（开发时 Vite 跑在 5173）
    cors_origins: list[str] = ["http://localhost:5173"]

    # —— 登录会话（Wave 3 §1.13）——
    # ⚠️ 本地开发跑在 http，写死 True 会让 cookie 根本发不出去，而且浏览器
    #    不会报任何错，症状是"登录返回 200 但下一个请求就 401"，极难判断。
    #    线上由 deploy/docker-compose.yml 注入 SESSION_COOKIE_SECURE=true。
    session_cookie_secure: bool = False
    session_ttl_days: int = 30

    # —— Google 一键登录（public-release.md §3b）——
    # 两个都配了才算开启（/auth/providers 返回 google=true）。只配一个等于没配：
    # 缺 secret 换不了 token，缺 id 连跳转都拼不出来 —— 与其半开着让人点进去
    # 转一圈再失败，不如直接不显示按钮。
    google_client_id: str = ""
    google_client_secret: str = ""
    # 回调地址。留空时由请求推出：X-Forwarded-Proto（nginx 设成 $scheme）+ Host
    # （nginx 原样转发 $host），线上推出来就是
    # https://read.rnuxay.xyz/api/auth/google/callback。
    # 显式配上更稳：它必须和 Google Console 里登记的**逐字节**一致，
    # 推导值一旦因为反代配置变动差一个字符，Google 就报 redirect_uri_mismatch。
    google_redirect_uri: str = ""

    # —— 发信（注册验证码 / 找回密码，2026-09-28）——
    # 线上由 deploy/docker-compose.yml 从 deploy/.env 注入。两个都配了才真的发信。
    resend_api_key: str = ""
    # 发件人，必须落在 Resend 里验证过的域名上，例如
    # "Foglight <no-reply@mail.rnuxay.xyz>"。域名对不上 Resend 返回 403。
    mail_from: str = ""

    @property
    def google_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def mail_mode(self) -> str:
        """"resend" 真发 / "console" 验证码打进日志 / "off" 邮箱注册和找回不可用。

        没配 key 时靠 session_cookie_secure 区分本地和线上 —— 它本来就是「这是
        https 线上」的开关，线上 compose 显式设了 true，本地默认 false。
        这样两边零配置都是对的：本地不用申请 key 就能走通注册，线上漏配 key 时
        宁可让功能暂不可用，也不把能登录别人账号的验证码写进 docker 日志。
        """
        if self.resend_api_key and self.mail_from:
            return "resend"
        return "off" if self.session_cookie_secure else "console"


settings = Settings()
