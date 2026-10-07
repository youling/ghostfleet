from ghostfleet_runtime.core.transport_compat import (
    python_legacy_to_contract,
    ts_control_target_to_contract,
)
from ghostfleet_runtime.core.transport_contract import (
    Authority,
    Caller,
    DispatchState,
    Plane,
    Purpose,
    evaluate_gate,
)
from ghostfleet_runtime.core.transport_resolution import (
    TransportMode,
    TransportResolutionRequest,
)


def _caller() -> Caller:
    return Caller(auth_kind="oauth", actor_ref="actor:test")


def _authority() -> Authority:
    return Authority(scope="machine-control", policy_revision="rev-1")


def test_python_legacy_compat_preserves_fail_closed_for_missing_purpose():
    legacy = TransportResolutionRequest(
        node_uid="node-11111111-1111-4111-8111-111111111111",
        management_path="/fleet/x7ti",
        management_profile="managed-linux",
        provider_ref="opaque-tailscale-ref",
        mode=TransportMode.NORMAL,
    )
    request = python_legacy_to_contract(
        legacy, purpose=None, dispatch_state=DispatchState.NOT_DISPATCHED, caller=_caller(), authority=_authority()
    )
    # evaluate_gate must fail closed, not default purpose.
    try:
        evaluate_gate(request)
        assert False, "expected PurposeUnspecifiedError"
    except Exception as exc:
        assert exc.__class__.__name__ == "PurposeUnspecifiedError"


def test_python_legacy_compat_preserves_fail_closed_for_missing_dispatch_state():
    legacy = TransportResolutionRequest(
        node_uid="node-11111111-1111-4111-8111-111111111111",
        management_path="/fleet/x7ti",
        management_profile="managed-linux",
        provider_ref="opaque-tailscale-ref",
        mode=TransportMode.NORMAL,
    )
    request = python_legacy_to_contract(
        legacy, purpose=Purpose.MACHINE_CONTROL, dispatch_state=None, caller=_caller(), authority=_authority()
    )
    try:
        evaluate_gate(request)
        assert False, "expected DispatchStateUnrecoverableError"
    except Exception as exc:
        assert exc.__class__.__name__ == "DispatchStateUnrecoverableError"


def test_ts_compat_maps_transport_mode_to_plane_without_synthesizing_purpose():
    request = ts_control_target_to_contract(
        node_uid="node-11111111-1111-4111-8111-111111111111",
        transport_mode="direct_tunnel",
        purpose=None,
        dispatch_state=DispatchState.NOT_DISPATCHED,
        caller=_caller(),
        authority=_authority(),
    )
    assert request.plane_bindings[0].plane is Plane.CLOUDFLARE_VPC
    assert request.purpose is None


def test_legacy_required_tags_not_merged_with_observed_tags():
    legacy = TransportResolutionRequest(
        node_uid="node-11111111-1111-4111-8111-111111111111",
        management_path="/fleet/x7ti",
        management_profile="managed-linux",
        provider_ref="opaque-tailscale-ref",
        mode=TransportMode.NORMAL,
    )
    request = python_legacy_to_contract(
        legacy,
        purpose=Purpose.MACHINE_CONTROL,
        dispatch_state=DispatchState.NOT_DISPATCHED,
        caller=_caller(),
        authority=_authority(),
        observed_tags=("tag:other",),
    )
    binding = request.plane_bindings[0]
    assert binding.required_tags == ("tag:fleet-ssh-target",)
    assert binding.runtime_tags == ("tag:other",)
    assert binding.required_tags != binding.runtime_tags
