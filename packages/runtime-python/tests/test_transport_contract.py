import json

import pytest

from ghostfleet_runtime.core.transport_contract import (
    Authority,
    Caller,
    ContractValidationError,
    DispatchState,
    DispatchStateUnrecoverableError,
    JsonFileDispatchStateStore,
    Plane,
    PlaneBinding,
    Purpose,
    PurposeUnspecifiedError,
    TargetProofMethod,
    TransportRequest,
    assert_no_secret_fields,
    derive_purpose_for_legacy_machine_control_entry,
    evaluate_gate,
    tag_policy_satisfied,
)


def _request(**overrides) -> TransportRequest:
    base = dict(
        node_uid="node-11111111-1111-4111-8111-111111111111",
        caller=Caller(auth_kind="oauth", actor_ref="actor:test"),
        authority=Authority(scope="machine-control", policy_revision="rev-1"),
        purpose=None,
        dispatch_state=None,
        plane_bindings=(
            PlaneBinding(
                plane=Plane.TAILNET,
                provider="tailscale",
                provider_ref="ref-1",
                required_tags=("tag:fleet-ssh-target",),
                runtime_tags=("tag:fleet-ssh-target",),
            ),
        ),
    )
    base.update(overrides)
    return TransportRequest(**base)


def test_missing_purpose_fails_closed():
    with pytest.raises(PurposeUnspecifiedError):
        evaluate_gate(_request(dispatch_state=DispatchState.NOT_DISPATCHED))


def test_missing_dispatch_state_fails_closed():
    with pytest.raises(DispatchStateUnrecoverableError):
        evaluate_gate(_request(purpose=Purpose.MACHINE_CONTROL))


def test_may_have_executed_forces_reconcile_required():
    result = evaluate_gate(
        _request(purpose=Purpose.MACHINE_CONTROL, dispatch_state=DispatchState.MAY_HAVE_EXECUTED)
    )
    assert result["candidates"] == []
    assert result["reason"] == "reconcile_required"


def test_unknown_dispatch_state_must_reconcile():
    result = evaluate_gate(
        _request(purpose=Purpose.MACHINE_CONTROL, dispatch_state=DispatchState.UNKNOWN)
    )
    assert result["reason"] == "reconcile_required"
    assert result["candidates"] == []


def test_not_dispatched_with_explicit_purpose_allows_candidates():
    result = evaluate_gate(
        _request(purpose=Purpose.MACHINE_CONTROL, dispatch_state=DispatchState.NOT_DISPATCHED)
    )
    assert result["reason"] == "ok"
    assert len(result["candidates"]) == 1


def test_legacy_entry_derives_machine_control_only():
    assert derive_purpose_for_legacy_machine_control_entry() is Purpose.MACHINE_CONTROL


def test_human_maintenance_excludes_cloudflare_plane():
    request = _request(
        purpose=Purpose.HUMAN_MAINTENANCE,
        dispatch_state=DispatchState.NOT_DISPATCHED,
        plane_bindings=(
            PlaneBinding(plane=Plane.CLOUDFLARE_VPC, provider="cloudflare", provider_ref="c1"),
            PlaneBinding(plane=Plane.TAILNET, provider="tailscale", provider_ref="t1"),
        ),
    )
    result = evaluate_gate(request)
    assert all(c.plane is Plane.TAILNET for c in result["candidates"])


def test_required_tags_are_not_merged_with_runtime_tags():
    binding = PlaneBinding(
        plane=Plane.TAILNET,
        provider="tailscale",
        provider_ref="ref-1",
        required_tags=("tag:fleet-ssh-target",),
        runtime_tags=("tag:other",),
    )
    assert tag_policy_satisfied(binding.required_tags, binding.runtime_tags) is False


def test_secret_fields_rejected_from_contract():
    with pytest.raises(ContractValidationError):
        assert_no_secret_fields({"node_uid": "node-x", "oauth_token": "abc"})


def test_json_file_dispatch_state_store_survives_restart(tmp_path):
    store_path = tmp_path / "dispatch_state.json"
    store = JsonFileDispatchStateStore(store_path)
    store.put("node-1", DispatchState.MAY_HAVE_EXECUTED)
    reloaded = JsonFileDispatchStateStore(store_path)
    assert reloaded.get("node-1") is DispatchState.MAY_HAVE_EXECUTED
    raw = json.loads(store_path.read_text(encoding="utf-8"))
    assert raw == {"node-1": "MAY_HAVE_EXECUTED"}
