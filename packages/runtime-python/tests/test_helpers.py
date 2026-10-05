"""Actual helper engines against temporary files and injected synthetic backends."""
import importlib.util
import json
import os
import stat
import sys
import time
import uuid
from pathlib import Path
import pytest
from ghostfleet_runtime.resource_paths import resource_path

UID="node-00000000-0000-4000-8000-000000000001"
BASE="fleet/10_platforms/linux/common/operations/"
def helper(relative):
    path=resource_path(BASE+relative);name="synthetic_helper_"+uuid.uuid4().hex
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);sys.modules[name]=module
    spec.loader.exec_module(module);return module

def test_job_atomic_receipt_keeps_old_reader_and_publishes_new_generation(tmp_path):
    module=helper("jobs/fleet-jobctl.py");path=tmp_path/"receipt.json"
    module.atomic(path,{"generation":"old"})
    with module.open_receipt(path) as old:
        module.atomic(path,{"generation":"new"})
        assert json.load(old)=={"generation":"old"}
    assert module.load(path)=={"generation":"new"}

def test_job_actual_engine_uncertain_start_is_never_resubmitted_and_actor_isolated(tmp_path):
    module=helper("jobs/fleet-jobctl.py")
    class Backend:
        count=0
        def submit(self,root,slot,meta,deadline):
            self.count+=1;assert module.load(root/str(slot)/"meta.json")["submission"]=="ATTEMPTED"
            raise module.JobError("SYNTHETIC_UNCERTAIN_SUBMIT")
        def inspect(self,meta,deadline):return None
        def empty(self,cgroup,unit):return None
    backend=Backend();engine=module.Jobs(tmp_path/"jobs",UID,backend,"synthetic-boot",now=lambda:1700000000)
    spec={"argv":["/usr/bin/true"],"runtime_seconds":10}
    request={"protocol":"fleet-job/v1","node_uid":UID,"actor_ref":"a"*64,"action":"start","operation_id":"oj1-1700000000000-00000000-0000-4000-8000-000000000001",**spec,"spec_digest":module.digest(spec)}
    first=engine.start(request,time.monotonic()+5);second=engine.start(request,time.monotonic()+5)
    assert first["state"]=="UNKNOWN" and first["retry_submit"] is False and second["duplicate"] is True and backend.count==1
    access={"action":"status","handle":first["handle"],"generation":first["generation"],"actor_ref":"b"*64}
    with pytest.raises(module.JobError,match="JOB_BINDING_MISMATCH"):engine.access(access,time.monotonic()+5)
    access["actor_ref"]="a"*64;access["generation"]="c"*32
    with pytest.raises(module.JobError,match="JOB_GENERATION_MISMATCH"):engine.access(access,time.monotonic()+5)
    assert backend.count==1

@pytest.mark.parametrize("change",[{"argv":["relative"]},{"argv":["/usr/bin/true","\0bad"]},{"runtime_seconds":False},{"spec_digest":"wrong"}])
def test_job_spec_invalid_before_backend_submit(tmp_path,change):
    module=helper("jobs/fleet-jobctl.py")
    class Backend:
        def submit(self,*args):raise AssertionError("backend must not be reached")
    engine=module.Jobs(tmp_path/"jobs",UID,Backend(),"synthetic-boot",now=lambda:1700000000)
    spec={"argv":["/usr/bin/true"],"runtime_seconds":10}
    request={"actor_ref":"a"*64,"operation_id":"oj1-1700000000000-00000000-0000-4000-8000-000000000001",**spec,"spec_digest":module.digest(spec),**change}
    with pytest.raises(module.JobError):engine.start(request,time.monotonic()+5)
    assert list(engine.root.iterdir())==[]

@pytest.mark.skipif(sys.platform!="linux",reason="session helper uses POSIX terminal/resource/fcntl primitives")
def test_session_actor_generation_and_atomic_receipt_boundaries(tmp_path):
    module=helper("sessions/fleet-sessionctl.py");engine=module.Sessions.__new__(module.Sessions);engine.node=UID
    meta={"handle":"fs2-"+"a"*64,"node_uid":UID,"actor_ref":"b"*64,"generation":"c"*32}
    engine.bind(meta,meta["actor_ref"],meta["handle"],meta["generation"])
    with pytest.raises(module.SessionError,match="SESSION_BINDING_MISMATCH"):engine.bind(meta,"d"*64,meta["handle"],meta["generation"])
    with pytest.raises(module.SessionError,match="SESSION_GENERATION_MISMATCH"):engine.bind(meta,meta["actor_ref"],meta["handle"],"e"*32)
    path=tmp_path/"receipt.json";module.atomic(path,{"generation":"one"});module.atomic(path,{"generation":"two"});assert module.load(path)=={"generation":"two"}
    assert stat.S_IMODE(path.stat().st_mode)==0o600

def session_fixture(tmp_path,*,uncertain=False):
    module=helper("sessions/fleet-sessionctl.py")
    engine=module.Sessions.__new__(module.Sessions);engine.root=tmp_path;engine.node=UID;engine.now=lambda:1700000000
    slot=tmp_path/"0";slot.mkdir(mode=0o700)
    generation="c"*32;handle="fs2-"+"a"*64
    meta={"protocol":module.PROTOCOL,"node_uid":UID,"actor_ref":"b"*64,"handle":handle,"generation":generation,"tmux_name":"fleet-s2-"+generation,"tmux_session_id":"$0","pane_id":"%0","operation_id":"os1-1700000000000-00000000-0000-4000-8000-000000000001","spec_digest":"d"*64,"state":"ACTIVE","last_activity_at":1700000000,"absolute_expires_at":1700001000,"retention_until":1700002000,"last_input_seq":0,"last_input_digest":None,"pending_input":None}
    module.atomic(slot/"meta.json",meta);(slot/"output.bin").write_bytes(b"abcdef")
    class Tmux:
        count=0
        def status(self,meta,deadline):return "RUNNING",None,None,"synthetic-running"
        def literal_input(self,meta,seq,text,keys,deadline):
            self.count+=1
            assert module.load(slot/"meta.json")["pending_input"]["seq"]==seq
            if uncertain:raise module.SessionError("SYNTHETIC_UNCERTAIN_INPUT")
    engine.tmux=Tmux()
    common={"handle":handle,"generation":generation,"actor_ref":"b"*64}
    return module,engine,common

@pytest.mark.skipif(sys.platform!="linux",reason="actual session receipt I/O uses POSIX ownership and directory fsync")
def test_session_actual_cursor_and_input_sequence_replay_guards(tmp_path):
    module,engine,common=session_fixture(tmp_path)
    read=engine.access({**common,"action":"read","cursor":1,"max_bytes":2},time.monotonic()+5)
    assert read["output_base64"]=="YmM=" and read["next_cursor"]==3 and read["more_available"] is True
    with pytest.raises(module.SessionError,match="CURSOR_INVALID"):engine.access({**common,"action":"read","cursor":7,"max_bytes":2},time.monotonic()+5)
    input_request={**common,"action":"input","input_seq":1,"text":"synthetic input","control_keys":[]}
    first=engine.access(input_request,time.monotonic()+5);second=engine.access(input_request,time.monotonic()+5)
    assert first["duplicate"] is False and second["duplicate"] is True and engine.tmux.count==1
    with pytest.raises(module.SessionError,match="INPUT_SEQ_CONFLICT"):engine.access({**input_request,"text":"different synthetic input"},time.monotonic()+5)
    assert engine.tmux.count==1

@pytest.mark.skipif(sys.platform!="linux",reason="actual session pending-input fence uses POSIX ownership and directory fsync")
def test_session_unknown_input_is_fenced_before_effect_and_never_replayed(tmp_path):
    module,engine,common=session_fixture(tmp_path,uncertain=True)
    input_request={**common,"action":"input","input_seq":1,"text":"synthetic input","control_keys":[]}
    first=engine.access(input_request,time.monotonic()+5);second=engine.access(input_request,time.monotonic()+5)
    assert first["state"]==second["state"]=="UNKNOWN" and first["reconcile_required"] is True and engine.tmux.count==1
    assert module.load(tmp_path/"0/meta.json")["pending_input"]["seq"]==1
    assert "synthetic input" not in (tmp_path/"0/meta.json").read_text()

@pytest.mark.skipif(sys.platform!="linux",reason="privileged helper depends on POSIX pwd/grp/fcntl; no real root operation in fixture")
def test_privileged_actual_dispatch_fence_preserves_unknown_and_rejects_actor_replay(tmp_path,monkeypatch):
    module=helper("privileged/fleet_privctl.py");monkeypatch.setattr(module,"TEST_MODE",True)
    monkeypatch.setattr(module,"canonical_node_uid",lambda:UID);monkeypatch.setattr(module,"_trusted_receipt_dir",lambda:tmp_path)
    monkeypatch.setattr(module,"lock_path",lambda:tmp_path/"admission.lock");monkeypatch.setattr(module,"_v3_generation_authority",lambda request:None)
    monkeypatch.setattr(module,"audit_event",lambda **kwargs:None)
    calls=[]
    def execute(request,ops_user):
        calls.append(request);assert json.loads((tmp_path/(request["request_id"]+".json")).read_text())["state"]=="PENDING"
        raise module.PrivilegedOperationError("SYNTHETIC_UNCERTAIN_EFFECT")
    monkeypatch.setattr(module,"execute",execute)
    request={"schema":module.SCHEMA_V3,"action":"execute","node_uid":UID,"request_id":"synthetic-request-1","actor_ref":"a"*64,"operation":"root-probe","vendor_ids":[],"generation":"b"*64,"profile_generation":"sha256:"+"c"*64}
    first=module.run_v3(request,"synthetic-ops");second=module.run_v3(request,"synthetic-ops")
    assert first["state"]=="UNKNOWN" and second["state"]=="UNKNOWN" and len(calls)==1
    with pytest.raises(module.PrivilegedOperationError,match="PRIVILEGED_REQUEST_ID_CONFLICT"):
        module.run_v3({**request,"actor_ref":"d"*64},"synthetic-ops")
    assert len(calls)==1
