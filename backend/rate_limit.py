"""In-memory sliding-window rate limits for the sign-in endpoints.

The API runs as one uvicorn process, so a per-process table is enough; counters reset on restart.
"""
import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

_hits = defaultdict(deque)
_lock = threading.Lock()


def client_ip(request: Request) -> str:
    # Requests reach the API through Cloudflare's tunnel and nginx, which set these headers.
    for header in ('cf-connecting-ip', 'x-real-ip'):
        value = request.headers.get(header, '').strip()
        if value:
            return value
    return request.client.host if request.client else 'unknown'


def check(scope: str, key: str, limit: int, window: float) -> None:
    """Raises 429 once `key` used `scope` more than `limit` times within `window` seconds."""
    now = time.monotonic()
    with _lock:
        hits = _hits[(scope, key)]
        while hits and now - hits[0] > window:
            hits.popleft()
        if len(hits) >= limit:
            retry = max(1, int(window - (now - hits[0])) + 1)
            raise HTTPException(429, 'Too many attempts. Try again later.', headers={'Retry-After': str(retry)})
        hits.append(now)
        if len(_hits) > 50000:  # forget idle keys so the table cannot grow without bound
            for stale in [k for k, v in _hits.items() if not v or now - v[-1] > 3600]:
                del _hits[stale]


def reset() -> None:
    with _lock:
        _hits.clear()
