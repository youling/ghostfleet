"""Android edge profile/contract: explicit controller/evidence boundaries.

An Android edge is NOT a plain ``phone.yaml`` asset-only device:

- the controller relationship is an explicit management fact;
- USB ADB discovery evidence does not imply remote ENROLLED/MANAGED;
- reconnect / recovery / remote path each require independent evidence;
- a future Lenovo TB376FC-style unit may consume this profile, but this
  ticket creates no Lenovo/BWH/ThinkPad node or asset facts;
- having an Android runtime does not automatically make the device an
  Execution node or Agent Host.

This module encodes the contract deterministically so callers can fail
closed instead of misclassifying a discovered device as managed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Collection

# Evidence identifiers (domain-neutral).
ADB_DISCOVERY = "usb_adb_discovery"
CONTROLLER_BOUND = "controller_bound"
RECONNECT_VERIFIED = "reconnect_verified"
RECOVERY_VERIFIED = "recovery_verified"
REMOTE_PATH_VERIFIED = "remote_path_verified"
ENROLLED = "enrolled"
VERIFIED = "verified"
MANAGED = "managed"
EXECUTION_ELIGIBLE = "execution_eligible"
AGENT_HOST_ELIGIBLE = "agent_host_eligible"

# Fleet lifecycle states this contract reasons about.
DISCOVERED = "DISCOVERED"
REGISTERED = "REGISTERED"
ENROLLED_STATE = "ENROLLED"
VERIFIED_STATE = "VERIFIED"
MANAGED_STATE = "MANAGED"

# Minimum evidence required to *claim* each state on an Android edge.
# USB ADB discovery is never enough for a remote-managed state.
MINIMUM_EVIDENCE: dict[str, frozenset[str]] = {
    DISCOVERED: frozenset({ADB_DISCOVERY}),
    REGISTERED: frozenset({ADB_DISCOVERY}),
    ENROLLED_STATE: frozenset({ADB_DISCOVERY, CONTROLLER_BOUND, ENROLLED}),
    VERIFIED_STATE: frozenset(
        {ADB_DISCOVERY, CONTROLLER_BOUND, ENROLLED, RECONNECT_VERIFIED, RECOVERY_VERIFIED}
    ),
    MANAGED_STATE: frozenset(
        {
            ADB_DISCOVERY,
            CONTROLLER_BOUND,
            ENROLLED,
            RECONNECT_VERIFIED,
            RECOVERY_VERIFIED,
            REMOTE_PATH_VERIFIED,
            MANAGED,
        }
    ),
}

# State ordering used to report the highest claimable state.
_STATE_ORDER: list[str] = [DISCOVERED, REGISTERED, ENROLLED_STATE, VERIFIED_STATE, MANAGED_STATE]

# Runtime capability present on an Android device. It grants nothing by
# itself: promotion to Execution/Agent Host needs explicit evidence.
RUNTIME_CAPABILITY = "android_runtime_present"

# Evidence that explicitly promotes a device to Execution/Agent Host.
EXECUTION_PROMOTION_EVIDENCE = {EXECUTION_ELIGIBLE, AGENT_HOST_ELIGIBLE}


@dataclass
class AndroidEdgeEvaluation:
    """Result of evaluating evidence against a claimed state."""

    claimed_state: str
    claimable: bool
    errors: list[str] = field(default_factory=list)
    highest_claimable: str = REGISTERED

    def to_dict(self) -> dict:
        return {
            "claimed_state": self.claimed_state,
            "claimable": self.claimable,
            "errors": list(self.errors),
            "highest_claimable": self.highest_claimable,
        }


def highest_claimable_state(evidence: Collection[str]) -> str:
    """Highest fleet state a given evidence set can claim (fail-closed)."""
    evidence_set = frozenset(evidence)
    for state in reversed(_STATE_ORDER):
        if MINIMUM_EVIDENCE[state] <= evidence_set:
            return state
    return REGISTERED


def evaluate_android_edge_state(
    evidence: Collection[str],
    claimed_state: str,
) -> AndroidEdgeEvaluation:
    """Validate a claimed Android-edge state against the evidence set.

    Fail-closed: USB ADB discovery alone can never claim ENROLLED or above;
    reconnect/recovery/remote path each require independent evidence.
    """
    evidence_set = frozenset(evidence)
    errors: list[str] = []

    if claimed_state not in _STATE_ORDER:
        errors.append(f"unknown fleet state '{claimed_state}'")
        return AndroidEdgeEvaluation(
            claimed_state=claimed_state,
            claimable=False,
            errors=errors,
            highest_claimable=highest_claimable_state(evidence_set),
        )

    if ADB_DISCOVERY not in evidence_set:
        errors.append("missing USB ADB discovery evidence")
    elif claimed_state in (ENROLLED_STATE, VERIFIED_STATE, MANAGED_STATE):
        if ADB_DISCOVERY in evidence_set and not evidence_set.intersection(
            {CONTROLLER_BOUND, ENROLLED}
        ):
            errors.append(
                "USB ADB discovery does not imply ENROLLED/MANAGED; "
                "controller relationship is an explicit management fact"
            )
        if claimed_state in (VERIFIED_STATE, MANAGED_STATE):
            for required in (RECONNECT_VERIFIED, RECOVERY_VERIFIED):
                if required not in evidence_set:
                    errors.append(
                        f"{required} requires independent evidence for {claimed_state}"
                    )
        if claimed_state == MANAGED_STATE and REMOTE_PATH_VERIFIED not in evidence_set:
            errors.append(
                "remote path requires independent evidence for MANAGED"
            )

    missing = MINIMUM_EVIDENCE[claimed_state] - evidence_set
    if missing:
        errors.append(
            f"cannot claim {claimed_state}: missing evidence "
            f"{sorted(missing)}"
        )

    highest = highest_claimable_state(evidence_set)
    return AndroidEdgeEvaluation(
        claimed_state=claimed_state,
        claimable=not errors,
        errors=errors,
        highest_claimable=highest,
    )


def evaluate_execution_promotion(
    evidence: Collection[str],
    *,
    claimed_execution: bool = False,
    claimed_agent_host: bool = False,
) -> list[str]:
    """An Android runtime capability never promotes a device by itself.

    Promotion to Execution node / Agent Host requires explicit promotion
    evidence AND a claimable MANAGED state.
    """
    evidence_set = frozenset(evidence)
    errors: list[str] = []

    if not claimed_execution and not claimed_agent_host:
        return errors

    if RUNTIME_CAPABILITY in evidence_set and not evidence_set.intersection(
        EXECUTION_PROMOTION_EVIDENCE
    ):
        errors.append(
            "Android runtime capability does not make the device an "
            "Execution node / Agent Host; explicit promotion evidence required"
        )
    if evidence_set.intersection(EXECUTION_PROMOTION_EVIDENCE) and not evidence_set.intersection(
        MINIMUM_EVIDENCE[MANAGED_STATE]
    ):
        errors.append(
            "Execution/Agent Host promotion requires MANAGED-state evidence"
        )
    if claimed_agent_host and EXECUTION_ELIGIBLE in evidence_set and AGENT_HOST_ELIGIBLE not in evidence_set:
        errors.append(
            "Agent Host claim requires explicit agent-host eligibility evidence"
        )
    return errors