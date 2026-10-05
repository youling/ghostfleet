"""Canonical operation registry — loads fleet/10_platforms/linux/common/operations/verification/operator_lane/*.yaml definitions.

Each canonical definition describes one fixed operation class the Operator
Lane may execute: its allowed lifecycle states, target management profile,
generation, read-only execution mode and the exact canonical
SSH/Ansible seams it reuses. No credential/topology material may ever be
committed here (schema value scan fails closed).
"""

from pathlib import Path

import yaml

from ghostfleet_runtime.core.operation_schema import (
    OPERATION_SCHEMA_GENERATION,
    assert_operation_definition,
)

OPERATIONS_DIR_NAME = "fleet/10_platforms/linux/common/operations/verification/operator_lane"


def _find_repo_root() -> Path:
    from ghostfleet_runtime.resource_paths import resource_root
    return resource_root()


REPO_ROOT = _find_repo_root()
OPERATIONS_DIR = REPO_ROOT / OPERATIONS_DIR_NAME


class OperationRegistryError(Exception):
    """Raised when canonical operation definitions are missing or invalid."""


def load_operation_definitions(
    operations_dir: Path | None = None,
) -> dict[str, dict]:
    """Load and validate every canonical ``fleet/10_platforms/linux/common/operations/verification/operator_lane/*.yaml`` definition.

    Returns a mapping ``kind -> definition``. Definitions are not allowed to
    declare traits this repository has not yet made executable; v0.1 keeps a
    single executable kind and fails closed on anything broader.
    """
    if operations_dir is None:
        operations_dir = OPERATIONS_DIR

    definitions: dict[str, dict] = {}
    if not operations_dir.exists():
        raise OperationRegistryError(
            f"canonical operations directory not found: {operations_dir}"
        )

    for f in sorted(operations_dir.glob("*.yaml")):
        data = yaml.safe_load(f.read_text(encoding="utf-8"))
        try:
            assert_operation_definition(data)
        except Exception as exc:  # noqa: BLE001 - propagate as registry error
            raise OperationRegistryError(
                f"invalid canonical operation definition {f.name}: {exc}"
            ) from exc
        name = data["name"]
        if name in definitions:
            raise OperationRegistryError(f"duplicate operation kind {name!r}")
        definitions[name] = data

    if "VERIFY_MANAGED_LINUX_CHECK_MODE" not in definitions:
        raise OperationRegistryError(
            "v0.1 canonical operation 'VERIFY_MANAGED_LINUX_CHECK_MODE' is missing"
        )

    return definitions


def current_schema_generation() -> int:
    """Return the drift-sticky schema generation the Lane validates against."""
    return OPERATION_SCHEMA_GENERATION