"""Regression cases for native observations and owned-plan boundaries."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import tempfile
import subprocess
from types import SimpleNamespace
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import native


class NativeTest(unittest.TestCase):
    def setUp(self):
        self.uid = "node-" + str(uuid4())
        self.now = datetime.now(timezone.utc)
        self.server = {"node_uid": self.uid, "server": "https://cluster.example.invalid:6443",
                       "node_name": "fixture", "version": "v1.35.10+k3s1",
                       "ca_sha256": "a" * 64, "sha256": "b" * 64}

    def test_plan_reclassifies_existing_native_owners_and_binds_artifact(self):
        current = {role: {"unit": "not-found", "activity": "inactive"} for role in ("k3s", "k3s-agent")}
        first = native.agent_plan(self.server, current)
        self.assertEqual(first["outcome"], "PREPARE_DEDICATED_AGENT")
        second = native.agent_plan({**self.server, "sha256": "c" * 64}, current)
        self.assertNotEqual(first["plan_sha256"], second["plan_sha256"])
        current["k3s"]["unit"] = "loaded"
        self.assertEqual(native.agent_plan(self.server, current)["outcome"], "OWNERSHIP_REVIEW")
        current["k3s"]["activity"] = "active"
        self.assertEqual(native.agent_plan(self.server, current)["outcome"], "OWNERSHIP_REVIEW")
        with self.assertRaises(native.NativeError):
            native.agent_plan({**self.server, "server": "http://cluster.example.invalid"}, current)

    def test_provider_reports_preserve_bound_identity_and_distinct_dimensions(self):
        inputs = {"node_uid": self.uid, "tailscale": {"device_id": "fixture", "credential_file": "unused"},
                  "cloudflare": {"account_id": "a" * 32, "tunnel_id": str(uuid4()), "credential_file": "unused"}}
        tailnet = {"nodeId": "fixture", "authorized": True, "connectedToControl": True, "lastSeen": None, "clientVersion": "1.90.2"}
        cloud = {"success": True, "result": {"id": inputs["cloudflare"]["tunnel_id"], "status": "healthy"}}
        with patch.object(native, "read", return_value=b"synthetic"), \
                patch.object(native, "request_json", side_effect=[tailnet, cloud]):
            observed = native.observations(inputs)
        self.assertEqual([(r["dimension"], r["verdict"]) for r in observed["observations"]],
                         [("network", "READY"), ("edge", "READY")])
        tailnet["nodeId"] = "another"
        with patch.object(native, "read", return_value=b"synthetic"), \
                patch.object(native, "request_json", side_effect=[tailnet, cloud]):
            observed = native.observations(inputs)
        self.assertEqual(observed["observations"][0]["verdict"], "UNKNOWN")
        self.assertEqual(observed["diagnostics"][0]["reason"], "TAILSCALE_IDENTITY_MISMATCH")

    def test_compute_readiness_requires_pinned_cluster_node_and_fresh_lease(self):
        cluster, node = str(uuid4()), str(uuid4())
        binding = {"kubeconfig": "unused", "context": "fixture", "cluster_uid": cluster,
                   "node_name": "fixture", "node_uid": node}
        config = {"clusters": [{"cluster": {"server": self.server["server"]}}]}
        kube_system = {"metadata": {"uid": cluster}}
        kube_node = {"metadata": {"uid": node}, "status": {"nodeInfo": {"kubeletVersion": self.server["version"]},
                     "conditions": [{"type": "Ready", "status": "True"}]}}
        old_lease = self.now - timedelta(seconds=100)
        for timestamp, verdict in ((self.now, "READY"), (old_lease, "UNAVAILABLE")):
            lease = {"spec": {"holderIdentity": "fixture", "renewTime": timestamp.isoformat()}}
            outputs = [type("Output", (), {"stdout": json.dumps(item).encode(), "returncode": 0})
                       for item in (config, kube_system, kube_node, lease)]
            with patch.object(native, "read"), patch.object(native, "kube", return_value=[]), \
                    patch.object(native, "command", side_effect=outputs):
                self.assertEqual(native.kubernetes(binding, lambda: self.now)["verdict"], verdict)
        # A recent lease for a different holder and an unpinned object cannot
        # establish readiness, even when the Node condition itself is Ready.
        lease = {"spec": {"holderIdentity": "different-node", "renewTime": self.now.isoformat()}}
        outputs = [SimpleNamespace(stdout=json.dumps(item).encode(), returncode=0)
                   for item in (config, kube_system, kube_node, lease)]
        with patch.object(native, "read"), patch.object(native, "kube", return_value=[]), \
                patch.object(native, "command", side_effect=outputs):
            self.assertEqual(native.kubernetes(binding, self.now)["verdict"], "UNAVAILABLE")
        for wrong_cluster, wrong_node, reason in [(True, False, "CLUSTER_PIN_MISMATCH"),
                                                   (False, True, "KUBE_NODE_PIN_MISMATCH")]:
            wrong_system = {"metadata": {"uid": str(uuid4())}} if wrong_cluster else kube_system
            wrong_object = {**kube_node, "metadata": {"uid": str(uuid4())}} if wrong_node else kube_node
            outputs = [SimpleNamespace(stdout=json.dumps(item).encode(), returncode=0)
                       for item in (config, wrong_system, wrong_object, lease)]
            with patch.object(native, "read"), patch.object(native, "kube", return_value=[]), \
                    patch.object(native, "command", side_effect=outputs), self.assertRaisesRegex(native.NativeError, reason):
                native.kubernetes(binding, self.now)

    def test_tailscale_control_connectivity_is_not_last_seen_recency(self):
        binding = {"device_id": "fixture", "credential_file": "unused"}
        cases = [({"authorized": True, "connectedToControl": True, "lastSeen": None}, "READY"),
                 ({"authorized": True, "connectedToControl": True, "lastSeen": "bad"}, "READY"),
                 ({"authorized": True, "connectedToControl": False, "lastSeen": self.now.isoformat()}, "UNAVAILABLE"),
                 ({"authorized": False, "connectedToControl": True}, "UNAVAILABLE"),
                 ({"authorized": True, "lastSeen": self.now.isoformat()}, "UNKNOWN"),
                 ({"authorized": True, "connectedToControl": "true"}, "UNKNOWN"),
                 ({"authorized": 1, "connectedToControl": True}, "UNKNOWN")]
        for fields, verdict in cases:
            with self.subTest(fields=fields), patch.object(native, "read", return_value=b"synthetic"), \
                    patch.object(native, "request_json", return_value={"nodeId": "fixture", **fields}):
                self.assertEqual(native.tailscale(binding, self.now)["verdict"], verdict)

    def test_freshness_boundaries_and_time_sample_after_io(self):
        for value, expected in [(self.now.isoformat(), True),
                                ((self.now - timedelta(seconds=90)).isoformat(), True),
                                ((self.now - timedelta(seconds=90, microseconds=1)).isoformat(), False),
                                ((self.now + timedelta(microseconds=1)).isoformat(), False),
                                (self.now.replace(tzinfo=None).isoformat(), False),
                                ("bad", False), (None, False)]:
            with self.subTest(expected=expected):
                self.assertEqual(native.fresh(value, self.now, 90), expected)
        # The clock is deliberately ahead of the initial observation: sample it
        # only after a provider call has finished, avoiding future-lease errors.
        done = self.now + timedelta(seconds=2)
        binding = {"device_id": "fixture", "credential_file": "unused"}
        calls = []
        def response(*args):
            calls.append("response")
            return {"nodeId": "fixture", "authorized": True, "connectedToControl": True}
        def clock():
            self.assertEqual(calls, ["response"])
            return done
        with patch.object(native, "read", return_value=b"synthetic"), \
                patch.object(native, "request_json", side_effect=response):
            result = native.tailscale(binding, clock)
        self.assertEqual(result["observed_at"], done.isoformat(timespec="milliseconds").replace("+00:00", "Z"))

    def test_ssh_failure_codes_do_not_publish_native_output(self):
        binding = {"host": "fixture.example.invalid", "port": 22, "login": "fixture",
                   "host_key": "ssh-ed25519 " + "a" * 64, "identity_file": "unused",
                   "transport": "direct", "dimension": "management"}
        cases = [(b"fixture@fixture.example.invalid: Permission denied (publickey).", "SSH_AUTHENTICATION_FAILED", "UNAVAILABLE"),
                 (b"Permission denied (publickey). private-detail", "SSH_PROBE_FAILED", "UNKNOWN"),
                 (b"Load key private-detail: Permission denied", "SSH_PROBE_FAILED", "UNKNOWN"),
                 (b"cloudflared: permission denied private-detail", "SSH_PROBE_FAILED", "UNKNOWN"),
                 (b"Host key verification failed. private-detail", "SSH_HOST_KEY_REJECTED", "UNAVAILABLE"),
                 (b"Connection refused private-detail", "SSH_CONNECTION_FAILED", "UNAVAILABLE"),
                 (b"unknown private-detail", "SSH_PROBE_FAILED", "UNKNOWN")]
        for stderr, reason, verdict in cases:
            with self.subTest(reason=reason), patch.object(native, "read"), \
                    patch.object(native.shutil, "which", return_value="/stub/ssh"), \
                    patch.object(native, "command", return_value=SimpleNamespace(returncode=255, stderr=stderr)):
                result = native.observations({"node_uid": self.uid, "ssh": [binding]})
            self.assertEqual(result["observations"][0]["verdict"], verdict)
            self.assertEqual(result["diagnostics"][0]["reason"], reason)
            self.assertNotIn("private-detail", json.dumps(result))
        with patch.object(native, "read"), patch.object(native.shutil, "which", return_value="/stub/ssh"), \
                patch.object(native, "command", return_value=SimpleNamespace(returncode=255,
                    stderr=b"fixture@fixture.example.invalid: Permission denied (publickey).")):
            self.assertEqual(native.ssh({**binding, "transport": "cloudflare"}, self.now)["verdict"], "UNKNOWN")
        with patch.object(native, "read"), patch.object(native.shutil, "which", return_value="/stub/ssh"), \
                patch.object(native, "command", return_value=SimpleNamespace(returncode=0, stderr=b"")):
            self.assertEqual(native.ssh(binding, self.now)["verdict"], "READY")
        with patch.object(native, "read"), patch.object(native.shutil, "which", return_value="/stub/ssh"), \
                patch.object(native, "command", side_effect=subprocess.TimeoutExpired("private-detail", 12)):
            result = native.observations({"node_uid": self.uid, "ssh": [binding]})
            self.assertEqual(result["diagnostics"][0]["reason"], "SSH_TIMEOUT")
            self.assertNotIn("private-detail", json.dumps(result))

    def test_existing_native_ownership_is_never_verified_from_unit_activity(self):
        empty = {role: {"unit": "not-found", "activity": "inactive"} for role in ("k3s", "k3s-agent")}
        cases = [{**empty, "k3s": {"unit": "loaded", "activity": "active"}},
                 {**empty, "k3s": {"unit": "not-found", "activity": "inactive", "binary_found": True}},
                 {**empty, "k3s-ownership": {"state": "detected"}},
                 {**empty, "k3s-ownership": {"state": "unknown"}}]
        with patch.object(native, "existing_k3s_paths", return_value=False):
            for current in cases:
                with self.subTest(current=current):
                    self.assertEqual(native.agent_plan(self.server, current)["outcome"], "OWNERSHIP_REVIEW")
        with patch.object(native, "existing_k3s_paths", return_value=True):
            self.assertEqual(native.agent_plan(self.server, empty)["outcome"], "OWNERSHIP_REVIEW")

    def test_discovery_includes_custom_inactive_units_and_inventory_uncertainty(self):
        def output(stdout=b"", code=0):
            return SimpleNamespace(stdout=stdout, returncode=code)
        for inventory, code, expected in [(b"", 0, "clear"),
                                           (b"custom-k3s.service disabled\n", 0, "detected"),
                                           ((native.AGENT_UNIT + " enabled\n").encode(), 0, "clear"),
                                           (b"", 1, "unknown")]:
            with self.subTest(expected=expected), \
                    patch.object(native, "existing_k3s_paths", return_value=False), \
                    patch.object(native.shutil, "which", return_value=None), \
                    patch.object(Path, "iterdir", return_value=iter(())), \
                    patch.object(native, "command", side_effect=[
                        *[output(b"LoadState=not-found\nActiveState=inactive\n") for _ in range(6)],
                        output(inventory, code), output()]):
                self.assertEqual(native.discover()["k3s-ownership"]["state"], expected)
        # Custom service names still expose a native k3s process name. No process
        # argv or environment is inspected by discovery.
        process = Path("/proc/123")
        with patch.object(native, "existing_k3s_paths", return_value=False), \
                patch.object(native.shutil, "which", return_value=None), \
                patch.object(Path, "iterdir", return_value=iter([process])), \
                patch.object(Path, "read_text", return_value="k3s\n") as read_name, \
                patch.object(native, "command", return_value=output()):
            self.assertEqual(native.discover()["k3s-ownership"]["state"], "detected")
            self.assertEqual(read_name.call_args.args, ())

    def test_discovery_accepts_only_verified_owned_main_process(self):
        def output(data=b"", code=0):
            return SimpleNamespace(stdout=data, returncode=code)
        for verified, processes, expected in [(True, ["123"], "owned"),
                                               (False, ["123"], "detected"),
                                               (True, ["123", "456"], "detected"),
                                               (True, [], "unknown")]:
            service_outputs = [output(b"LoadState=not-found\nActiveState=inactive\n") for _ in range(5)]
            service_outputs.append(output(b"LoadState=loaded\nActiveState=active\n"))
            with self.subTest(verified=verified, processes=processes), \
                    patch.object(native, "existing_k3s_paths", return_value=False), \
                    patch.object(native.shutil, "which", return_value=None), \
                    patch.object(native, "trusted_attachment", return_value={} if verified else None), \
                    patch.object(native, "owned_service_pid", return_value="123"), \
                    patch.object(Path, "iterdir", return_value=iter([Path("/proc") / pid for pid in processes])), \
                    patch.object(Path, "read_text", return_value="k3s\n"), \
                    patch.object(native, "command", side_effect=service_outputs + [output(), output()]):
                current = native.discover()
                self.assertEqual(current["k3s-ownership"]["state"], expected)
                if expected != "owned":
                    self.assertEqual(native.agent_plan(self.server, current)["outcome"], "OWNERSHIP_REVIEW")

    def test_owned_service_requires_exact_executable_command_and_cgroup(self):
        home = native.AGENT_HOME
        expected_argv = b"\0".join(part.encode() for part in
            (str(home / "k3s"), "agent", "--config", str(home / "config.json"))) + b"\0"
        properties = ("MainPID=123\nControlGroup=/system.slice/" + native.AGENT_UNIT +
                      "\nUser=\nEnvironment=\nEnvironmentFiles=\nDropInPaths=\n" +
                      "ExecStart={ path=" + str(home / "k3s") + " ; argv[]=" + str(home / "k3s") +
                      " agent --config " + str(home / "config.json") +
                      " ; ignore_errors=no ; start_time=x ; stop_time=x ; pid=123 ; code=0 ; status=0 }\n")
        for binary, argv, group, valid in [
                (home / "k3s", expected_argv, "0::/system.slice/" + native.AGENT_UNIT, True),
                (Path("/another/k3s"), expected_argv, "0::/system.slice/" + native.AGENT_UNIT, False),
                (home / "k3s", b"different-command\0", "0::/system.slice/" + native.AGENT_UNIT, False),
                (home / "k3s", expected_argv, "0::/another.service", False)]:
            def resolved(path, **kwargs):
                return binary if path == Path("/proc/123/exe") else path
            with self.subTest(valid=valid), \
                    patch.object(native, "command", return_value=SimpleNamespace(returncode=0, stdout=properties.encode())), \
                    patch.object(Path, "resolve", resolved), \
                    patch.object(Path, "read_bytes", return_value=argv), \
                    patch.object(Path, "read_text", return_value=group):
                if valid:
                    self.assertEqual(native.owned_service_pid(), "123")
                else:
                    with self.assertRaises(native.NativeError):
                        native.owned_service_pid()

    def test_invalid_lease_timestamp_is_unknown_while_expired_is_unavailable(self):
        cluster, node = str(uuid4()), str(uuid4())
        binding = {"kubeconfig": "unused", "context": "fixture", "cluster_uid": cluster,
                   "node_name": "fixture", "node_uid": node}
        config = {"clusters": [{"cluster": {"server": self.server["server"]}}]}
        system = {"metadata": {"uid": cluster}}
        obj = {"metadata": {"uid": node}, "status": {"nodeInfo": {"kubeletVersion": self.server["version"]},
               "conditions": [{"type": "Ready", "status": "True"}]}}
        for value in (None, "invalid", self.now.replace(tzinfo=None).isoformat(),
                      (self.now + timedelta(days=1)).isoformat()):
            lease = {"spec": {"holderIdentity": "fixture", "renewTime": value}}
            outputs = [SimpleNamespace(returncode=0, stdout=json.dumps(item).encode()) for item in
                       (config, system, obj, lease)]
            with self.subTest(value=value), patch.object(native, "read"), \
                    patch.object(native, "kube", return_value=[]), patch.object(native, "command", side_effect=outputs):
                result = native.observations({"node_uid": self.uid, "kubernetes": binding})
                self.assertEqual(result["observations"][0]["verdict"], "UNKNOWN")
                self.assertEqual(result["diagnostics"][0]["reason"], "INVALID_LEASE_TIME")

    def test_bootstrap_credential_parser_accepts_only_pinned_native_agent_type(self):
        token = "K10" + self.server["ca_sha256"] + "::abc123.0123456789abcdef"
        self.assertEqual(native.agent_token(token.encode(), "a" * 64), token)
        self.assertEqual(native.agent_token((token + "\n").encode(), "a" * 64), token)
        rejected = [None, "", b"", b"abc123.0123456789abcdef", b"\xff",
                    (token + "\n\n").encode(), (token + " ").encode(),
                    token.replace("abc123", "ABC123").encode(), token[:-1].encode(),
                    token.replace("::", "::server:").encode(),
                    token.replace("::", "::node:").encode(),
                    ("K10" + "a" * 64 + "::node:synthetic-password").encode(),
                    ("K10" + "a" * 64 + "::server:synthetic-password").encode(),
                    ("K10" + "a" * 64 + "::unknown:synthetic-password").encode()]
        for value in rejected:
            with self.subTest(value_type=type(value).__name__), self.assertRaises(native.NativeError):
                native.agent_token(value, "a" * 64)
        with self.assertRaisesRegex(native.NativeError, "AGENT_CA_PIN_MISMATCH"):
            native.agent_token(token.encode(), "c" * 64)

    def test_prepare_agent_positive_repeat_conflict_and_prewrite_rejection(self):
        # All inputs are synthetic; the artifact is never executed.
        data = b"synthetic artifact bytes"
        profile = {**self.server, "sha256": hashlib.sha256(data).hexdigest()}
        current = {role: {"unit": "not-found", "activity": "inactive"} for role in ("k3s", "k3s-agent")}
        plan = native.agent_plan(profile, current)
        token = ("K10" + "a" * 64 + "::abc123.0123456789abcdef").encode()
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "attachment"
            def local_read(path, **kwargs):
                if path == "credential":
                    return token
                if path == "artifact":
                    return data
                return Path(path).read_bytes()
            with patch.object(native, "AGENT_HOME", home), \
                    patch.object(native.os, "geteuid", return_value=0, create=True), \
                    patch.object(native, "discover", return_value=current), \
                    patch.object(native, "read", side_effect=local_read), \
                    patch.object(native, "command", return_value=SimpleNamespace(
                        returncode=0, stdout=("k3s version " + profile["version"]).encode())) as command:
                # Credential rejection occurs before artifact reads, mkdir or version execution.
                valid_token = token
                for token in (b"", ("K10" + "a" * 64 + "::server:synthetic-password").encode(),
                              ("K10" + "a" * 64 + "::node:synthetic-password").encode()):
                    with self.assertRaises(native.NativeError):
                        native.apply_agent(profile, plan["plan_sha256"], "artifact", "credential")
                    self.assertFalse(home.exists())
                    command.assert_not_called()
                token = valid_token
                # Test owns the temporary directory; emulate root ownership on Windows too.
                original_lstat = Path.lstat
                def local_lstat(path, *args, **kwargs):
                    info = original_lstat(path, *args, **kwargs)
                    return SimpleNamespace(st_mode=info.st_mode & ~0o022, st_uid=0) if path in (home, home.parent) or home in path.parents else info
                with patch.object(Path, "lstat", local_lstat):
                    self.assertEqual(native.apply_agent(profile, plan["plan_sha256"], "artifact", "credential"), "PREPARED")
                    self.assertEqual(native.apply_agent(profile, plan["plan_sha256"], "artifact", "credential"), "ALREADY_PREPARED")
                    self.assertEqual((home / "token").read_bytes(), valid_token)
                    self.assertEqual(command.call_count, 1)
                    # Same artifact/config/plan remains a no-op after the owner
                    # starts the verified dedicated service.
                    current[native.AGENT_UNIT] = {"unit": "loaded", "activity": "active"}
                    current["k3s-ownership"] = {"state": "owned"}
                    self.assertIsNotNone(native.trusted_attachment(profile))
                    self.assertEqual(native.apply_agent(profile, plan["plan_sha256"], "artifact", "credential"), "ALREADY_PREPARED")
                    self.assertEqual(command.call_count, 1)
                    changed = {**profile, "node_name": "another"}
                    self.assertEqual(native.agent_plan(changed, current)["outcome"], "OWNERSHIP_REVIEW")
                    for filename, replacement in (("config.json", b"{}"), ("k3s", b"other artifact"),
                                                  ("plan.json", b"{}")):
                        original = (home / filename).read_bytes()
                        (home / filename).write_bytes(replacement)
                        self.assertIsNone(native.trusted_attachment(profile))
                        self.assertEqual(native.agent_plan(profile, current)["outcome"], "OWNERSHIP_REVIEW")
                        (home / filename).write_bytes(original)
                    token = ("K10" + "a" * 64 + "::def456.0123456789abcdef").encode()
                    with self.assertRaisesRegex(native.NativeError, "EXISTING_ATTACHMENT_CONFLICT"):
                        native.apply_agent(profile, plan["plan_sha256"], "artifact", "credential")
                    self.assertEqual((home / "token").read_bytes(), valid_token)

    def test_cloudflare_transport_cannot_be_used_as_independent_rescue(self):
        with self.assertRaisesRegex(native.NativeError, "RESCUE_MUST_BE_INDEPENDENT"):
            native.ssh({"host": "rescue.example.invalid", "port": 22, "login": "fixture",
                        "host_key": "ssh-ed25519 " + "a" * 64, "identity_file": "unused",
                        "transport": "cloudflare", "dimension": "rescue"}, self.now)


if __name__ == "__main__":
    unittest.main()
