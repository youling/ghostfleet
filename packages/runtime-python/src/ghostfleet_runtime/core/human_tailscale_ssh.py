"""Human maintenance policy fragment, rendered from trusted deployment evidence.

This does not assert that a provider accepted the policy or that another rule in
the complete tailnet policy is safe. Run the emitted sshTests on that full policy
before activation. No deployment identities or provider defaults live here.
"""
from __future__ import annotations

import re
from typing import Any

REFERENCE_SECURITY_FLOOR = "1.98.9"
ACCEPT_ENV_FLOOR = "1.102.1"
REQUIRED_ADVISORIES = ("TS-2026-006", "TS-2026-009")
ACCEPT_ENV_ADVISORIES = ("TS-2026-010",)
EVIDENCE = re.compile(r"^evidence:[A-Za-z0-9._-]{1,128}$")
GROUP = re.compile(r"^group:[A-Za-z0-9._@-]+$")
EMAIL = re.compile(r"^[A-Za-z0-9.!#$%&'+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
TAG = re.compile(r"^tag:[a-z][a-z0-9-]*$")


class HumanPolicyError(ValueError):
    pass


def render_human_profile(
    capability: str,
    *,
    capability_evidence_ref: str,
    groups: dict[str, list[str]],
    principal_kinds: dict[str, str],
    destinations: list[str],
    denied_sources: list[str],
) -> dict[str, Any]:
    """Render only the capability-proven reference profile.

    principal_kinds must come from reviewed deployment identity evidence, not
    inferred from display names. Every group expands to explicit Human users.
    Alternative profiles require their own accepted implementation; a string
    identifier must never become an unreviewed default-12h check rule.
    """
    if capability != "CHECK_PERIOD_ALWAYS":
        raise HumanPolicyError("HUMAN_REFERENCE_CAPABILITY_UNPROVEN")
    if not EVIDENCE.fullmatch(capability_evidence_ref):
        raise HumanPolicyError("HUMAN_CAPABILITY_EVIDENCE_REQUIRED")
    if not groups or not destinations or not denied_sources:
        raise HumanPolicyError("HUMAN_POLICY_INPUT_REQUIRED")
    members: set[str] = set()
    for group, identities in groups.items():
        if not GROUP.fullmatch(group) or not isinstance(identities, list) or not identities:
            raise HumanPolicyError("HUMAN_GROUP_INVALID")
        for identity in identities:
            if not isinstance(identity, str) or not EMAIL.fullmatch(identity) or principal_kinds.get(identity) != "human":
                raise HumanPolicyError("HUMAN_GROUP_CONTAINS_NON_HUMAN_OR_UNKNOWN")
            members.add(identity)
    if any(not isinstance(d, str) or (d != "autogroup:self" and not TAG.fullmatch(d)) for d in destinations):
        raise HumanPolicyError("HUMAN_DESTINATION_INVALID")
    for source in denied_sources:
        if not isinstance(source, str) or source in members or not (TAG.fullmatch(source) or
            (EMAIL.fullmatch(source) and principal_kinds.get(source) in {"agent", "controller", "machine"})):
            raise HumanPolicyError("HUMAN_NEGATIVE_IDENTITY_INVALID")
    # Mandatory machine source coverage; no wildcard/autogroup shortcuts.
    if not any(TAG.fullmatch(s) for s in denied_sources):
        raise HumanPolicyError("HUMAN_TAGGED_NEGATIVE_REQUIRED")
    if not all(any(principal_kinds.get(s) == kind for s in denied_sources) for kind in ("agent", "controller")):
        raise HumanPolicyError("HUMAN_AGENT_CONTROLLER_NEGATIVES_REQUIRED")
    return {
        "groups": {g: sorted(set(groups[g])) for g in sorted(groups)},
        "ssh": [{"action": "check", "checkPeriod": "always", "src": sorted(groups),
                 "dst": sorted(set(destinations)), "users": ["root"]}],
        "sshTests": [
            *({"src": s, "dst": sorted(set(destinations)), "check": ["root"]} for s in sorted(members)),
            *({"src": s, "dst": sorted(set(destinations)), "deny": ["root"]} for s in sorted(set(denied_sources))),
        ],
    }


def validate_human_profile(profile: dict[str, Any], capability: str, *,
                           capability_evidence_ref: str, principal_kinds: dict[str, str]) -> list[str]:
    """Validate the exact rendered fragment; rejects extra rules and acceptEnv."""
    try:
        rule = profile["ssh"][0]
        expected = render_human_profile(capability, capability_evidence_ref=capability_evidence_ref,
            groups=profile["groups"], principal_kinds=principal_kinds, destinations=rule["dst"],
            denied_sources=[t["src"] for t in profile["sshTests"] if t.get("deny") == ["root"]])
        if profile != expected:
            return ["HUMAN_POLICY_DOES_NOT_MATCH_REVIEWED_PROFILE"]
    except (KeyError, IndexError, TypeError, HumanPolicyError) as error:
        return [str(error) if isinstance(error, HumanPolicyError) else "HUMAN_POLICY_INVALID"]
    return []


def _version(value: str) -> tuple[int, int, int]:
    # Unreviewed prereleases cannot satisfy a production security floor.
    if not isinstance(value, str) or not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise ValueError("INVALID_VERSION")
    major, minor, patch = map(int, value.split("."))
    return major, minor, patch


def validate_security_floor(*, running_version: str | None, reviewed_floor: str | None,
                            advisories_reviewed: list[str], has_accept_env: bool = False) -> list[str]:
    """Baseline hook only. Release must refresh upstream advisories independently."""
    errors = []
    floor = ACCEPT_ENV_FLOOR if has_accept_env else REFERENCE_SECURITY_FLOOR
    try:
        if reviewed_floor is None or _version(reviewed_floor) < _version(floor):
            errors.append("SECURITY_FLOOR_UNREVIEWED_OR_TOO_LOW")
        if running_version is None:
            errors.append("RUNNING_VERSION_UNKNOWN")
        elif _version(running_version) < max(_version(reviewed_floor or floor), _version(floor)):
            errors.append("RUNNING_VERSION_BELOW_FLOOR")
    except ValueError:
        errors.append("INVALID_VERSION")
    required = REQUIRED_ADVISORIES + (ACCEPT_ENV_ADVISORIES if has_accept_env else ())
    errors.extend(f"ADVISORY_NOT_REVIEWED:{a}" for a in required if a not in advisories_reviewed)
    return errors
