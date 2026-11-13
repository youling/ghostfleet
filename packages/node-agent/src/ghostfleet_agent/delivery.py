"""Result-delivery report; persistence belongs only to TaskRepository."""
from dataclasses import dataclass, field
MIN_SEND_WINDOW_S = 0.5

@dataclass
class FlushReport:
    sent: list[str] = field(default_factory=list)
    rejected: list[str] = field(default_factory=list)
    remaining: int = 0
    fatal: bool = False
    stop_outcome: str | None = None
    stop_code: str | None = None
    retry_after_s: float | None = None
    stopped: bool = False
    deadline_hit: bool = False

    @property
    def progressed(self) -> bool:
        return bool(self.sent or self.rejected)
