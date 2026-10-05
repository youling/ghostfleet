"""Enrollment invariants with fresh synthetic inputs; no provider call is made."""
import io
import json
import pytest
from ghostfleet_runtime.control import enrollment_v2_minter as minter,enrollment_attempt as attempt
from ghostfleet_runtime.control.enrollment_node import NodeAttempt
from ghostfleet_runtime.linux.enroll_cli import HttpClaimClient,_NoRedirect,EnrollError,RootEnrollmentState

UID="node-00000000-0000-4000-8000-000000000001"
TAG="tag:synthetic-target"

@pytest.fixture
def trusted_tag(monkeypatch):
    monkeypatch.setattr(minter,"V2_TAG",TAG);monkeypatch.setattr(attempt,"V2_TAG",TAG)

def manifest():return {"node_uid":UID,"node_id":"synthetic-device","os_family":"debian-family","profile":"managed-linux","tailscale_tags":[TAG]}

def test_missing_trusted_provider_tag_cannot_mint_or_validate_manifest(monkeypatch):
    monkeypatch.setattr(minter,"V2_TAG","");monkeypatch.setattr(attempt,"V2_TAG","")
    with pytest.raises(minter.V2MinterError,match="TRUSTED_ENROLL_TAG_REQUIRED"):minter.build_tailscale_key_request()
    with pytest.raises(attempt.AttemptError,match="TRUSTED_ENROLL_TAG_REQUIRED"):attempt.validate_manifest(manifest())

@pytest.mark.parametrize("override",[{"tailnet":"arbitrary-tailnet"},{"tags":[TAG,"tag:other-synthetic"]},{"reusable":True},{"ephemeral":True},{"expiry_seconds":601},{"expiry_seconds":False}])
def test_provider_grant_cannot_widen_fixed_trusted_profile(trusted_tag,override):
    with pytest.raises(minter.V2MinterError):minter.validate_fixed_mint_semantics(**override)

def test_generated_grant_remains_single_use_short_lived_and_exact_tag(trusted_tag):
    payload=minter.build_tailscale_key_request(description="synthetic fixture")
    create=payload["capabilities"]["devices"]["create"]
    assert create["tags"]==[TAG] and create["reusable"] is False and create["ephemeral"] is False
    assert payload["expirySeconds"]<=600

@pytest.mark.parametrize("changes",[{"node_uid":False},{"tailscale_tags":["tag:other-synthetic"]},{"os_family":"unsupported"},{"extra":True}])
def test_manifest_wrong_identity_profile_and_unknown_fields_fail_closed(trusted_tag,changes):
    with pytest.raises(attempt.AttemptError):attempt.validate_manifest({**manifest(),**changes})

def node_attempt():
    class Store:
        def __init__(self):self.writes=[]
        def read_json(self,*args,**kwargs):return None
        def write_json(self,path,value,**kwargs):self.writes.append((path,dict(value)))
    handoff={"protocol":attempt.PROTOCOL,"node_uid":UID,"attempt_id":"attempt-00000000-0000-4000-8000-000000000001","manifest_digest":attempt.digest(manifest()),"client_binding":"sha256:"+"a"*64,"claim_code":"synthetic-inert-label-"+"x"*32,"courier_url":"https://courier.example.invalid","expires_at":"2030-01-01T00:00:00Z"}
    store=Store();node=NodeAttempt(handoff,manifest(),store,now=lambda:1700000000)
    node.local={"resume_capability":"synthetic-inert-label-"+"y"*32,"join_dispatched":False,"session_not_after":1699999999}
    return node,store

def test_expired_join_authority_cannot_contact_provider_or_extend_session(trusted_tag):
    node,store=node_attempt()
    node.status=lambda:pytest.fail("expired authority must not contact courier")
    with pytest.raises(attempt.AttemptError,match="JOIN_AUTHORITY_EXPIRED"):node.authorize_join()
    assert store.writes==[]

def test_durable_join_fence_prevents_second_claim_after_unknown_effect(trusted_tag):
    node,store=node_attempt();node.before_join();assert store.writes[-1][1]["join_dispatched"] is True
    node.open=lambda:{"state":"CREDENTIAL_READY"}
    node.call=lambda *args,**kwargs:pytest.fail("fenced claim must not be repeated")
    with pytest.raises(attempt.AttemptError,match="CLAIM_RECONCILIATION_REQUIRED"):node.claim()

def test_redirect_and_reflected_transport_error_never_expose_payload():
    with pytest.raises(EnrollError,match="CLAIM_REDIRECT_FORBIDDEN"):_NoRedirect().redirect_request(None,None,302,"",{},"https://different.example.invalid")
    class Opener:
        def open(self,*args,**kwargs):raise RuntimeError("synthetic-private-response-body")
    client=HttpClaimClient();client.opener=Opener()
    with pytest.raises(EnrollError) as caught:client.claim("https://fixture.example.invalid/v1/enrollment-tickets/"+"a"*32,"123456","synthetic-inert-label-"+"b"*32)
    assert str(caught.value)=="CLAIM_OUTCOME_UNKNOWN"
