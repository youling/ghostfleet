"""TransitionVerifier: timeout/polling verification of page/app transitions.

Does not raise; a timeout returns an explicit failure result so a caller can
report "target not reached" instead of treating an issued action as success.
``sleep_fn`` is injectable for deterministic tests.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass


@dataclass
class VerifyResult:
    ok: bool
    attempts: int
    elapsed_ms: int
    reason: str | None = None


class TransitionVerifier:
    """Poll until a predicate holds or the deadline passes."""

    def __init__(
        self,
        timeout: float = 15.0,
        poll_interval: float = 0.5,
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        self.timeout = timeout
        self.poll_interval = poll_interval
        self._sleep = sleep_fn

    def wait_for(
        self,
        predicate: Callable[[], bool],
        *,
        timeout: float | None = None,
        poll_interval: float | None = None,
        description: str = "transition",
    ) -> VerifyResult:
        timeout = self.timeout if timeout is None else timeout
        poll_interval = self.poll_interval if poll_interval is None else poll_interval
        start = time.monotonic()
        deadline = start + timeout
        attempts = 0
        last_error: str | None = None
        while True:
            try:
                if predicate():
                    elapsed_ms = int((time.monotonic() - start) * 1000)
                    return VerifyResult(ok=True, attempts=attempts, elapsed_ms=elapsed_ms)
            except Exception as e:  # noqa: BLE001
                last_error = str(e)
            attempts += 1
            if time.monotonic() >= deadline:
                break
            self._sleep(poll_interval)
        elapsed_ms = int((time.monotonic() - start) * 1000)
        reason = last_error or f"{description} not satisfied within {timeout:.1f}s"
        return VerifyResult(ok=False, attempts=attempts, elapsed_ms=elapsed_ms, reason=reason)