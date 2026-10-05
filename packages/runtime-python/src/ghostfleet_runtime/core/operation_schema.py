"""FleetOperator v0.1 operation request schema — fail closed.

A FleetOperation is a fixed, non-secret contract object consumed by the
Fleet Operator Lane. It may only carry declared management facts
(``operation_id`` / ``node_id`` / ``operation_kind`` /
``expected_fleet_state`` / ``generation``) plus an explicit ``canary``
context flag. Any field that could express arbitrary command/shell/script
text, or any value that looks like a live endpoint / host / token / key, is
rejected by construction. Event payload is only a hint; canonical truth is
live-read from the registry/profile/operation definitions.
"""

import re
from typing import Any

from ghostfleet_runtime.core.registry_validator import VALID_LIFECYCLE_STATES

# FleetOperator v0.1 schema generation (monotonic, drift-sticky).
OPERATION_SCHEMA_GENERATION = 1
SUPPORTED_SCHEMA_GENERATIONS = (OPERATION_SCHEMA_GENERATION,)

# v0.1 executable operation kinds — fixed allowlist; everything else fails closed.
V0_1_EXECUTABLE_KINDS = ("VERIFY_MANAGED_LINUX_CHECK_MODE",)

# Future MANAGED-only benign primitives: reserved as constants only. They are
# NOT executable in v0.1, they are never in the executable allowlist, and any
# dispatch referencing them fails closed at the kind gate.
RESERVED_MANAGED_ONLY_KINDS = ("CHECK_SERVICE", "RESTART_SERVICE")

ALL_KNOWN_KINDS = V0_1_EXECUTABLE_KINDS + RESERVED_MANAGED_ONLY_KINDS

# Canary instance authority belongs to the deployment, never this generic validator.
CANARY_OPERATION_KIND = "VERIFY_MANAGED_LINUX_CHECK_MODE"

# Required non-secret fields of a FleetOperation v0.1 request.
REQUIRED_OPERATION_FIELDS = (
    "operation_id",
    "node_id",
    "operation_kind",
    "expected_fleet_state",
    "generation",
)

# Optional field that marks an explicit (verified) canary dispatch context.
CANARY_CONTEXT_FIELDS = ("canary",)

# Fields forbidden on an operation request. Presence of any of these (at any
# nesting level) means the request could express dynamic/arbitrary command
# text, which the Lane never accepts.
FORBIDDEN_PAYLOAD_KEYS = {
    "command", "commands", "cmd",
    "script", "scripts", "shell",
    "args", "arg", "argv",
    "payload", "raw", "inline", "body", "text",
    "playbook", "playbook_path", "playbook_name",
    "remote_command", "exec", "execute", "run",
}

# Required non-secret fields that a canonical operation definition must carry.
REQUIRED_DEFINITION_FIELDS = (
    "name",
    "schema_version",
    "generation",
    "description",
    "classes",
    "allowed_fleet_states",
    "target_management_profile",
    "execution",
)

OPERATION_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_\-]{2,79}$")
NODE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,79}$")


# Token guard stricter than the registry's prefix match: a value only looks
# token-like when the prefix is followed by a token-strength suffix. This
# prevents false positives on ordinary node ids (e.g. "ghost-node"),
# while still rejecting tskey-*/ghp_*/sk-*/key-*/token-* material.
TOKEN_LIKE_PATTERN = re.compile(
    r"^(?:tskey[:_\-]?|ghp[:_\-]|gho[:_\-]|sk-|key-|token-)\S{8,}$",
    re.IGNORECASE,
)


class OperationSchemaError(Exception):
    """Raised when an operation request/definition violates the v0.1 schema."""


def _scan_forbidden_keys(obj: Any, path: str = "") -> list[str]:
    """Recursively locate forbidden payload keys in the operation object."""
    errors: list[str] = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            location = f"{path}.{key}" if path else key
            if str(key).lower() in FORBIDDEN_PAYLOAD_KEYS:
                errors.append(
                    "forbidden payload field detected: the Operator Lane "
                    "never accepts command/script/shell text"
                )
            errors.extend(_scan_forbidden_keys(value, location))
    elif isinstance(obj, list):
        for i, value in enumerate(obj):
            errors.extend(_scan_forbidden_keys(value, f"{path}[{i}]"))
    return errors


def _scan_forbidden_values(obj: Any, path: str = "") -> list[str]:
    """Recursively reject values that look like topology/secret material.

    Mirrors the fail-closed value scanning used by the registry validator;
    an operation request must remain topology-safe and secret-safe on disk.
    """
    from ghostfleet_runtime.core.registry_validator import IP_PATTERN

    errors: list[str] = []
    if isinstance(obj, str):
        if IP_PATTERN.match(obj):
            errors.append("value looks like an IP address")
        if TOKEN_LIKE_PATTERN.match(obj):
            errors.append("value looks like a token/key")
    elif isinstance(obj, dict):
        for key, value in obj.items():
            errors.extend(_scan_forbidden_values(value, f"{path}.{key}" if path else str(key)))
    elif isinstance(obj, list):
        for i, value in enumerate(obj):
            errors.extend(_scan_forbidden_values(value, f"{path}[{i}]"))
    return errors


def validate_operation_request(operation: Any) -> list[str]:
    """Validate a FleetOperation v0.1 request. Returns error strings.

    An empty list means the request is schema-valid. Any payload key that
    could express command text, or any secret/topology-looking value, is an
    error. ``operation`` must be a dict with exactly the declared
    non-secret fields plus the optional ``canary`` flag.
    """
    errors: list[str] = []

    if not isinstance(operation, dict):
        return ["operation request must be a mapping"]

    for field in REQUIRED_OPERATION_FIELDS:
        if field not in operation:
            errors.append(f"missing required field '{field}'")

    # The request is a fixed contract: only declared non-secret fields plus
    # the optional canary context flag may appear. Any other key is rejected
    # (it cannot express a legitimate allowance input, so it is either
    # smuggling dynamic material or drift).
    allowed_keys = set(REQUIRED_OPERATION_FIELDS) | set(CANARY_CONTEXT_FIELDS)
    for key in operation:
        if key not in allowed_keys:
            errors.append(
                "unexpected field present: the FleetOperator v0.1 request is "
                "a fixed contract and carries nothing else"
            )

    if not isinstance(operation.get("canary", False), bool):
        errors.append("optional field 'canary' must be a boolean")

    # No arbitrary command/shell payload may ride on the request.
    errors.extend(_scan_forbidden_keys(operation))
    errors.extend(_scan_forbidden_values(operation))

    if "operation_id" in operation:
        value = operation["operation_id"]
        if not isinstance(value, str) or not OPERATION_ID_PATTERN.match(value):
            errors.append(
                f"invalid operation_id {value!r} (must match "
                "[a-z0-9][a-z0-9_-]{2,79})"
            )

    if "node_id" in operation:
        value = operation["node_id"]
        if not isinstance(value, str) or not NODE_ID_PATTERN.match(value):
            errors.append(
                f"invalid node_id {value!r} (must match [a-z0-9][a-z0-9_-]{0,79})"
            )

    if "operation_kind" in operation:
        value = operation["operation_kind"]
        if value not in ALL_KNOWN_KINDS:
            errors.append(
                f"unknown operation_kind {value!r}; v0.1 known kinds: "
                f"{', '.join(sorted(ALL_KNOWN_KINDS))}"
            )

    if "expected_fleet_state" in operation:
        value = operation["expected_fleet_state"]
        if value not in VALID_LIFECYCLE_STATES:
            errors.append(f"invalid expected_fleet_state {value!r}")

    if "generation" in operation:
        value = operation["generation"]
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            errors.append(
                "generation must be a positive integer (well-formedness); "
                "mismatch vs the current schema generation is drift and is "
                "detected by the allowance gate"
            )

    return errors


def assert_operation_request(operation: Any) -> None:
    """Validate and raise OperationSchemaError on any violation (fail closed)."""
    errors = validate_operation_request(operation)
    if errors:
        raise OperationSchemaError(
            f"FleetOperation v0.1 schema rejected: {'; '.join(errors)}"
        )


def validate_operation_definition(definition: Any) -> list[str]:
    """Validate a canonical ``fleet/10_platforms/linux/common/operations/verification/operator_lane/*.yaml`` definition."""
    errors: list[str] = []

    if not isinstance(definition, dict):
        return ["operation definition must be a mapping"]

    for field in REQUIRED_DEFINITION_FIELDS:
        if field not in definition:
            errors.append(f"missing required definition field '{field}'")

    name = definition.get("name")
    if name not in ALL_KNOWN_KINDS:
        errors.append(f"definition name {name!r} is not a known FleetOperator kind")

    schema_version = definition.get("schema_version")
    if schema_version != str(OPERATION_SCHEMA_GENERATION):
        errors.append(
            f"definition schema_version must be '{OPERATION_SCHEMA_GENERATION}', "
            f"got {schema_version!r}"
        )

    generation = definition.get("generation")
    if generation not in SUPPORTED_SCHEMA_GENERATIONS:
        errors.append(f"definition generation must be {SUPPORTED_SCHEMA_GENERATIONS}, got {generation!r}")

    allowed_states = definition.get("allowed_fleet_states", [])
    if not isinstance(allowed_states, list) or not allowed_states:
        errors.append("allowed_fleet_states must be a non-empty list")
    else:
        for state in allowed_states:
            if state not in VALID_LIFECYCLE_STATES:
                errors.append(f"invalid allowed_fleet_state {state!r}")

    target_profile = definition.get("target_management_profile")
    if not target_profile:
        errors.append("target_management_profile is required")

    execution = definition.get("execution")
    if not isinstance(execution, dict):
        errors.append("execution must be a mapping")
    else:
        for field in ("mode", "playbook", "inventory", "identity_gate"):
            if field not in execution:
                errors.append(f"execution missing required field '{field}'")

    errors.extend(_scan_forbidden_values(definition))
    return errors


def assert_operation_definition(definition: Any) -> None:
    """Validate a canonical definition and raise on violation."""
    errors = validate_operation_definition(definition)
    if errors:
        raise OperationSchemaError(
            f"canonical operation definition rejected: {'; '.join(errors)}"
        )