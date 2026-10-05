"""Secret-safe audit trace and log baseline.

Invariants: any field that can reach a trace/log must never contain page
text, verification codes, account credentials, card numbers, transaction
details or other secrets. Page content only ever appears as a fingerprint.
``input_text`` payloads are secret by definition and never stored here.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field

# Redaction patterns covering common secret shapes. These are generic
# mechanism patterns (secret hygiene), not consumer business data.
_SENSITIVE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?i)(password|passwd|pwd)\s*[:=]\s*\S+"), r"\1=<redacted>"),
    (re.compile(r"(?i)(token|api[-_]?key|secret|cookie)\s*[:=]\s*\S+"), r"\1=<redacted>"),
    (re.compile(r"(?i)(验证码|短信验证码|动态验证码)\s*[:=：]\s*\S+"), r"\1=<redacted>"),
    (re.compile(r"\b\d{4,16}\b"), "<redacted>"),
    (re.compile(r"(?i)\bcvv\b"), "<redacted>"),
]


def log_safe(text: str | None) -> str | None:
    """Redact a string before it enters a trace/log/error field."""
    if not text:
        return text
    for pattern, repl in _SENSITIVE_PATTERNS:
        text = pattern.sub(repl, text)
    return text


@dataclass
class StepTrace:
    """Audit record for a single action step; every field is safe to log."""

    index: int
    action: str
    decision: str  # auto / human_required / fail_closed
    ok: bool
    before_fingerprint: str | None = None
    after_fingerprint: str | None = None
    error: str | None = None  # redacted; never contains page text
    verify_ok: bool | None = None
    verify_attempts: int = 0
    human_reason: str | None = None  # redacted
    hook_error: str | None = None  # redacted; set when a business hook raised

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "action": self.action,
            "decision": self.decision,
            "ok": self.ok,
            "before_fingerprint": self.before_fingerprint,
            "after_fingerprint": self.after_fingerprint,
            "error": self.error,
            "verify_ok": self.verify_ok,
            "verify_attempts": self.verify_attempts,
            "human_reason": self.human_reason,
            "hook_error": self.hook_error,
        }


@dataclass
class RunTrace:
    """Full audit trace for an execution: safe StepTrace sequence + metadata."""

    run_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    steps: list[StepTrace] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"run_id": self.run_id, "steps": [s.to_dict() for s in self.steps]}