"""In-memory sliding-window rate limits for the sign-in endpoints.

The API runs as one uvicorn process, so a per-process table is enough; counters reset on restart.
The table holds at most MAX_KEYS keys: the least recently used ones are forgotten first.
"""
import threading
import time
from collections import OrderedDict, deque

from fastapi import HTTPException, Request

MAX_KEYS = 20000
_hits = OrderedDict()  # (scope, key) -> deque of hit times, least recently used first
_lock = threading.Lock()


def client_ip(request: Request) -> str:
    """nginx sets X-Real-IP (the tunnel's CF-Connecting-IP only when the request came through it)."""
    value = request.headers.get('x-real-ip', '').strip()
    if value:
        return value
    return request.client.host if request.client else 'unknown'


def check(scope: str, key: str, limit: int, window: float) -> None:
    """Raises 429 once `key` used `scope` more than `limit` times within `window` seconds."""
    now = time.monotonic()
    with _lock:
        hits = _hits.get((scope, key))
        if hits is None:
            hits = _hits[(scope, key)] = deque()
        else:
            _hits.move_to_end((scope, key))
        while hits and now - hits[0] > window:
            hits.popleft()
        if len(hits) >= limit:
            retry = max(1, int(window - (now - hits[0])) + 1)
            raise HTTPException(429, 'Too many attempts. Try again later.', headers={'Retry-After': str(retry)})
        hits.append(now)
        while len(_hits) > MAX_KEYS:
            _hits.popitem(last=False)


def reset() -> None:
    with _lock:
        _hits.clear()
