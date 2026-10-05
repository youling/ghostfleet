"""Synthetic adapters only; no real device, provider or credential input."""
import ast
import copy
import io
import json
import hashlib
import os
import sys
from contextlib import nullcontext
from pathlib import Path

import pytest

from ghostfleet_runtime.resource_paths import resource_root, resource_path
from ghostfleet_runtime.core.profile_loader import load_profiles
from ghostfleet_runtime.core.node_identity import resolve_node, require_mutation_target
from ghostfleet_runtime.core.registry_validator import validate_registry
from ghostfleet_runtime.control.enrollment_attempt import AttemptError
from ghostfleet_runtime.control.enrollment_v2_minter import resolve_private_handoff_config, _handoff_headers, V2_HANDOFF_URL_KEY, V2_HANDOFF_TOKEN_KEY, V2_HANDOFF_SITE_TOKEN_KEY
from ghostfleet_runtime.linux.enroll_cli import parse_enrollment_input, read_enrollment_input, EnrollError, ticket_url
from ghostfleet_runtime.linux.converger import Converger
from ghostfleet_runtime.linux.system import MARKER, DESCRIPTOR, CHECKPOINT, ConvergeError
from ghostfleet_runtime.linux.system import LinuxSystem

UID="node-00000000-0000-4000-8000-000000000001"
DIGEST="sha256:"+"a"*64
IDENTITY={"provider_device_id":"synthetic-provider-device","node_key":"nodekey:"+"0"*64}
SYNTHETIC_TAG="tag:synthetic-target"

@pytest.fixture(autouse=True)
def synthetic_deployment_policy(monkeypatch):
    from ghostfleet_runtime.control import enrollment_attempt,enrollment_v2_minter
    monkeypatch.setattr(enrollment_attempt,"V2_TAG",SYNTHETIC_TAG)
    monkeypatch.setattr(enrollment_v2_minter,"V2_TAG",SYNTHETIC_TAG)

def configuration():
    return {"protocol":MARKER,"manifest":{"node_id":"synthetic-device","node_uid":UID,"os_family":"debian-family","profile":"managed-linux","tailscale_tags":[SYNTHETIC_TAG]},"machine_id_sha256":DIGEST,"provider_instance":{"provider":"synthetic-provider","instance_id":"fixture"},"projection":{"schema_version":"1.0.0","product_source_revision":"a"*40,"instance_overlay_revision":"b"*40,"projection_digest":DIGEST},"profile_generation":DIGEST,"rollback_ref":"evidence:synthetic-rollback","recovery_ref":"evidence:synthetic-recovery","packages":{"tailscale":"1.2.3"},"proof_adapter":{"path":"/synthetic-observer","sha256":DIGEST},"handoff_path":None}

class SyntheticSystem:
    def __init__(self):
        self.files={};self.effects=[];self.locks=0;self.runner=None;self.family=self
    def package(self,name):return "1.2.3"
    def host_identity(self):return {"machine_id_sha256":DIGEST,"os_family":"debian-family"}
    def validate_destination(self,path):pass
    def read_json(self,path,**kwargs):return copy.deepcopy(self.files.get(path))
    def service(self):return {"LoadState":"loaded","ActiveState":"active","UnitFileState":"enabled"}
    def file_observation(self,path):return copy.deepcopy(self.files.get(path))
    def file_matches(self,path,value):return self.files.get(path)==value
    def write_json(self,path,value,**kwargs):
        if self.files.get(path)==value:return False
        self.files[path]=copy.deepcopy(value);self.effects.append(path);return True
    def lock(self):self.locks+=1;return nullcontext()
    def install(self,missing):raise AssertionError("no fixture package install")
    def service_action(self,action):raise AssertionError("no fixture service mutation")

class SyntheticProvider:
    def observe(self):return {"state":"Running","identity":copy.deepcopy(IDENTITY)}
    def join(self,*args):raise AssertionError("no new join")
    def resume(self):raise AssertionError("no new provider mutation")

class SyntheticProof:
    def __init__(self):self.count=0
    def verify(self,binding,identity,attempt):self.count+=1;return {"evidence_ref":"evidence:synthetic-proof"}

def test_real_convergence_engine_first_pass_and_zero_delta_repeat():
    system=SyntheticSystem();proof=SyntheticProof();config=configuration()
    first=Converger(system,config,provider=SyntheticProvider(),proof=proof).run()
    before=copy.deepcopy(system.files);writes=list(system.effects)
    second=Converger(system,config,provider=SyntheticProvider(),proof=proof).run()
    assert first["material_delta"]==["write-owned-descriptor","write-owned-checkpoint"]
    assert second["material_delta"]==[] and second["postconditions_digest"]==first["postconditions_digest"]
    assert system.files==before and system.effects==writes and second["lifecycle_promoted"] is False
    assert proof.count>=6 and DESCRIPTOR in system.files and CHECKPOINT in system.files

def test_wrong_host_is_rejected_before_lock_or_writes():
    system=SyntheticSystem();config=configuration();config["machine_id_sha256"]="sha256:"+"b"*64
    with pytest.raises(ConvergeError,match="EXACT_HOST_MISMATCH"):
        Converger(system,config,provider=SyntheticProvider(),proof=SyntheticProof()).run()
    assert system.locks==0 and system.effects==[]

@pytest.mark.skipif(sys.platform!="linux",reason="POSIX file ownership/fsync/flock contract runs in Linux CI")
def test_linux_real_filesystem_roundtrip_is_zero_delta(tmp_path):
    class FixedRunner:
        def run(self,argv,**kwargs):
            if argv[0]=="/usr/bin/dpkg-query":return 0,"installed\t1.2.3"
            if argv[:2]==["/usr/bin/systemctl","show"]:return 0,"LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n"
            raise AssertionError("unexpected fixture command")
    etc=tmp_path/"etc";etc.mkdir(mode=0o700)
    (etc/"machine-id").write_text("0"*32);(etc/"os-release").write_text("ID=debian\n")
    config=configuration();config["machine_id_sha256"]="sha256:"+hashlib.sha256(("0"*32).encode()).hexdigest()
    system=LinuxSystem(root=tmp_path,owner_uid=os.geteuid(),runner=FixedRunner())
    first=Converger(system,config,provider=SyntheticProvider(),proof=SyntheticProof()).run()
    def snapshot():
        return {path.relative_to(tmp_path).as_posix():(path.read_bytes(),path.stat().st_mtime_ns,path.stat().st_mode,path.stat().st_uid) for path in tmp_path.rglob("*") if path.is_file()}
    before=snapshot();second=Converger(system,config,provider=SyntheticProvider(),proof=SyntheticProof()).run()
    assert first["material_delta"] and second["material_delta"]==[] and snapshot()==before

def test_installed_resource_paths_are_package_relative_and_bounded():
    root=resource_root();assert root.name=="resources"
    profiles=load_profiles();assert "managed-linux" in profiles and "android-edge" in profiles
    assert resource_path("fleet/00_shared/schemas/instance-projection.schema.json").is_file()
    assert resource_path("fleet/10_platforms/linux/common/operations/jobs/fleet-jobctl.py").is_file()
    with pytest.raises((ValueError,FileNotFoundError)):
        resource_path("../../__init__.py")

def enrollment_fixture():
    return {"one_time_url":"https://fixture.example.invalid/v1/enrollment-tickets/"+"a"*32,"short_code":"123456"}

def test_protected_input_pipe_is_bounded_strict_and_no_credentials_in_argv():
    raw=json.dumps(enrollment_fixture()).encode()
    assert read_enrollment_input(ticket_stdin=True,stream=io.BytesIO(raw))==enrollment_fixture()
    for invalid in (raw+b"!",b"{\"one_time_url\":1}",b"x"*16385,b'{"one_time_url":"x","one_time_url":"y","short_code":"1234"}'):
        with pytest.raises(EnrollError):parse_enrollment_input(invalid)
    with pytest.raises(EnrollError,match="INPUT_FILE_UNTRUSTED"):
        read_enrollment_input(ticket_file="relative-input.json")
    source=resource_root().parent/"linux/enroll_cli.py"
    tree=ast.parse(source.read_text())
    main=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=="main")
    arguments=[node.args[0].value for node in ast.walk(main) if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=="add_argument" and node.args and isinstance(node.args[0],ast.Constant)]
    assert "one_time_url" not in arguments and "short_code" not in arguments

@pytest.mark.parametrize("client",["alpha","beta"])
def test_generic_handoff_needs_no_openai_provider_config(client):
    env={V2_HANDOFF_URL_KEY:f"https://{client}.example.invalid/api/enrollment/handoff",V2_HANDOFF_TOKEN_KEY:"synthetic-inert-label-"+"x"*32}
    config=resolve_private_handoff_config(env)
    assert config.profile=="generic"
    assert set(_handoff_headers(config))=={"authorization","content-type"}
    assert all("openai" not in key.lower() and "oai" not in key.lower() for key in _handoff_headers(config))

def test_sites_compat_profile_requires_exact_url_and_machine_gate():
    env={V2_HANDOFF_URL_KEY:"https://synthetic.chatgpt.site/api/enrollment/handoff",V2_HANDOFF_TOKEN_KEY:"synthetic-inert-label-"+"x"*32,V2_HANDOFF_SITE_TOKEN_KEY:"synthetic-inert-label-"+"y"*32}
    with pytest.raises(Exception,match="HANDOFF_COMPAT_PROFILE_REQUIRED"):resolve_private_handoff_config(env)
    env.update(GHOSTFLEET_HANDOFF_PROFILE="sites-v1",GHOSTFLEET_HANDOFF_EXPECTED_URL=env[V2_HANDOFF_URL_KEY])
    config=resolve_private_handoff_config(env);assert "oai-sites-authorization" in _handoff_headers(config)
    env["GHOSTFLEET_HANDOFF_EXPECTED_URL"]="https://different.chatgpt.site/api/enrollment/handoff"
    with pytest.raises(Exception,match="HANDOFF_SITE_PROFILE_MISMATCH"):resolve_private_handoff_config(env)

def test_windows_resources_have_generic_control_closure():
    relative="fleet/10_platforms/windows/common/onboarding/"
    control=resource_path(relative+"control/managed-windows-control.ps1")
    converge=resource_path(relative+"managed-windows-converge.ps1").read_text()
    assert "managed-windows-control.ps1" in converge and "managed-windows-chatgpt-control.ps1" not in converge
    assert "chatgpt" not in control.read_text().lower()
