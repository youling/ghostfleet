"""Regression cases for native observations and owned-plan boundaries."""
from datetime import datetime, timedelta, timezone
import json
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
        self.assertEqual(native.agent_plan(self.server, current)["outcome"], "ADOPT_WITH_VERIFIED_BINDING")
        with self.assertRaises(native.NativeError):
            native.agent_plan({**self.server, "server": "http://cluster.example.invalid"}, current)

    def test_provider_reports_preserve_bound_identity_and_distinct_dimensions(self):
        inputs = {"node_uid": self.uid, "tailscale": {"device_id": "fixture", "credential_file": "unused"},
                  "cloudflare": {"account_id": "a" * 32, "tunnel_id": str(uuid4()), "credential_file": "unused"}}
        tailnet = {"nodeId": "fixture", "authorized": True, "lastSeen": self.now.isoformat(), "clientVersion": "1.90.2"}
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
                self.assertEqual(native.kubernetes(binding, self.now)["verdict"], verdict)

    def test_cloudflare_transport_cannot_be_used_as_independent_rescue(self):
        with self.assertRaisesRegex(native.NativeError, "RESCUE_MUST_BE_INDEPENDENT"):
            native.ssh({"host": "rescue.example.invalid", "port": 22, "login": "fixture",
                        "host_key": "ssh-ed25519 " + "a" * 64, "identity_file": "unused",
                        "transport": "cloudflare", "dimension": "rescue"}, self.now)


if __name__ == "__main__":
    unittest.main()
