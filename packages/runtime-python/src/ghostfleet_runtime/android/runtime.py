"""AndroidRuntime: the single controlled action execution loop.

Loop: observe(before) -> policy -> action -> observe(after) -> verify -> trace

Design constraints:
- every mutating device action flows through Runtime + Policy only;
- malformed params / out-of-bounds coords / unknown actions fail closed and
  never escape the loop without an auditable trace;
- ``open_app`` / ``restart_app`` verify the target package was actually
  reached; a timeout reports "target not reached" explicitly;
- traces never contain page text, secrets or ``input_text`` payloads;
- business trace/result hooks are injectable and receive only sanitized
  data (no secret, no raw page payload); v1 hooks have no opt-in detail.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol, runtime_checkable

from ghostfleet_runtime.android.actions import (
    TRANSITION_ACTIONS,
    safe_action_label,
)
from ghostfleet_runtime.android.observation import Observation, observe
from ghostfleet_runtime.android.policy import ActionDecision, Policy, PolicyConfig
from ghostfleet_runtime.android.schemas import ActionRequest, OcrBlock, PageState
from ghostfleet_runtime.android.trace import RunTrace, StepTrace, log_safe
from ghostfleet_runtime.android.verifier import TransitionVerifier, VerifyResult

logger = logging.getLogger(__name__)


class DeviceError(RuntimeError):
    """Device/runtime failure (maps to a device-kind result, not a policy one)."""


@runtime_checkable
class DeviceAdapter(Protocol):
    """Structural contract every device adapter must satisfy.

    The platform never executes arbitrary shell/ADB commands; only these
    whitelisted primitives are reachable through the runtime.
    """

    def screen_size(self) -> tuple[int, int] | None: ...
    def current_app(self) -> dict: ...
    def open_app(self, package: str) -> None: ...
    def restart_app(self, package: str) -> None: ...
    def tap_text(self, text: str) -> None: ...
    def tap_position(self, x: int, y: int) -> None: ...
    def input_text(self, text: str) -> None: ...
    def swipe(self, fx: int, fy: int, tx: int, ty: int, duration_ms: int) -> None: ...
    def press_back(self) -> None: ...
    def read_ui_tree(self) -> PageState: ...
    def read_page(self) -> PageState: ...
    def take_screenshot(self) -> Path: ...
    def ocr_image(self, path: Path) -> list[OcrBlock]: ...


@dataclass
class ResultHookData:
    """Sanitized result summary handed to business hooks.

    Deliberately excludes ``detail`` so hooks never receive a raw page
    payload or secret. Read-action content is available only through the
    ``RuntimeResult.detail`` returned by ``execute``, never through hooks.
    """

    ok: bool
    action: str
    decision: str
    reason: str | None = None
    error_kind: str | None = None
    step: StepTrace | None = None


@dataclass
class BusinessHooks:
    """Injection points for consumer business trace/result hooks.

    Hooks always receive only sanitized ``StepTrace`` / ``ResultHookData``
    (no secret, no raw page payload). v1 has no opt-in raw detail; the
    durable contract is a fixed sanitized summary.
    """

    on_step: Callable[[StepTrace], None] | None = None
    on_result: Callable[[ResultHookData], None] | None = None


@dataclass
class RuntimeResult:
    ok: bool
    action: str
    decision: ActionDecision
    reason: str | None = None
    detail: dict = field(default_factory=dict)
    step: StepTrace | None = None
    run: RunTrace | None = None
    # "policy" = input/policy rejection; "device" = device/runtime failure.
    error_kind: str | None = None


class AndroidRuntime:
    """Hold a device adapter, Policy and verifier; execute one action per call."""

    def __init__(
        self,
        device: DeviceAdapter,
        policy: Policy | None = None,
        verifier: TransitionVerifier | None = None,
        config: PolicyConfig | None = None,
        screen_size: tuple[int, int] | None = None,
        hooks: BusinessHooks | None = None,
    ) -> None:
        self._device = device
        self._screen_size = screen_size if screen_size is not None else self._resolve_screen_size()
        self._policy = policy or Policy(config=config, screen_size=self._screen_size)
        self._verifier = verifier or TransitionVerifier()
        self._hooks = hooks
        self._run = RunTrace()

    def _resolve_screen_size(self) -> tuple[int, int] | None:
        try:
            return self._device.screen_size()
        except Exception:  # noqa: BLE001
            return None

    @property
    def run(self) -> RunTrace:
        return self._run

    def execute(self, request: ActionRequest) -> RuntimeResult:
        result = self._execute(request)
        hook_error = self._run_hooks(result)
        if hook_error and result.step is not None:
            result.step.hook_error = hook_error
        return result

    # ---------- internals ----------

    def _run_hooks(self, result: RuntimeResult) -> str | None:
        """Invoke injected business hooks with isolated failure semantics.

        A raising hook must never replace the already-computed action result
        with a bare exception: the caller always receives the deterministic,
        auditable ``RuntimeResult``. Hook failures are recorded as a redacted
        ``hook_error`` on the step and logged without the exception message.
        """
        errors: list[str] = []
        if not self._hooks:
            return None
        if self._hooks.on_step and result.step is not None:
            try:
                self._hooks.on_step(result.step)
            except Exception as e:  # noqa: BLE001
                errors.append(f"on_step hook raised {type(e).__name__}")
                logger.warning(
                    "business hook on_step raised; isolated (type=%s)", type(e).__name__
                )
        if self._hooks.on_result:
            data = ResultHookData(
                ok=result.ok,
                action=result.action,
                decision=result.decision.value,
                reason=result.reason,
                error_kind=result.error_kind,
                step=result.step,
            )
            try:
                self._hooks.on_result(data)
            except Exception as e:  # noqa: BLE001
                errors.append(f"on_result hook raised {type(e).__name__}")
                logger.warning(
                    "business hook on_result raised; isolated (type=%s)", type(e).__name__
                )
        return "; ".join(log_safe(e) for e in errors) if errors else None

    def _execute(self, request: ActionRequest) -> RuntimeResult:
        # 1. observe(before)
        try:
            before = observe(self._device)
        except Exception as e:  # noqa: BLE001
            return self._fail(
                request, ActionDecision.FAIL_CLOSED, log_safe(str(e)), error_kind="device"
            )

        # 2. policy decision
        decision, reason = self._policy.decide_action(request, page_texts=before.texts)
        if decision == ActionDecision.FAIL_CLOSED:
            return self._fail(request, decision, log_safe(reason), error_kind="policy")
        if decision == ActionDecision.HUMAN_REQUIRED:
            return self._human(request, reason)

        # 3. action
        try:
            detail = self._dispatch(request)
        except DeviceError as e:
            return self._fail(request, decision, log_safe(str(e)), error_kind="device")
        except ValueError as e:
            return self._fail(request, ActionDecision.FAIL_CLOSED, log_safe(str(e)), error_kind="policy")
        except Exception as e:  # noqa: BLE001
            return self._fail(request, ActionDecision.FAIL_CLOSED, log_safe(str(e)), error_kind="device")

        # 4. observe(after)
        try:
            after: Observation | None = observe(self._device)
        except Exception:  # noqa: BLE001
            after = None

        # 5. verify target transition
        verify: VerifyResult | None = None
        if request.action in TRANSITION_ACTIONS:
            verify = self._verify_target(request)
            if not verify.ok:
                return self._fail(
                    request,
                    decision,
                    log_safe(
                        f"target not reached after action {safe_action_label(request.action)}: "
                        f"{verify.reason}"
                    ),
                    after=after,
                    verify=verify,
                    error_kind="device",
                )

        # 6. trace
        step = StepTrace(
            index=len(self._run.steps),
            action=safe_action_label(request.action),
            decision=decision.value,
            ok=True,
            before_fingerprint=before.fingerprint,
            after_fingerprint=after.fingerprint if after else None,
            verify_ok=verify.ok if verify else None,
            verify_attempts=verify.attempts if verify else 0,
        )
        self._run.steps.append(step)
        logger.info(
            "runtime step ok action=%s attempts=%s",
            safe_action_label(request.action),
            verify.attempts if verify else 0,
        )
        return RuntimeResult(
            ok=True,
            action=safe_action_label(request.action),
            decision=decision,
            detail=detail,
            step=step,
            run=self._run,
        )

    def _verify_target(self, request: ActionRequest) -> VerifyResult:
        package = request.package or ""

        def reached() -> bool:
            try:
                cur = self._device.current_app()
            except Exception:  # noqa: BLE001
                return False
            return bool(cur and cur.get("package") == package)

        return self._verifier.wait_for(reached, description=f"open {package}")

    def _dispatch(self, request: ActionRequest) -> dict:
        action = request.action
        p = request
        if action == "open_app":
            self._device.open_app(p.package or "")
            return {}
        if action == "restart_app":
            self._device.restart_app(p.package or "")
            return {}
        if action == "tap_text":
            self._device.tap_text(p.text)
            return {}
        if action == "tap_position":
            self._device.tap_position(int(p.x), int(p.y))
            return {}
        if action == "input_text":
            # secret payload: never copy the value into detail or any log.
            text = p.text
            if not isinstance(text, str):
                raise ValueError("text required")
            self._device.input_text(text)
            return {}
        if action == "swipe":
            self._device.swipe(
                int(p.fx), int(p.fy), int(p.tx), int(p.ty), int(p.duration_ms or 200)
            )
            return {}
        if action == "press_back":
            self._device.press_back()
            return {}
        if action == "read_ui_tree":
            return self._device.read_ui_tree().to_dict()
        if action == "read_page":
            return self._device.read_page().to_dict()
        if action == "take_screenshot":
            return {"path": str(self._device.take_screenshot())}
        if action == "run_ocr":
            path = self._device.take_screenshot()
            blocks = self._device.ocr_image(path)
            return {"path": str(path), "blocks": [b.to_dict() for b in blocks]}
        if action == "request_human":
            # Policy classifies request_human as HUMAN_REQUIRED before dispatch.
            return {"reason": p.reason}
        raise DeviceError(f"unknown action {action}")

    def _human(self, request: ActionRequest, reason: str | None) -> RuntimeResult:
        step = StepTrace(
            index=len(self._run.steps),
            action=safe_action_label(request.action),
            decision=ActionDecision.HUMAN_REQUIRED.value,
            ok=False,
            human_reason=log_safe(reason),
        )
        self._run.steps.append(step)
        logger.info("runtime human_required action=%s", safe_action_label(request.action))
        return RuntimeResult(
            ok=False,
            action=safe_action_label(request.action),
            decision=ActionDecision.HUMAN_REQUIRED,
            reason=reason,
            step=step,
            run=self._run,
        )

    def _fail(
        self,
        request: ActionRequest,
        decision: ActionDecision,
        error: str | None,
        after: Observation | None = None,
        verify: VerifyResult | None = None,
        error_kind: str = "device",
    ) -> RuntimeResult:
        step = StepTrace(
            index=len(self._run.steps),
            action=safe_action_label(request.action),
            decision=decision.value,
            ok=False,
            error=log_safe(error),
            verify_ok=verify.ok if verify else None,
            verify_attempts=verify.attempts if verify else 0,
            after_fingerprint=after.fingerprint if after else None,
        )
        self._run.steps.append(step)
        logger.warning(
            "runtime fail action=%s decision=%s error=%s",
            safe_action_label(request.action),
            decision.value,
            step.error,
        )
        return RuntimeResult(
            ok=False,
            action=safe_action_label(request.action),
            decision=decision,
            reason=error,
            step=step,
            run=self._run,
            error_kind=error_kind,
        )