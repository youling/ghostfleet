"""Fleet profile loader and validator.

Loads profile YAML files from fleet/00_shared/profiles/ and validates their structure.
"""

import os
from pathlib import Path
from typing import Any

import yaml

VALID_MANAGEMENT_PATHS = {"primary", "secondary", "break-glass"}


def _find_repo_root() -> Path:
    from ghostfleet_runtime.resource_paths import resource_root
    return resource_root()


REPO_ROOT = _find_repo_root()
FLEET_DIR = REPO_ROOT / "fleet"
PROFILES_DIR = FLEET_DIR / "00_shared" / "profiles"


class ProfileValidationError(Exception):
    """Raised when profile validation fails."""

    def __init__(self, profile_name: str, errors: list[str]):
        self.profile_name = profile_name
        self.errors = errors
        super().__init__(f"Profile '{profile_name}': {len(errors)} error(s)")


def validate_profile(data: dict) -> list[str]:
    """Validate a single profile definition."""
    errors = []

    if not isinstance(data, dict):
        return ["Profile must be a YAML mapping"]

    # Required top-level fields
    for field in ("name", "management", "automation", "targeting"):
        if field not in data:
            errors.append(f"Missing required field '{field}'")

    # Management validation
    mgmt = data.get("management", {})
    if isinstance(mgmt, dict):
        required = mgmt.get("required_paths", [])
        if not isinstance(required, list):
            errors.append("management.required_paths must be a list")
        else:
            for p in required:
                if p not in VALID_MANAGEMENT_PATHS:
                    errors.append(f"Invalid management path '{p}'")

    # Automation validation
    auto = data.get("automation", {})
    if isinstance(auto, dict):
        eligible = auto.get("eligible", False)
        tool = auto.get("tool")
        if eligible and not tool:
            errors.append("automation.eligible=true requires automation.tool")

    # Targeting validation
    targeting = data.get("targeting", {})
    if isinstance(targeting, dict):
        os_family = targeting.get("os_family", [])
        if os_family and not isinstance(os_family, list):
            errors.append("targeting.os_family must be a list")

    return errors


def load_profiles(profiles_dir: Path | None = None) -> dict[str, dict]:
    """Load all profile YAML files from the profiles directory.

    Returns dict mapping profile name -> profile data.
    """
    if profiles_dir is None:
        profiles_dir = PROFILES_DIR

    profiles = {}
    if not profiles_dir.exists():
        return profiles

    for f in sorted(profiles_dir.glob("*.yaml")):
        with open(f, encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
        if isinstance(data, dict) and "name" in data:
            profiles[data["name"]] = data

    return profiles


def profile_allows_node_type(profile: dict, node_type: str) -> bool:
    """Check if a profile's targeting allows a given node type."""
    targeting = profile.get("targeting", {})
    asset_types = targeting.get("asset_types", [])
    return node_type in asset_types


def profile_allows_os(profile: dict, os_name: str) -> bool:
    """Check if a profile's targeting allows a given OS."""
    targeting = profile.get("targeting", {})
    os_family = targeting.get("os_family", [])
    excluded = targeting.get("excluded_os", [])
    return os_name in os_family and os_name not in excluded


# Registry fields that reference canonical profile definitions.
# Guardrails v1 (#43): automation_profile is DEPRECATED_NON_CANONICAL toward
# removal (legacy duplicate selector; management_profile + Fleet eligibility
# rules remain canonical). It is still resolved here for 1.1 compatibility so
# current registries keep passing; new code must not depend on it.
PROFILE_REF_FIELDS = ("management_profile", "recovery_profile", "automation_profile")


def resolve_registry_profile_refs(
    registry: dict,
    profiles: dict[str, dict] | None = None,
) -> list[str]:
    """Resolve every registry profile ref against canonical profile definitions.

    Single Canonical Owner + Pointer/Adapter model: a ref is only acceptable
    when it resolves to a canonical definition in ``fleet/00_shared/profiles/``.
    Returns error strings (empty = every non-null ref resolves). Null refs
    mean "not observed/not assigned" and are skipped.
    """
    if profiles is None:
        profiles = load_profiles()

    errors = []
    nodes = registry.get("nodes", {})
    if not isinstance(nodes, dict):
        return errors

    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            continue
        for field in PROFILE_REF_FIELDS:
            ref = node.get(field)
            if ref is None:
                continue
            if ref not in profiles:
                errors.append(
                    f"Node {node_id}: {field} '{ref}' does not resolve to a "
                    "canonical profile definition in fleet/00_shared/profiles/"
                )
    return errors
