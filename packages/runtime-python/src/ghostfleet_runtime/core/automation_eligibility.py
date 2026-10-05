"""Fleet automation eligibility checker.

Determines which registry nodes are eligible for ansible-core automation
from the single canonical management profile pointer (Single Canonical
Owner + Pointer/Adapter model). Eligibility is NOT derived from a separate
`automation_profile` node field: the canonical profile's ``automation``
block is the single source of truth.

A node is eligible only when ALL of:
- fleet_state == MANAGED
- management_profile resolves to a canonical profile in fleet/00_shared/profiles/
- that profile's ``automation`` block is eligible with tool ansible-core
- node type is in the profile's ``targeting.asset_types``

Missing/null/unresolved/non-eligible profiles fail closed (not eligible).
"""

from ghostfleet_runtime.core.profile_loader import load_profiles

AUTOMATION_TOOL = "ansible-core"


def is_automation_eligible(node: dict, profiles: dict[str, dict] | None = None) -> bool:
    """Check if a node is eligible for Fleet automation via canonical profile."""
    if node.get("fleet_state") != "MANAGED":
        return False
    if profiles is None:
        profiles = load_profiles()

    ref = node.get("management_profile")
    if not ref:
        return False  # no profile pointer -> fail closed

    profile = profiles.get(ref)
    if profile is None:
        return False  # unresolved ref -> fail closed

    automation = profile.get("automation", {})
    if not automation.get("eligible"):
        return False
    if automation.get("tool") != AUTOMATION_TOOL:
        return False

    node_type = node.get("type")
    return node_type in profile.get("targeting", {}).get("asset_types", [])


def filter_automation_targets(
    nodes: dict[str, dict],
    profiles: dict[str, dict] | None = None,
) -> list[str]:
    """Return sorted list of node_ids eligible for automation."""
    return sorted(
        nid for nid, node in nodes.items()
        if is_automation_eligible(node, profiles)
    )


def assert_automation_scope(
    nodes: dict[str, dict],
    playbook_targets: list[str],
    profiles: dict[str, dict] | None = None,
) -> list[str]:
    """Verify that playbook targets only include automation-eligible nodes.

    Returns list of error strings (empty = valid).
    """
    eligible = set(filter_automation_targets(nodes, profiles))
    errors = []

    for target in playbook_targets:
        if target not in eligible:
            node = nodes.get(target, {})
            state = node.get("fleet_state", "UNKNOWN")
            ref = node.get("management_profile")
            errors.append(
                f"Node '{target}' is in playbook targets but not automation-eligible "
                f"(fleet_state={state}, management_profile={ref!r})"
            )

    return errors