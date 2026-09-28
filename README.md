# Foglight

读英文原文，把卡住的地方标下来，读完带着这些标记去和 AI 复盘。

在线使用：https://foglight.rnuxay.xyz —— 不用注册就能完整读一篇。

## 为什么做这个

读纸质书、用电子阅读器时，我们也会划线、写批注，可读完很少回头看。多数时候，这些标注最后只在考试前翻一翻，对一下中文翻译就过去了。

真正卡住你的，往往不是某个词的中文意思：可能是一个没看懂的句式，也可能是一段话，每个词都认识，连起来却说不清在讲什么。看一眼译文，知道了它是什么意思，却没弄明白自己当时为什么没读懂。下次遇到类似的句子，还是会卡。

Foglight 把阅读拆成两步：

1. **读的时候只标记，不查。** 卡住了就点一下，接着往下读，不被词典和翻译打断。
2. **读完一起复盘。** 一键导出原文和全部标记，粘贴给你常用的 AI，从「我当时是怎么理解的」开始讨论。

回头看自己当时的思路，再和 AI 对一遍，比事后查词、看翻译更容易看清问题出在哪里。

## 两种标记

| | 标什么 | 怎么标 |
|---|---|---|
| 陌生词（黄） | 不认识的词 | 点一下这个词，再点一下取消 |
| 模糊处（粉） | 词都认识，意思却没连起来：看不懂的句式、说不清在讲什么的一段 | 先点起点，再点终点，可以跨段落 |

快捷键：`1` 陌生词，`2` 模糊处，`Esc` 取消正在标的范围，`F` 读完。

不用每个生词都标。有些词不懂，也不影响读懂大意，只标真正妨碍理解的地方就够了。

## 读完之后

导出的是一份 Markdown，里面有：

- 全文和出处
- 每一处标记，连同它所在的段落
- 一段复盘指令

把它粘贴到任意 AI 对话里就能开始。复盘指令会让 AI 先从标记里挑出最值得弄懂的几处，问你当时是怎么理解的，再根据你的回答讲解，最后整理出一张最多 5 条的回顾卡。它不会把所有标记逐个讲一遍，也不会整段翻译原文。

应用本身不接入 AI，复盘在你自己选的工具里做。

不登录也能读、能标、能导出。只是这时记录只存在当前浏览器里，清掉浏览器数据就没了；注册之后，记录会存进账号，换设备也能看到。

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
