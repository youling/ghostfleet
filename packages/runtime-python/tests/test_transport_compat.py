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


# RF-1: opaque provider_ref must not be parsed as provider name; plane stays tailnet.

def test_rf1_opaque_provider_ref_maps_to_tailnet_not_native_lan():
    legacy = TransportResolutionRequest(
        node_uid="node-11111111-1111-4111-8111-111111111111",
        management_path="/fleet/x7ti",
        management_profile="managed-linux",
        provider_ref="opaque-tailscale-ref-xyz-123",
        mode=TransportMode.NORMAL,
    )
    request = python_legacy_to_contract(
        legacy,
        purpose=Purpose.MACHINE_CONTROL,
        dispatch_state=DispatchState.NOT_DISPATCHED,
        caller=_caller(),
        authority=_authority(),
    )
    assert request.plane_bindings[0].plane is Plane.TAILNET
    assert request.plane_bindings[0].provider == "tailscale"
    assert request.plane_bindings[0].provider_ref == "opaque-tailscale-ref-xyz-123"


# RF-4: unknown transport_mode must fail closed, not silently map to native-lan.

def test_rf4_unknown_transport_mode_fails_closed():
    try:
        ts_control_target_to_contract(
            node_uid="node-11111111-1111-4111-8111-111111111111",
            transport_mode="unknown_mode_xyz",
            purpose=Purpose.MACHINE_CONTROL,
            dispatch_state=DispatchState.NOT_DISPATCHED,
            caller=_caller(),
            authority=_authority(),
        )
        assert False, "expected ValueError for unknown transport_mode"
    except ValueError as exc:
        assert "unknown transport_mode" in str(exc)
