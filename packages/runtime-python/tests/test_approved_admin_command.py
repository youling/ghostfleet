"""Real Ed25519/files/locks; the OS backend is injected in this unit suite."""
from __future__ import annotations
import base64
import hashlib
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

BASE = Path(__file__).parents[1] / "src/ghostfleet_runtime/resources/fleet/10_platforms/linux/common/operations/privileged"
if os.name == "posix":
    spec = importlib.util.spec_from_file_location("admin_command_tested", BASE/"fleet_admin_command.py")
    admin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(admin)
    spec = importlib.util.spec_from_file_location("admin_install_tested", BASE/"fleet_admin_install.py")
    install = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(install)


class FakeBackend:
    def __init__(self, *args):
        self.starts = 0
        self.stops = 0
        self.fail_start = False
        self.stop_ok = True
        self.observed = "STARTED"
        self.start_log = None

    def preflight(self):
        pass

    def start(self, key, deadline, max_runtime_seconds):
        self.starts += 1
        if self.start_log:
            fd = os.open(self.start_log, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            os.write(fd, (key+"\n").encode())
            os.close(fd)
        if self.fail_start:
            raise RuntimeError("not included in receipt")

    def stop(self, key):
        self.stops += 1
        return self.stop_ok

    def observe(self, key):
        return {"state":self.observed}


@unittest.skipUnless(os.name == "posix", "Linux adapter; Windows requires its own OS adapter")
class ApprovedAdminTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        for directory in ["state","cwd","bin"]:
            (self.root/directory).mkdir(mode=0o700)
        self.binary = self.root/"bin/probe"
        self.binary.write_bytes(b"fixture-not-an-os-executable")
        self.binary.chmod(0o755)
        self.private = Ed25519PrivateKey.generate()
        public = self.private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        node = "node-11111111-1111-4111-8111-111111111111"
        actor, generation, profile = "a"*64, "b"*64, "sha256:"+"c"*64
        self.write(self.root/"node.json", {"node_uid":node})
        self.write(self.root/"control.json", {"schema":"youling-fleet-privileged-operations-local/v2",
                   "ops_user":"ghostfleet-ops","generation":generation,"profile_generation":profile})
        self.cfg = {
            "schema":admin.CONFIG_SCHEMA,"node_uid":node,"subject_ref":actor,
            "audience_ref":"ghostfleet-approved-admin-command/v1","generation":generation,
            "profile_generation":profile,
            "issuer_keys":{"test-human":base64.b64encode(public).decode()},
            "state_dir":str(self.root/"state"),"python_executable":str(self.binary),
            "helper_path":str(self.binary),"node_report_path":str(self.root/"node.json"),
            "control_state_path":str(self.root/"control.json"),
            "max_ttl_seconds":120,"max_runtime_seconds":60,
        }
        self.write(self.root/"config.json", self.cfg)
        self.now = time.time()
        self.lease = {
            "schema":admin.LEASE_SCHEMA,"lease_id":"lease-test-0001",
            "request_id":"request-test-0001","operation_id":"operation-test-0001",
            "operation":"admin.command","issuer_id":"test-human","node_uid":node,
            "subject_ref":actor,"audience_ref":self.cfg["audience_ref"],
            "generation":generation,"profile_generation":profile,
            "work_ref":"synthetic/admin-command","purpose":"Synthetic approval only",
            "approval_ref":"approval-test-0001","rollback_ref":"synthetic/rollback",
            "issued_at":int(self.now)-1,"not_before":int(self.now)-1,"expires_at":int(self.now)+90,
            "max_uses":1,"max_runtime_seconds":30,
            "command":{"argv":[str(self.binary)],"cwd":str(self.root/"cwd"),"env":{},
                       "executable_sha256":hashlib.sha256(self.binary.read_bytes()).hexdigest(),"output":"discard"},
        }
        self.fs = admin.TrustedFiles(owner_uid=os.geteuid(), anchor=self.root)
        self.backend = FakeBackend()

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, path, value):
        path.write_bytes(admin.canonical(value)+b"\n")
        path.chmod(0o600)

    def wire(self, payload=None, action="execute"):
        payload = self.lease if payload is None else payload
        raw = admin.canonical(payload)
        return {"schema":admin.WIRE_SCHEMA,"action":action,"node_uid":self.cfg["node_uid"],
                "actor_ref":self.cfg["subject_ref"],"lease_b64":base64.b64encode(raw).decode(),
                "signature_b64":base64.b64encode(self.private.sign(admin.DOMAIN+raw)).decode()}

    def executor(self):
        return admin.Executor(self.root/"config.json", fs=self.fs, backend=self.backend, clock=lambda:self.now)

    def denied(self, wire, code=None):
        with self.assertRaises(admin.AdminError) as caught:
            self.executor().handle(wire)
        if code:
            self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.backend.starts, 0)

    def test_valid_signature_starts_without_claiming_completion(self):
        result = self.executor().handle(self.wire())
        self.assertEqual(result["state"], "STARTED")
        self.assertTrue(result["reconcile_required"])
        self.assertEqual(result["output"], "discarded")
        self.assertFalse(result["persistent_effects_rolled_back"])
        self.assertEqual(self.backend.starts, 1)

    def test_bad_signature_and_cross_actor_node_denial(self):
        cases = [("signature_b64",""),("signature_b64",base64.b64encode(b"x"*64).decode()),
                 ("actor_ref","d"*64),("node_uid","node-22222222-2222-4222-8222-222222222222")]
        for field,value in cases:
            with self.subTest(field=field,value=value[:8]):
                request = self.wire()
                request[field] = value
                self.denied(request)

    def test_signed_wrong_binding_bounds_and_paths(self):
        for mutation in ["expired","future","uses","issuer","generation","subject","node","argv"]:
            with self.subTest(mutation=mutation):
                lease = json.loads(json.dumps(self.lease))
                if mutation == "expired":
                    lease.update(issued_at=int(self.now)-30,not_before=int(self.now)-30,expires_at=int(self.now)-1)
                elif mutation == "future":
                    lease["not_before"] = int(self.now)+10
                elif mutation == "uses":
                    lease["max_uses"] = 2
                elif mutation == "issuer":
                    lease["issuer_id"] = "unknown-issuer"
                elif mutation == "generation":
                    lease["generation"] = "d"*64
                elif mutation == "subject":
                    lease["subject_ref"] = "d"*64
                elif mutation == "node":
                    lease["node_uid"] = "node-22222222-2222-4222-8222-222222222222"
                else:
                    lease["command"]["argv"][0] = "/bin/not-approved"
                self.denied(self.wire(lease))

    def test_payload_tamper_without_resigning(self):
        request = self.wire()
        changed = json.loads(base64.b64decode(request["lease_b64"]))
        changed["purpose"] = "tampered"
        request["lease_b64"] = base64.b64encode(admin.canonical(changed)).decode()
        self.denied(request, "ADMIN_SIGNATURE_INVALID")

    def test_duplicate_json_fields_fail_before_execution(self):
        raw = admin.canonical(self.lease).replace(b'"max_uses":1', b'"max_uses":1,"max_uses":2')
        request = self.wire()
        request.update(lease_b64=base64.b64encode(raw).decode(),
                       signature_b64=base64.b64encode(self.private.sign(admin.DOMAIN+raw)).decode())
        self.denied(request, "ADMIN_DUPLICATE_JSON_KEY")

    def test_lease_not_request_id_is_persistent_one_use_fence(self):
        self.executor().handle(self.wire())
        repeated = self.executor().handle(self.wire())
        self.assertTrue(repeated["duplicate"])
        changed = dict(self.lease,request_id="request-test-replacement")
        with self.assertRaisesRegex(admin.AdminError, "ADMIN_LEASE_ID_CONFLICT"):
            self.executor().handle(self.wire(changed))
        self.assertEqual(self.backend.starts,1)

    def test_unknown_start_persists_across_executor_recreation(self):
        self.backend.fail_start = True
        first = self.executor().handle(self.wire())
        self.assertEqual(first["state"],"UNKNOWN")
        self.assertFalse(first["retry_safe"])
        self.backend.fail_start = False
        second = self.executor().handle(self.wire())
        self.assertEqual(second["state"],"UNKNOWN")
        self.assertTrue(second["duplicate"])
        self.assertEqual(self.backend.starts,1)

    def test_cancel_before_dispatch_consumes_without_effect(self):
        result = self.executor().handle(self.wire(action="cancel"))
        self.assertEqual(result["state"],"REVOKED")
        result = self.executor().handle(self.wire())
        self.assertEqual(result["state"],"REVOKED")
        self.assertEqual(self.backend.starts,0)

    def test_cancel_running_confirms_stop_and_never_replays(self):
        self.executor().handle(self.wire())
        result = self.executor().handle(self.wire(action="cancel"))
        self.assertEqual(result["state"],"REVOKED")
        self.executor().handle(self.wire())
        self.assertEqual(self.backend.starts,1)

    def test_uncertain_cancel_stays_unknown_on_repeat(self):
        self.executor().handle(self.wire())
        self.backend.stop_ok = False
        for _ in range(2):
            result = self.executor().handle(self.wire(action="cancel"))
            self.assertEqual(result["state"],"UNKNOWN")
        self.executor().handle(self.wire())
        self.assertEqual(self.backend.starts,1)

    def test_expired_status_stops_but_does_not_claim_rollback(self):
        self.executor().handle(self.wire())
        self.now += 100
        result = self.executor().handle(self.wire(action="status"))
        self.assertEqual(result["state"],"EXPIRED")
        self.assertFalse(result["persistent_effects_rolled_back"])
        self.assertEqual(self.backend.stops,1)

    def test_writable_authority_executable_cwd_and_state_deny(self):
        paths = [self.root/"config.json",self.binary,self.root/"cwd",self.root/"state"]
        for path in paths:
            with self.subTest(path=path.name):
                original = path.stat().st_mode & 0o777
                path.chmod(0o777)
                try:
                    self.denied(self.wire())
                finally:
                    path.chmod(original)

    def test_symlink_state_cannot_overwrite_destination(self):
        ex = self.executor()
        destination = self.root/"unchanged"
        destination.write_text("keep")
        key = ex.ledger.key(self.lease["lease_id"])
        (self.root/"state/leases"/(key+".json")).symlink_to(destination)
        self.denied(self.wire(),"ADMIN_PATH_SYMLINK")
        self.assertEqual(destination.read_text(),"keep")

    def test_binary_content_drift_denies(self):
        self.binary.write_bytes(b"changed")
        self.denied(self.wire(),"ADMIN_EXECUTABLE_DIGEST_MISMATCH")

    def test_receipt_excludes_command_env_and_purpose(self):
        lease = json.loads(json.dumps(self.lease))
        secret = "SYNTHETIC_SECRET_SENTINEL"
        lease["command"]["argv"].append(secret)
        lease["command"]["env"] = {"TASK_VALUE":secret}
        lease["purpose"] = secret
        receipt = json.dumps(self.executor().handle(self.wire(lease)))
        self.assertNotIn(secret,receipt)
        self.assertNotIn("lease_b64",receipt)

    def test_loader_env_is_denied_even_with_signature(self):
        lease = json.loads(json.dumps(self.lease))
        lease["command"]["env"] = {"LD_PRELOAD":"/injected"}
        self.denied(self.wire(lease),"ADMIN_ENV_FORBIDDEN")

    def test_six_processes_consume_one_lease(self):
        self.backend.start_log = str(self.root/"starts.log")
        wire = self.wire()
        ctx = multiprocessing.get_context("fork")
        queue = ctx.Queue()
        def submit():
            try:
                queue.put(self.executor().handle(wire)["state"])
            except Exception as error:
                queue.put(type(error).__name__)
        workers = [ctx.Process(target=submit) for _ in range(6)]
        for worker in workers: worker.start()
        for worker in workers:
            worker.join(10)
            self.assertEqual(worker.exitcode,0)
        self.assertEqual([queue.get(timeout=1) for _ in workers],["STARTED"]*6)
        self.assertEqual(len((self.root/"starts.log").read_text().splitlines()),1)

    def test_cancel_and_child_spawn_share_one_lock(self):
        ex = self.executor()
        ex.handle(self.wire())
        key = ex.ledger.key(self.lease["lease_id"])
        entered,release,cancel_done = threading.Event(),threading.Event(),threading.Event()
        first,starts,errors = [True],[],[]
        def guard(_):
            if first[0]:
                first[0] = False
                entered.set()
                self.assertTrue(release.wait(5))
            return False
        class Process:
            def wait(self,timeout=None): return 0
        def popen(*a,**kw):
            self.assertFalse(cancel_done.is_set())
            starts.append(1)
            return Process()
        def child():
            try: admin.child(self.root/"config.json",key)
            except Exception as error: errors.append(error)
        def cancel():
            try: ex.handle(self.wire(action="cancel"))
            except Exception as error: errors.append(error)
            finally: cancel_done.set()
        with patch.object(admin,"TrustedFiles",lambda:self.fs), patch.object(admin.os,"geteuid",lambda:0), \
                patch.object(admin,"_other_unit_processes",guard),patch.object(admin.subprocess,"Popen",popen):
            t1 = threading.Thread(target=child);t1.start()
            self.assertTrue(entered.wait(5))
            t2 = threading.Thread(target=cancel);t2.start()
            self.assertFalse(cancel_done.wait(0.1))
            release.set()
            t1.join(5);t2.join(5)
            self.assertFalse(t1.is_alive() or t2.is_alive())
        self.assertEqual(errors,[])
        self.assertEqual(starts,[1])
        self.assertTrue(cancel_done.is_set())

    def test_cancel_winning_lock_prevents_spawn(self):
        ex = self.executor()
        ex.handle(self.wire(action="cancel"))
        key = ex.ledger.key(self.lease["lease_id"])
        def no_spawn(*a,**kw): self.fail("spawn after revocation")
        with patch.object(admin,"TrustedFiles",lambda:self.fs),patch.object(admin.os,"geteuid",lambda:0), \
                patch.object(admin.subprocess,"Popen",no_spawn):
            self.assertEqual(admin.child(self.root/"config.json",key),77)

    def test_backend_runtime_is_lease_budget_not_config_limit(self):
        cfg = dict(self.cfg,max_runtime_seconds=900)
        backend = admin.SystemdBackend(cfg,self.root/"config.json",self.fs)
        calls = []
        backend._run = lambda argv,timeout=8:calls.append(argv) or ""
        with patch.object(admin.time,"time",lambda:1000):
            backend.start("a"*64,1002,2)
        joined = "\n".join(" ".join(call) for call in calls)
        self.assertIn("--property=RuntimeMaxSec=2000ms",joined)
        self.assertNotIn("900s",joined)
        self.assertIn("--kill-who=all",joined)

    def test_failed_unit_with_no_main_pid_still_requires_empty_cgroup(self):
        backend = admin.SystemdBackend(self.cfg,self.root/"config.json",self.fs)
        base = self.root/"cgroups";base.mkdir(mode=0o700)
        backend.CGROUP_BASE = base
        key = "a"*64
        group = base/backend.unit(key);group.mkdir(mode=0o700)
        (group/"cgroup.events").write_text("populated 1\n")
        (group/"cgroup.procs").write_text("")
        child = group/"descendant";child.mkdir(mode=0o700)
        (child/"cgroup.procs").write_text("12345\n")
        backend._run = lambda argv,timeout=8:("LoadState=loaded\nActiveState=failed\nMainPID=0\n"
                                            "ControlGroup=/system.slice/"+backend.unit(key)+"\n")
        self.assertFalse(backend.stop(key))
        (group/"cgroup.events").write_text("populated 0\n")
        self.assertFalse(backend.stop(key))  # Even inconsistent/stale evidence denies.
        (child/"cgroup.procs").write_text("")
        self.assertTrue(backend.stop(key))

    def test_missing_systemd_is_explicit_denial(self):
        if Path("/proc/1/comm").read_text().strip() == "systemd":
            self.skipTest("positive OS proof belongs to disposable smoke")
        backend = admin.SystemdBackend(self.cfg,self.root/"config.json",self.fs)
        with self.assertRaisesRegex(admin.AdminError,"ADMIN_SYSTEMD_REQUIRED"):
            backend.preflight()

    def test_config_apply_verify_rollback(self):
        target = self.root/"installed.json"
        manager = install.Installer(target,fs=self.fs,backend_factory=FakeBackend)
        candidate = self.root/"config.json"
        expected = hashlib.sha256(candidate.read_bytes()).hexdigest()
        result = manager.apply(candidate,expected,"ABSENT")
        self.assertEqual(result["status"],"VERIFIED")
        self.assertEqual(target.stat().st_mode & 0o777,0o600)
        again = manager.apply(candidate,expected,result["config_sha256"])
        self.assertEqual(again["status"],"COMPLIANT")
        self.assertFalse(again["changed"])
        rolled_back = manager.rollback(result["config_sha256"])
        self.assertFalse(target.exists())
        self.assertTrue(rolled_back["receipts_retained"])

    def test_config_source_guard_has_zero_effect(self):
        target = self.root/"installed.json"
        manager = install.Installer(target,fs=self.fs,backend_factory=FakeBackend)
        with self.assertRaisesRegex(install.admin.AdminError,"ADMIN_INSTALL_SOURCE_MOVED"):
            manager.apply(self.root/"config.json","0"*64,"ABSENT")
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
