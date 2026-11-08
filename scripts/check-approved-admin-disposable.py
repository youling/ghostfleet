#!/usr/bin/env python3
"""Real Linux/systemd acceptance; ONLY a disposable GitHub-hosted Linux runner.

This is not an installer, production issuer, remote host probe or fixture-mode
production backend. It generates an ephemeral key and uses the real backend.
"""
from __future__ import annotations
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


def require_disposable():
    if (os.name != "posix" or os.geteuid() != 0
            or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
            or Path("/proc/1/comm").read_text().strip() != "systemd"):
        raise SystemExit("DISPOSABLE_GITHUB_HOSTED_ROOT_SYSTEMD_REQUIRED")


def main():
    require_disposable()
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    source = (Path(__file__).resolve().parents[1] / "packages/runtime-python/src/"
              "ghostfleet_runtime/resources/fleet/10_platforms/linux/common/operations/privileged/"
              "fleet_admin_command.py")
    directory = Path(tempfile.mkdtemp(prefix="ghostfleet-admin-ci-", dir="/run"))
    helper = directory / "fleet_admin_command.py"
    shutil.copyfile(source, helper)
    helper.chmod(0o700)
    spec = importlib.util.spec_from_file_location("disposable_admin", helper)
    assert spec and spec.loader
    admin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(admin)
    fs = admin.TrustedFiles()
    private = Ed25519PrivateKey.generate()
    node = "node-00000000-0000-4000-8000-000000000001"
    subject = "a" * 64
    generation = "b" * 64
    profile = "sha256:" + "c" * 64
    config = directory / "config.json"
    report = directory / "report.json"
    control = directory / "control.json"
    state = directory / "state"
    state.mkdir(mode=0o700)
    fs.write(report, {"node_uid": node})
    fs.write(control, {"schema": "youling-fleet-privileged-operations-local/v2",
                       "ops_user": admin.OPS_USER, "generation": generation,
                       "profile_generation": profile})
    cfg = {"schema": admin.CONFIG_SCHEMA, "node_uid": node, "subject_ref": subject,
           "audience_ref": "ghostfleet-approved-admin-command/v1", "generation": generation,
           "profile_generation": profile,
           "issuer_keys": {"ci-ephemeral": base64.b64encode(private.public_key().public_bytes_raw()).decode()},
           "state_dir": str(state), "python_executable": sys.executable,
           "helper_path": str(helper), "node_report_path": str(report),
           "control_state_path": str(control), "max_ttl_seconds": 120, "max_runtime_seconds": 60}
    fs.write(config, cfg)
    backend = admin.SystemdBackend(cfg, config, fs)
    executor = admin.Executor(config)
    keys = []

    def approve(code, runtime=30, ttl=60, output="discard", output_limit_bytes=None):
        ident = "ci-" + uuid.uuid4().hex
        issued = int(time.time())
        cmd = {"argv": [sys.executable, "-I", "-c", code], "cwd": str(directory),
               "env": {}, "executable_sha256": fs.executable_digest(Path(sys.executable)),
               "output": output}
        if output_limit_bytes is not None:
            cmd["output_limit_bytes"] = output_limit_bytes
        lease = {"schema": admin.LEASE_SCHEMA, "lease_id": ident, "request_id": "request-" + ident,
                 "operation_id": "operation-" + ident, "operation": "admin.command",
                 "issuer_id": "ci-ephemeral", "node_uid": node, "subject_ref": subject,
                 "audience_ref": cfg["audience_ref"], "generation": generation,
                 "profile_generation": profile, "work_ref": "synthetic/disposable-ci",
                 "purpose": "Ephemeral acceptance only", "approval_ref": "approval-" + ident,
                 "rollback_ref": "synthetic/disposable-cleanup", "issued_at": issued,
                 "not_before": issued, "expires_at": issued + ttl, "max_uses": 1,
                 "max_runtime_seconds": runtime,
                 "command": cmd}
        raw = admin.canonical(lease)
        wire = {"schema": admin.WIRE_SCHEMA, "action": "execute", "node_uid": node,
                "actor_ref": subject, "lease_b64": base64.b64encode(raw).decode(),
                "signature_b64": base64.b64encode(private.sign(admin.DOMAIN + raw)).decode()}
        keys.append(admin.Ledger.key(ident))
        return lease, wire

    def poll(wire, states, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            receipt = executor.handle({**wire, "action": "status"})
            if receipt["state"] in states:
                return receipt
            time.sleep(0.1)
        raise AssertionError("bounded status did not reach " + ",".join(sorted(states)))

    def await_file(path):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if path.is_file():
                return
            time.sleep(0.05)
        raise AssertionError("approved command did not create its acceptance marker")

    def denied(wire):
        before = sorted((state / "leases").glob("*.json"))
        try:
            executor.handle(wire)
        except admin.AdminError:
            assert sorted((state / "leases").glob("*.json")) == before
            return
        raise AssertionError("invalid approval was accepted")

    def descendants_code(marker):
        # The approved literal source creates a setsid descendant. SIGKILL of
        # only the parent is insufficient; systemd must empty the whole cgroup.
        return ("import os,subprocess,sys,time; "
                "p=subprocess.Popen([sys.executable,'-I','-c','import time; time.sleep(120)'],start_new_session=True); "
                f"open({str(marker)!r},'w').write(str(os.getpid())+' '+str(p.pid)); "
                "time.sleep(120)")

    def assert_stopped(marker, key):
        assert backend._cgroup_empty(key), "unit cgroup is not empty"
        for value in marker.read_text().split():
            proc = Path("/proc") / value / "stat"
            if proc.exists():
                # A reaped zombie cannot continue effects. The kernel cgroup
                # population check above is still required independently.
                assert proc.read_text().split(") ", 1)[1][0] == "Z", "descendant is alive"

    try:
        backend.preflight()
        marker = directory / "root-effect.txt"
        lease, wire = approve(f"import os; open({str(marker)!r},'a').write(str(os.geteuid())+'\\n')")
        first = executor.handle(wire)
        assert first["state"] == "STARTED", first
        receipt = poll(wire, {"SUCCEEDED", "FAILED"})
        assert receipt["state"] == "SUCCEEDED" and receipt["exit_code"] == 0, receipt
        assert marker.read_text() == "0\n"
        assert executor.handle(wire)["duplicate"] is True
        assert marker.read_text() == "0\n", "replay executed again"
        assert receipt["output"] == "discarded" and receipt["persistent_effects_rolled_back"] is False

        _, invalid = approve("raise SystemExit(99)")
        denied({**invalid, "signature_b64": base64.b64encode(bytes(64)).decode()})
        denied({**invalid, "actor_ref": "d" * 64})
        denied({**invalid, "node_uid": "node-00000000-0000-4000-8000-000000000002"})
        expired, invalid = approve("raise SystemExit(99)", ttl=10)
        expired.update(issued_at=int(time.time()) - 30, not_before=int(time.time()) - 30,
                       expires_at=int(time.time()) - 20)
        raw = admin.canonical(expired)
        invalid.update(lease_b64=base64.b64encode(raw).decode(),
                       signature_b64=base64.b64encode(private.sign(admin.DOMAIN + raw)).decode())
        denied(invalid)

        cancelled = directory / "cancel-pids.txt"
        lease, wire = approve(descendants_code(cancelled), runtime=30)
        assert executor.handle(wire)["state"] == "STARTED"
        await_file(cancelled)
        cancelled_receipt = executor.handle({**wire, "action": "cancel"})
        assert cancelled_receipt["state"] == "REVOKED", cancelled_receipt
        assert_stopped(cancelled, admin.Ledger.key(lease["lease_id"]))
        assert executor.handle(wire)["duplicate"] is True

        expired_pids = directory / "ttl-pids.txt"
        lease, wire = approve(descendants_code(expired_pids), runtime=3)
        assert executor.handle(wire)["state"] == "STARTED"
        await_file(expired_pids)
        # Do not poll/cancel while the OS runtime boundary expires. This proves
        # expiration survives a disconnected request, independently of status.
        time.sleep(4)
        assert_stopped(expired_pids, admin.Ledger.key(lease["lease_id"]))
        expired_receipt = poll(wire, {"EXPIRED"})
        assert expired_receipt["persistent_effects_rolled_back"] is False

        # Test bounded diagnostic output capture and receipt privacy
        diag_code = (r"import sys; "
                     r"sys.stdout.write('NVME_SMART_HEALTH_OK\n'); "
                     r"sys.stderr.write('NVME_TEMP_NORMAL_32C\n')")
        lease_diag, wire_diag = approve(diag_code, output="bounded")
        assert executor.handle(wire_diag)["state"] == "STARTED"
        receipt_diag = poll(wire_diag, {"SUCCEEDED", "FAILED"})
        assert receipt_diag["state"] == "SUCCEEDED" and receipt_diag["exit_code"] == 0, receipt_diag
        assert receipt_diag["output"] == "bounded"
        assert receipt_diag["truncated"] is False
        assert receipt_diag["stdout_bytes"] == len("NVME_SMART_HEALTH_OK\n".encode())
        assert receipt_diag["stderr_bytes"] == len("NVME_TEMP_NORMAL_32C\n".encode())
        assert receipt_diag["output_bytes"] == receipt_diag["stdout_bytes"] + receipt_diag["stderr_bytes"]
        expected_sha = hashlib.sha256("NVME_SMART_HEALTH_OK\nNVME_TEMP_NORMAL_32C\n".encode()).hexdigest()
        assert receipt_diag["output_sha256"] == expected_sha
        assert "NVME_SMART" not in json.dumps(receipt_diag)
        assert "NVME_TEMP" not in json.dumps(receipt_diag)
        out_data = executor.get_output(wire_diag)
        assert out_data == {"stdout": "NVME_SMART_HEALTH_OK\n", "stderr": "NVME_TEMP_NORMAL_32C\n"}

        # Test bounded truncation at limit
        large_code = "import sys; sys.stdout.write('A' * 40000)"
        lease_trunc, wire_trunc = approve(large_code, output="bounded", output_limit_bytes=2048)
        assert executor.handle(wire_trunc)["state"] == "STARTED"
        receipt_trunc = poll(wire_trunc, {"SUCCEEDED", "FAILED"})
        assert receipt_trunc["state"] == "SUCCEEDED" and receipt_trunc["exit_code"] == 0, receipt_trunc
        assert receipt_trunc["output"] == "bounded"
        assert receipt_trunc["truncated"] is True
        assert receipt_trunc["output_bytes"] <= 2048
        out_trunc = executor.get_output(wire_trunc)
        assert out_trunc is not None and len(out_trunc["stdout"].encode()) <= 2048

        # Test nonzero exit code with error stderr capture
        fail_code = r"import sys; sys.stderr.write('DIAGNOSTIC_FAILURE\n'); raise SystemExit(3)"
        lease_fail, wire_fail = approve(fail_code, output="bounded")
        assert executor.handle(wire_fail)["state"] == "STARTED"
        receipt_fail = poll(wire_fail, {"SUCCEEDED", "FAILED"})
        assert receipt_fail["state"] == "FAILED" and receipt_fail["exit_code"] == 3, receipt_fail
        assert receipt_fail["output"] == "bounded"
        out_fail = executor.get_output(wire_fail)
        assert out_fail == {"stdout": "", "stderr": "DIAGNOSTIC_FAILURE\n"}

        # Test descendant keeping stdout/stderr open for >2 seconds writes and completes before deadline
        desc_holder_code = (
            r"import os, subprocess, sys, time; "
            r"p = subprocess.Popen([sys.executable, '-I', '-c', "
            r"'import time, sys; time.sleep(2.5); sys.stdout.write(\"LATE_DESCENDANT_OUTPUT\\n\"); sys.stderr.write(\"LATE_DESCENDANT_ERR\\n\")']); "
            r"sys.exit(0)"
        )
        lease_desc, wire_desc = approve(desc_holder_code, runtime=30, output="bounded")
        assert executor.handle(wire_desc)["state"] == "STARTED"
        receipt_desc = poll(wire_desc, {"SUCCEEDED", "FAILED"}, timeout=20)
        assert receipt_desc["state"] == "SUCCEEDED" and receipt_desc["exit_code"] == 0, receipt_desc
        assert receipt_desc["output"] == "bounded"
        assert receipt_desc["truncated"] is False
        assert receipt_desc["stdout_bytes"] == len("LATE_DESCENDANT_OUTPUT\n".encode())
        assert receipt_desc["stderr_bytes"] == len("LATE_DESCENDANT_ERR\n".encode())
        out_desc = executor.get_output(wire_desc)
        assert out_desc == {"stdout": "LATE_DESCENDANT_OUTPUT\n", "stderr": "LATE_DESCENDANT_ERR\n"}

        print(json.dumps({"result": "PASS", "backend": "real-systemd-cgroup-v2",
                          "positive_root_effect": True, "one_use_replay": "DENIED",
                          "invalid_approval": "DENIED", "cancel_descendants": "EMPTY",
                          "disconnected_ttl_descendants": "EMPTY", "diagnostic_output": "PASS"}))
    finally:
        for key in keys:
            for unit in (backend.unit(key), backend.timer(key) + ".timer", backend.timer(key) + ".service"):
                subprocess.run(["/usr/bin/systemctl", "stop", unit], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=10, check=False)
                subprocess.run(["/usr/bin/systemctl", "reset-failed", unit], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=10, check=False)
        shutil.rmtree(directory)


if __name__ == "__main__":
    main()
