"""书籍路由（Wave 3 B1 / B2）。

⚠️ 这是规划方建的空壳：main.py 已经把它挂上了，书籍线的执行 agent 只需要在
这里填内容，**不要去改 main.py** —— 那是登录线也会碰的文件，改它就撞车。

要实现的接口见 docs/work-packets-wave3.md 第 3 节 B1 / B2。
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(tags=["books"])
