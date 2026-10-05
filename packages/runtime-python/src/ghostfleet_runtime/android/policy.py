"""Action risk classification: fail-closed Policy mechanism.

The platform freezes the *minimum* cross-project safety line and provides
explicit injection points for consumer policy data:

- ``allowed_packages`` (consumer package whitelist, injected);
- ``high_risk_keywords`` / ``high_risk_matcher`` (consumer high-risk boundary
  matcher, injected; the platform default is empty so no consumer financial
  keyword table is baked in);
- ``max_text_len`` and ``strict_page_gating`` (consumer strictness, injected).

Classification invariants:
- an ordinary login/lockscreen text is never HUMAN_REQUIRED by itself;
- classification is by "high-risk / strong-auth / irreversible" semantics,
  not keyword veto;
- malformed fields (type/domain) fail closed (never raise inside Policy);
- ``input_text`` content is a secret payload and never enters reason/error;
  OTP/CAPTCHA/biometrics/payment password/trade confirmation/final-commit
  pages must be HUMAN_REQUIRED once the consumer injects that boundary.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Callable

from ghostfleet_runtime.android.actions import (
    COORD_ACTIONS,
    INTERACTION_ACTIONS,
    KNOWN_ACTIONS,
    PACKAGE_ACTIONS,
    READ_ACTIONS,
    REQUEST_HUMAN_ACTION,
    RETREAT_ACTIONS,
    SWIPE_ACTIONS,
    TEXT_ACTIONS,
)
from ghostfleet_runtime.android.schemas import ActionRequest

logger = logging.getLogger(__name__)


class ActionDecision(str, Enum):
    AUTO = "auto"
    HUMAN_REQUIRED = "human_required"
    FAIL_CLOSED = "fail_closed"


@dataclass(frozen=True)
class PolicyConfig:
    """Injected consumer policy data. Defaults carry no consumer business data.

    ``allowed_packages`` and ``high_risk_keywords`` are empty by default: a
    platform default configuration cannot grant a package or trigger a
    high-risk gate on consumer-specific data.
    """

    allowed_packages: frozenset[str] = frozenset()
    high_risk_keywords: tuple[str, ...] = ()
    high_risk_matcher: Callable[[str], bool] | None = None
    max_text_len: int = 500
    strict_page_gating: bool = True


class Policy:
    """Classify an ActionRequest + current page texts to a decision.

    ``screen_size`` is the known display size. Per the platform minimum
    safety line, coordinate actions fail closed when the size is unknown
    (a size must be known before coordinates can be proven in-bounds).
    """

    def __init__(
        self,
        config: PolicyConfig | None = None,
        screen_size: tuple[int, int] | None = None,
    ) -> None:
        self._config = config or PolicyConfig()
        self._screen_size = screen_size

    # ---------- decision ----------

    def decide_action(
        self, request: ActionRequest, page_texts: list[str] | None = None
    ) -> tuple[ActionDecision, str | None]:
        action = self._str_field(request.action, "action")
        if action is None:
            return ActionDecision.FAIL_CLOSED, "action must be a string"
        if action not in KNOWN_ACTIONS:
            # value-free: never echo the raw untrusted action value.
            return ActionDecision.FAIL_CLOSED, "unknown action"

        if action == REQUEST_HUMAN_ACTION:
            return ActionDecision.HUMAN_REQUIRED, (
                "request_human: explicit human checkpoint"
            )

        # ---- parameter validation (fail-closed) ----
        if action in PACKAGE_ACTIONS:
            package = self._str_field(request.package, "package")
            if package is None:
                return ActionDecision.FAIL_CLOSED, "package required"
            if package not in self._config.allowed_packages:
                # value-free: never echo the submitted package name.
                return ActionDecision.FAIL_CLOSED, "package not in whitelist"

        if action in TEXT_ACTIONS:
            text = self._text_field(request.text, "text")
            if text is None:
                return ActionDecision.FAIL_CLOSED, "text required"
            if action == "tap_text":
                # tap_text targets visible page text: a high-risk target
                # requires a human. input_text payload is secret and is
                # never keyword-matched or echoed.
                risk = self._is_high_risk(text)
                if risk is None:
                    return ActionDecision.FAIL_CLOSED, "risk evaluation failed"
                if risk:
                    return ActionDecision.HUMAN_REQUIRED, "tap target is high-risk"

        if action in COORD_ACTIONS:
            if request.x is None or request.y is None:
                return ActionDecision.FAIL_CLOSED, "x/y required"
            err = self._check_point(request.x, request.y)
            if err:
                return ActionDecision.FAIL_CLOSED, err

        if action in SWIPE_ACTIONS:
            for name in ("fx", "fy", "tx", "ty"):
                if getattr(request, name) is None:
                    return ActionDecision.FAIL_CLOSED, f"{name} required"
            for x, y in (
                (request.fx, request.fy),
                (request.tx, request.ty),
            ):
                err = self._check_point(x, y)
                if err:
                    return ActionDecision.FAIL_CLOSED, err
            err = self._check_duration(request.duration_ms)
            if err:
                return ActionDecision.FAIL_CLOSED, err

        # ---- read-only actions are always AUTO ----
        if action in READ_ACTIONS:
            return ActionDecision.AUTO, None

        # ---- interaction from inside a high-risk boundary page ----
        if (
            self._config.strict_page_gating
            and action in INTERACTION_ACTIONS
            and action not in RETREAT_ACTIONS
        ):
            page_risk = self._page_is_high_risk(page_texts)
            if page_risk is None:
                return ActionDecision.FAIL_CLOSED, "risk evaluation failed"
            if page_risk:
                return ActionDecision.HUMAN_REQUIRED, "current page is high-risk boundary"

        return ActionDecision.AUTO, None

    # ---------- field type/domain checks (malformed -> FAIL_CLOSED) ----------

    @staticmethod
    def _str_field(value: object, name: str) -> str | None:
        """Field must be a str. Returns None when the type is invalid."""
        if value is None:
            return None
        if not isinstance(value, str):
            return None
        return value

    def _text_field(self, value: object, name: str) -> str | None:
        """Text field: non-empty str within the injected length limit."""
        if value is None:
            return None
        if not isinstance(value, str):
            return None
        if not value.strip():
            return None
        if len(value) > self._config.max_text_len:
            return None
        return value

    @staticmethod
    def _require_int(value: object) -> int | None:
        """Coord/duration fields: int or a pure-integer str."""
        if value is None:
            return None
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            try:
                return int(value)
            except ValueError:
                return None
        return None

    def _check_point(self, x: object, y: object) -> str | None:
        xi = self._require_int(x)
        yi = self._require_int(y)
        if xi is None or yi is None:
            return "coords must be integers"
        if xi < 0 or yi < 0:
            return "coords must be non-negative"
        if self._screen_size is None:
            # Platform minimum: coordinates must be provable in-bounds;
            # an unknown screen size cannot prove that -> fail closed.
            return "screen size unavailable"
        sw, sh = self._screen_size
        if xi >= sw:
            return f"x out of bounds (screen width {sw})"
        if yi >= sh:
            return f"y out of bounds (screen height {sh})"
        return None

    @staticmethod
    def _check_duration(duration_ms: object) -> str | None:
        if duration_ms is None:
            return None
        d = Policy._require_int(duration_ms)
        if d is None:
            return "duration_ms must be an integer"
        if d < 0 or d > 3000:
            return "duration_ms out of range (0..3000)"
        return None

    # ---------- high-risk boundary mechanism ----------

    def _is_high_risk(self, ui_text: str) -> bool | None:
        """True/False when determinable; None when the injected matcher raised.

        An injected ``high_risk_matcher`` exception must fail closed: the
        policy can no longer prove the risk boundary, so the caller receives
        an auditable FAIL_CLOSED instead of a bare exception. The exception
        type name is logged; page/raw input is never echoed.
        """
        if self._config.high_risk_matcher is not None:
            try:
                return bool(self._config.high_risk_matcher(ui_text))
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "high-risk matcher raised; risk undeterminable (type=%s)",
                    type(e).__name__,
                )
                return None
        lowered = ui_text.lower()
        return any(kw in lowered for kw in self._config.high_risk_keywords)

    def _page_is_high_risk(self, page_texts: list[str] | None) -> bool | None:
        """True when any page text is high-risk; None when undeterminable.

        A page with no meaningful text is not treated as a high-risk boundary
        (no boundary evidence). If any text's risk cannot be evaluated, the
        whole page classification is undeterminable and fail-closed.
        """
        if not page_texts:
            return False
        undetermined = False
        for t in page_texts:
            risk = self._is_high_risk(t)
            if risk is None:
                undetermined = True
                continue
            if risk:
                return True
        return None if undetermined else False