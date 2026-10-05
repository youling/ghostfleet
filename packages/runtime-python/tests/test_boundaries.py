"""Fresh synthetic fixtures for identity/projection/platform safety boundaries."""
import copy
import json
from pathlib import Path
import pytest

from ghostfleet_runtime.core.node_identity import resolve_node,require_mutation_target,HeuristicMutationDenied,AmbiguousNodeError,UnresolvedNodeError
from ghostfleet_runtime.core.instance_overlay import parse_overlay,validate_overlay_content,TrustedOverlayError
from ghostfleet_runtime.core.instance_projection import build_projection_with_identity,projection_bytes_for_identity,load_projection_file,render_projection_file
from ghostfleet_runtime.android.policy import Policy,PolicyConfig,ActionDecision
from ghostfleet_runtime.android.schemas import ActionRequest
from ghostfleet_runtime.android.trace import log_safe
from ghostfleet_runtime.windows.windows_preflight import load_preflight_script,validate_preflight_script,validate_preflight_readonly
from ghostfleet_runtime.windows.windows_enrollment import load_enrollment_script,validate_enrollment_script,is_narrow_management_scope

UID="node-00000000-0000-4000-8000-000000000001"
def nodes():return {"synthetic-device":{"node_uid":UID,"aliases":["synthetic-alias"],"asset_ref":None}}

@pytest.mark.parametrize("reference",[UID,"synthetic-device","synthetic-alias"])
def test_legacy_exact_identity_resolution(reference):
    result=require_mutation_target(reference,nodes());assert result.node_uid==UID and result.mutation_authorized

def test_heuristic_and_ambiguous_identity_never_authorize_mutation():
    assert not resolve_node("fleet-synthetic-device.example.invalid",nodes()).mutation_authorized
    with pytest.raises(HeuristicMutationDenied):require_mutation_target("fleet-synthetic-device.example.invalid",nodes())
    conflicting=nodes();conflicting["other-device"]={"node_uid":"node-00000000-0000-4000-8000-000000000002","aliases":["synthetic-alias"],"asset_ref":None}
    with pytest.raises(AmbiguousNodeError):require_mutation_target("synthetic-alias",conflicting)
    with pytest.raises(UnresolvedNodeError):resolve_node(42,nodes())

def test_projection_exact_bytes_revision_identity_and_no_second_registry(tmp_path):
    overlay={"schema_version":"1.2.0","nodes":{"synthetic-device":{"type":"server","fleet_state":"REGISTERED","node_uid":UID,"asset_ref":None}}}
    original=copy.deepcopy(overlay)
    projection,identity,raw=build_projection_with_identity("a"*40,"b"*40,overlay)
    path=tmp_path/"synthetic-projection.json";render_projection_file(projection,identity,path)
    assert load_projection_file(path)==(projection,identity)
    assert projection_bytes_for_identity(projection,identity)==raw
    wrong={**identity,"projection_digest":"sha256:"+"c"*64}
    with pytest.raises(TrustedOverlayError,match="PROJECTION_DIGEST_MISMATCH"):projection_bytes_for_identity(projection,wrong)
    with pytest.raises(TrustedOverlayError):build_projection_with_identity("not-revision","b"*40,overlay)
    assert overlay==original

@pytest.mark.parametrize("raw",[b"schema_version: 1.2.0\nschema_version: 1.2.0\nnodes: {}\n",b"schema_version: 1.2.0\nnodes: {}\nendpoint: https://fixture.example.invalid\n",b"not-a-mapping"])
def test_overlay_rejects_duplicate_keys_unknown_fields_and_malformed_payload(raw):
    with pytest.raises(TrustedOverlayError):parse_overlay(raw)

@pytest.mark.parametrize("action_request",[
    ActionRequest(action=None),ActionRequest(action=42),ActionRequest(action="unknown"),
    ActionRequest(action="open_app",package="example.synthetic"),ActionRequest(action="tap_position",x=-1,y=1),
    ActionRequest(action="tap_position",x=True,y=1),ActionRequest(action="tap_position",x=9999,y=1),
    ActionRequest(action="input_text",text=123),ActionRequest(action="swipe",fx=0,fy=0,tx=1,ty=1,duration_ms=3001),
])
def test_android_malformed_unconfigured_or_out_of_bounds_fails_closed(action_request):
    decision,reason=Policy(screen_size=(100,100)).decide_action(action_request)
    assert decision==ActionDecision.FAIL_CLOSED and reason

def test_android_risk_policy_injected_and_secret_payload_is_value_free():
    policy=Policy(PolicyConfig(allowed_packages=frozenset({"example.synthetic"}),high_risk_keywords=("synthetic-final-commit",)),screen_size=(100,100))
    assert policy.decide_action(ActionRequest(action="tap_text",text="synthetic-final-commit"))[0]==ActionDecision.HUMAN_REQUIRED
    assert policy.decide_action(ActionRequest(action="press_back"),["synthetic-final-commit"])[0]==ActionDecision.AUTO
    assert policy.decide_action(ActionRequest(action="read_page"),["synthetic-final-commit"])[0]==ActionDecision.AUTO
    payload="synthetic-inert-payload-not-a-credential"
    decision,reason=policy.decide_action(ActionRequest(action="input_text",text=payload),["synthetic-final-commit"])
    assert decision==ActionDecision.HUMAN_REQUIRED and payload not in (reason or "")
    assert "synthetic-value" not in log_safe("password=synthetic-value")

def test_windows_packaged_validators_and_readonly_mutation_denial():
    assert validate_preflight_script(load_preflight_script())==[]
    assert validate_enrollment_script(load_enrollment_script())==[]
    for mutation in ("Set-Service sshd -StartupType Automatic","Add-WindowsCapability -Online","New-NetFirewallRule -DisplayName fixture"):
        assert validate_preflight_readonly(mutation)

@pytest.mark.parametrize("scope",["*","Any","0.0.0.0/0","::/0","fixture.example.invalid"])
def test_windows_broad_or_nonnumeric_management_scope_is_rejected(scope):
    assert not is_narrow_management_scope(scope)
