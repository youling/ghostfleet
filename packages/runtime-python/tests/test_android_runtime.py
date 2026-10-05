"""Actual Android runtime, verifier and parser with an injected fake device only."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace
import pytest
from ghostfleet_runtime.android.runtime import AndroidRuntime
from ghostfleet_runtime.android.policy import ActionDecision,PolicyConfig
from ghostfleet_runtime.android.schemas import ActionRequest,PageState,UiNode
from ghostfleet_runtime.android.uiautomator2_adapter import Uiautomator2Device
from ghostfleet_runtime.android.controller_probe import A0LiveControllerProbe,CommandResult,ControllerProbeError
from ghostfleet_runtime.android.detector import AmbiguousDeviceError,AbsentDeviceError

UID="node-00000000-0000-4000-8000-000000000001"
class FakeDevice:
    def __init__(self,*,wrong_target=False,risky=False):self.package="example.synthetic";self.actions=[];self.wrong_target=wrong_target;self.risky=risky
    def screen_size(self):return (100,100)
    def current_app(self):return {"package":self.package}
    def read_page(self):return PageState(package=self.package,fingerprint="synthetic-fingerprint",nodes=[UiNode(text="synthetic-final-commit")] if self.risky else [])
    def open_app(self,package):self.actions.append("open_app");self.package="example.wrong" if self.wrong_target else package
    def press_back(self):self.actions.append("press_back")
    def input_text(self,text):self.actions.append("input_text")

class OneAttemptVerifier:
    def wait_for(self,predicate,description):return SimpleNamespace(ok=predicate(),attempts=1,reason="synthetic-check")

def runtime(device):return AndroidRuntime(device,config=PolicyConfig(allowed_packages=frozenset({"example.synthetic"}),high_risk_keywords=("synthetic-final-commit",)),verifier=OneAttemptVerifier())

@pytest.mark.parametrize("wrong",[False,True])
def test_actual_transition_runtime_verifies_reached_target(wrong):
    device=FakeDevice(wrong_target=wrong);engine=runtime(device);result=engine.execute(ActionRequest(action="open_app",package="example.synthetic"))
    assert result.ok is (not wrong) and device.actions==["open_app"]
    assert result.step.verify_ok is (not wrong) and result.step.verify_attempts==1

def test_actual_runtime_escalates_without_input_and_safe_retreat_is_allowed():
    device=FakeDevice(risky=True);engine=runtime(device);payload="synthetic-inert-payload-not-a-credential"
    result=engine.execute(ActionRequest(action="input_text",text=payload))
    assert not result.ok and result.decision==ActionDecision.HUMAN_REQUIRED and device.actions==[]
    trace=json.dumps(engine.run.to_dict());assert payload not in trace and "synthetic-final-commit" not in trace
    retreat=engine.execute(ActionRequest(action="press_back"));assert retreat.ok and device.actions==["press_back"]

def test_actual_runtime_malformed_action_and_raising_hook_are_redacted():
    device=FakeDevice();engine=runtime(device);untrusted={"synthetic-untrusted":"payload"}
    result=engine.execute(ActionRequest(action=untrusted))
    assert not result.ok and result.action=="<invalid>" and device.actions==[]
    assert "synthetic-untrusted" not in json.dumps(engine.run.to_dict())

def test_ui_tree_parser_keeps_visible_meaningful_nodes_and_rejects_bad_xml():
    xml='<hierarchy><node text="visible" visible-to-user="true" clickable="true"/><node text="hidden" visible-to-user="false"/><node content-desc="description" resource-id="example.synthetic:id/control" visible-to-user="true"/></hierarchy>'
    nodes=Uiautomator2Device._parse_hierarchy(xml)
    assert [node.text for node in nodes]==["visible",None] and nodes[0].clickable
    assert nodes[1].content_desc=="description" and Uiautomator2Device._parse_hierarchy("<malformed")==[]

def test_optional_adapter_explicit_serial_and_unique_private_artifact_provenance(tmp_path,monkeypatch):
    connected=[]
    class Provider:
        def screenshot(self,path):Path(path).write_bytes(b"synthetic-png-placeholder")
    monkeypatch.setitem(sys.modules,"uiautomator2",SimpleNamespace(connect=lambda serial:connected.append(serial) or Provider()))
    selected=Uiautomator2Device(serial="synthetic-adb-transport",artifact_dir=tmp_path/"artifacts")
    first=selected.take_screenshot();second=selected.take_screenshot()
    assert connected==["synthetic-adb-transport"] and first!=second and first.parent==second.parent==(tmp_path/"artifacts")
    assert first.read_bytes()==second.read_bytes()==b"synthetic-png-placeholder"

@pytest.mark.parametrize("enumeration,error",[("List of devices attached\n",AbsentDeviceError),("List of devices attached\nsynthetic-a\tdevice\nsynthetic-b\tdevice\n",AmbiguousDeviceError)])
def test_controller_single_device_window_is_fail_closed_and_does_not_leak_serial(enumeration,error):
    calls=[]
    def runner(command,serial):calls.append((command,serial));return CommandResult(enumeration,0)
    probe=A0LiveControllerProbe(runner)
    with pytest.raises(error) as caught:probe.select_for(UID)
    assert "synthetic-a" not in str(caught.value) and len(calls)==1 and calls[0][1] is None

def test_controller_requires_exact_node_uid_and_selects_ephemeral_transport_privately():
    calls=[]
    def runner(command,serial):calls.append((command,serial));return CommandResult("List of devices attached\nsynthetic-a\tdevice\n",0)
    probe=A0LiveControllerProbe(runner)
    with pytest.raises(ControllerProbeError):probe.select_for("malformed")
    assert calls==[]
    target=probe.select_for(UID);assert target.ref==UID and "synthetic-a" not in repr(target)
