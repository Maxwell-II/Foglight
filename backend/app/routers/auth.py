"""认证路由（Wave 3 A1）。

⚠️ 这是规划方建的空壳：main.py 已经把它挂上了，登录线的执行 agent 只需要在
这里填内容，**不要去改 main.py** —— 那是书籍线也会碰的文件，改它就撞车。

要实现的接口见 docs/work-packets-wave3.md 第 3 节 A1。
请求 / 响应模型直接定义在本文件里，**不要写进 schemas.py** —— 那个文件归书籍线。
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(tags=["auth"])
