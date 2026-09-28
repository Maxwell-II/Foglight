# Foglight（雾灯）

读英文原文，读完立刻复盘。

遇到不认识的词或没读懂的段落，先标记下来，不打断阅读。读完后把原文、标记和复盘提示一起导出，
交给你常用的 AI 或 Agent，集中梳理真正没读懂的地方。

在线使用：https://foglight.rnuxay.xyz —— 不用注册就能完整读一篇。

## 两支笔

| | 标什么 | 怎么标 |
|---|---|---|
| 黄笔 | 不认识的词 | 点一下单词 |
| 粉笔 | 词都认识、意思没连起来的地方 | 点起点，再点终点，可以跨段落 |

快捷键：`1` 黄笔，`2` 粉笔，`Esc` 取消当前范围。

读完后导出一份 Markdown，里面有原文、你的标记和一段复盘指令，粘贴到任意对话里就能开始。
应用本身不接 AI —— 复盘在你自己选的工具里做。

## 本地运行

需要 Python 3.12+ 和 Node.js。

```bash
# 后端（端口必须是 8001，前端开发服务器把 /api 代理到这里）
cd backend
python -m venv .venv
.venv/Scripts/pip install -e .          # macOS / Linux：.venv/bin/pip
.venv/Scripts/alembic upgrade head
.venv/Scripts/python -m uvicorn app.main:app --port 8001

# 前端（另开一个终端）
cd frontend
npm install
npm run dev                              # http://localhost:5173
```

灌入公开文章库（在仓库根目录）：

```bash
PYTHONPATH=backend backend/.venv/Scripts/python seed/load_seed.py --manifest seed/manifest-public.json
```

配置项见 `backend/app/config.py`，都从环境变量读取，默认值可以直接用于本地开发。
Google 登录是可选的：`GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET` 两个都配置才会显示按钮。
邮箱注册和找回密码要收邮件验证码，发信走 [Resend](https://resend.com)（`RESEND_API_KEY` + `MAIL_FROM`）；
本地不配置时，验证码会打印在后端日志里，照样能走完注册。

## 目录

```
backend/   FastAPI + SQLite，alembic 管迁移
frontend/  React + Vite + TypeScript
seed/      公开文章库：正文、清单和导入脚本
```

## 内容来源

公开文章库来自 [zenhabits.net](https://zenhabits.net)（Leo Babauta），作者已声明放弃版权（[Uncopyright](https://zenhabits.net/uncopyright/)）。
收录时去掉了站内推广段落。
