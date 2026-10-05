"""Domain-neutral Android/device-control primitive actions.

The platform owns the *mechanism* of the whitelisted primitive action set
(safe retreat / read-only / interaction / transition classification).
No consumer business data lives here: package whitelists, high-risk keyword
tables and business strictness limits are injected at runtime via
``PolicyConfig`` and stay owned by the consumer.
"""

from __future__ import annotations

# Whitelisted primitive actions proven cross-project reusable. Unknown or
# malformed action values fail closed in Policy and are never echoed back.
KNOWN_ACTIONS: frozenset[str] = frozenset(
    {
        "open_app",
        "tap_text",
        "tap_position",
        "swipe",
        "press_back",
        "read_ui_tree",
        "read_page",
        "take_screenshot",
        "run_ocr",
        "restart_app",
        "request_human",
        "input_text",
    }
)

REQUEST_HUMAN_ACTION: str = "request_human"

# Actions that must verify the target package was actually reached.
TRANSITION_ACTIONS: frozenset[str] = frozenset({"open_app", "restart_app"})

# Actions that carry a package parameter (injected allowed set).
PACKAGE_ACTIONS: frozenset[str] = frozenset({"open_app", "restart_app"})

# Actions that carry a single on-screen point.
COORD_ACTIONS: frozenset[str] = frozenset({"tap_position"})

# Actions that carry a swipe start/end pair plus duration.
SWIPE_ACTIONS: frozenset[str] = frozenset({"swipe"})

# Text-bearing actions. tap_text targets visible text; input_text carries a
# secret payload and must never be echoed into trace/log/error/result detail.
TEXT_ACTIONS: frozenset[str] = frozenset({"tap_text", "input_text"})

# Interaction actions that change device state. Interacting from inside a
# high-risk boundary page is forbidden by default (strict page gating).
INTERACTION_ACTIONS: frozenset[str] = frozenset(
    {"tap_text", "tap_position", "swipe", "input_text"}
)

# Safe retreat: allowed to leave a high-risk page automatically. This only
# permits "back out", never a high-risk click/input/confirmation.
RETREAT_ACTIONS: frozenset[str] = frozenset({"press_back"})

# Read-only actions: never change device state, always AUTO.
READ_ACTIONS: frozenset[str] = frozenset(
    {"read_ui_tree", "read_page", "take_screenshot", "run_ocr"}
)

# Actions whose payload is a secret value (never persisted to trace).
SECRET_PAYLOAD_ACTIONS: frozenset[str] = frozenset({"input_text"})

# Trace-safe label for malformed/unknown action values. Untrusted payloads
# are never echoed back into reasons, traces or logs.
_INVALID_ACTION_LABEL: str = "<invalid>"


def safe_action_label(value: object) -> str:
    """Return a trace-safe action label.

    Known action names pass through; any malformed/unknown value maps to a
    constant ``<invalid>`` label.
    """
    if isinstance(value, str) and value in KNOWN_ACTIONS:
        return value
    return _INVALID_ACTION_LABEL