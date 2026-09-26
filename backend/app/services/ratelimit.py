"""登录 / 注册 / 验证码限流 + 单用户写入配额，状态放在进程内存里。

为什么可以放内存（而不是数据库）：线上只有**一个** uvicorn 进程 ——
`backend/Dockerfile` 的 `--workers 1` 是硬约束（VPS 只有 698Mi 可用，
见那里的注释），`deploy/docker-compose.yml` 也只起一个 api 容器。
单进程下内存计数就是全局计数。

⚠️ 哪天改成多 worker / 多容器，这里必须搬进数据库或共享存储 —— 否则每个进程
   各数各的，上限等于乘了 worker 数，而且**不会有任何报错**。

代价是重启进程会清空计数。可接受：重启本来就少见，攻击者也没法触发重启；
反过来它还是被误锁时的人工解锁手段（`docker compose restart api`）。

两种结构：

- `SlidingWindowLimiter`：某个键在最近 N 秒里发生了几次。单 IP 的全局上限
  （跨所有账号的登录失败、注册次数、取验证码）和单用户的写入配额（deps.py）用它。
  `add(key, n)` 一次记 n 次：游客标记迁移一个请求写几百行，按行数扣。
- `LoginFailureTracker`：(email, IP) 这一对的连续失败次数 + 锁定截止时间。
  语义照搬 Wave 3 按账号锁的那一套（3 次要验证码、8 次锁 15 分钟、锁过期清零、
  成功清零），只是键从「账号」换成了「账号 × IP」——
  攻击者在他自己的 IP 上把 (你的邮箱, 他的 IP) 锁住，锁不到你从你的 IP 登录。

时间用 `time.monotonic()`：不受系统改时间影响；只在进程内比较，不需要墙钟。
所有方法都加锁：FastAPI 的同步路由跑在线程池里，会并发进来。
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from collections.abc import Callable, Hashable
from dataclasses import dataclass

Clock = Callable[[], float]

# 键的数量上限。键由攻击者控制（任意 email × 任意 IP），不设上限等于让人随便
# 往内存里塞东西，而容器 mem_limit 只有 256m。超了先清过期的，还超就丢最旧的。
_MAX_KEYS = 20_000


class SlidingWindowLimiter:
    """最近 `window_seconds` 秒内，每个键最多 `limit` 次。"""

    def __init__(self, limit: int, window_seconds: float, clock: Clock = time.monotonic):
        self.limit = limit
        self.window_seconds = window_seconds
        self.clock = clock
        self._hits: dict[Hashable, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: Hashable, now: float) -> deque[float] | None:
        hits = self._hits.get(key)
        if hits is None:
            return None
        cutoff = now - self.window_seconds
        while hits and hits[0] <= cutoff:
            hits.popleft()
        if not hits:
            del self._hits[key]
            return None
        return hits

    def count(self, key: Hashable) -> int:
        with self._lock:
            hits = self._prune(key, self.clock())
            return len(hits) if hits else 0

    def is_limited(self, key: Hashable, n: int = 1) -> bool:
        """再记 `n` 次会不会超。n 默认 1，即「已经满了没有」。"""
        return self.count(key) + n > self.limit

    def retry_after(self, key: Hashable, n: int = 1) -> int:
        """还要几秒才腾得出 `n` 个名额。给 429 的 Retry-After 头用。

        n 比整个上限还大时永远腾不出来，返回整个窗口长度 —— 调用方该拆小了再来。
        """
        with self._lock:
            now = self.clock()
            hits = self._prune(key, now)
            held = len(hits) if hits else 0
            # 要等最早的 k 次滑出窗口，剩下的才放得下 n 次
            k = held - self.limit + n
            if k <= 0:
                return 0
            if n > self.limit or hits is None:
                return max(1, math.ceil(self.window_seconds))
            return max(1, math.ceil(hits[k - 1] + self.window_seconds - now))

    def add(self, key: Hashable, n: int = 1) -> None:
        with self._lock:
            now = self.clock()
            hits = self._prune(key, now)
            if hits is None:
                if len(self._hits) >= _MAX_KEYS:
                    self._evict(now)
                hits = self._hits[key] = deque()
            hits.extend([now] * n)

    def _evict(self, now: float) -> None:
        for key in list(self._hits):
            self._prune(key, now)
        while len(self._hits) >= _MAX_KEYS:
            # dict 保持插入顺序：第一个就是最早出现的键
            del self._hits[next(iter(self._hits))]

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


@dataclass
class _PairState:
    failures: int = 0
    locked_until: float | None = None
    last_seen: float = 0.0


class LoginFailureTracker:
    """(email, IP) 的连续失败计数与锁定。

    `idle_seconds`：一对键多久没有新失败就整条丢掉。旧实现存在数据库里、
    永不过期（只有成功或锁到期才清零）；放进内存之后必须有个过期，
    否则攻击者换着邮箱试就能让字典一直长。取 24 小时 —— 比锁定时长长得多，
    不会让「连错几次、隔一会儿再错」的人绕过验证码门槛。
    """

    def __init__(
        self,
        *,
        captcha_after: int,
        lock_after: int,
        lock_seconds: float,
        idle_seconds: float = 24 * 60 * 60,
        clock: Clock = time.monotonic,
    ):
        self.captcha_after = captcha_after
        self.lock_after = lock_after
        self.lock_seconds = lock_seconds
        self.idle_seconds = idle_seconds
        self.clock = clock
        self._state: dict[Hashable, _PairState] = {}
        self._lock = threading.Lock()

    def _get(self, key: Hashable, now: float) -> _PairState | None:
        state = self._state.get(key)
        if state is None:
            return None
        if state.locked_until is not None and state.locked_until <= now:
            # 锁已经过期：整条清零重来。不清零的话第 9 次失败会立刻再次触发
            # 锁定（9 >= 8），等于一旦锁过一次就再也解不开。
            del self._state[key]
            return None
        if state.locked_until is None and now - state.last_seen > self.idle_seconds:
            del self._state[key]
            return None
        return state

    def locked_for(self, key: Hashable) -> int:
        """剩余锁定秒数，未锁定为 0。"""
        with self._lock:
            now = self.clock()
            state = self._get(key, now)
            if state is None or state.locked_until is None:
                return 0
            return max(1, math.ceil(state.locked_until - now))

    def failures(self, key: Hashable) -> int:
        with self._lock:
            state = self._get(key, self.clock())
            return state.failures if state else 0

    def needs_captcha(self, key: Hashable) -> bool:
        return self.failures(key) >= self.captcha_after

    def record_failure(self, key: Hashable) -> None:
        with self._lock:
            now = self.clock()
            state = self._get(key, now)
            if state is None:
                if len(self._state) >= _MAX_KEYS:
                    self._evict(now)
                state = self._state[key] = _PairState()
            state.failures += 1
            state.last_seen = now
            if state.failures >= self.lock_after:
                state.locked_until = now + self.lock_seconds

    def clear(self, key: Hashable) -> None:
        with self._lock:
            self._state.pop(key, None)

    def _evict(self, now: float) -> None:
        for key in list(self._state):
            self._get(key, now)
        while len(self._state) >= _MAX_KEYS:
            del self._state[next(iter(self._state))]

    def reset(self) -> None:
        with self._lock:
            self._state.clear()
