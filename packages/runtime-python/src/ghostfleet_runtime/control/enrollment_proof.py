"""Independent enrollment proof, on the controller side of an authenticated link.

The node invokes a pinned, private transport adapter. This module runs at the
other end, with trusted per-node configuration and device-read/reconciler tokens.
It cannot mint keys, change provider devices, or invent recovery evidence.
"""
from __future__ import annotations
import datetime as dt
import hashlib
import json
import re
import secrets
import urllib.parse

from .enrollment_attempt import (PROTOCOL, SCHEMA_VERSION, AttemptError, DIGEST_RE,
    EVIDENCE_RE, ATTEMPT_RE, HttpFetcher, Request, _https_url, _token, _post, digest)
from .enrollment_node import DEVICE, NODE_KEY, utc_epoch

PROOF = "fleet-enrollment-proof/v1"


def valid_identity(value):
    return (isinstance(value, dict) and set(value) == {"provider_device_id", "node_key"}
            and isinstance(value["provider_device_id"], str) and DEVICE.fullmatch(value["provider_device_id"])
            and isinstance(value["node_key"], str) and NODE_KEY.fullmatch(value["node_key"]))


class ProofAdapter:
    """Root-owned, digest-pinned transport executable; no shell or node credentials."""
    def __init__(self, system, config, now=None):
        self.system = system
        self.config = config
        self.now = now or (lambda: dt.datetime.now(dt.timezone.utc).timestamp())

    def verify(self, binding, identity, attempt_id=None):
        path = self.system.path(self.config["path"])
        self.system.trusted(path, executable=True)
        if "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest() != self.config["sha256"]:
            raise AttemptError("PROOF_ADAPTER_CHANGED")
        request = {"protocol": PROOF, "binding": binding, "identity": identity,
                   "attempt_id": attempt_id, "nonce": secrets.token_hex(32)}
        code, raw = self.system.runner.run([str(path)], input_text=json.dumps(request), timeout=30)
        try:
            result = json.loads(raw)
            if (code != 0 or result.get("protocol") != PROOF or result.get("ok") is not True
                    or result.get("request_digest") != digest(request) or result.get("identity") != identity
                    or result.get("recovery_ref") != binding["recovery_ref"]
                    or not EVIDENCE_RE.fullmatch(result.get("evidence_ref", ""))
                    or not 0 <= self.now() - utc_epoch(result.get("observed_at")) <= 60):
                raise ValueError()
            if attempt_id is not None and identity is not None:
                receipt = result.get("attempt", {})
                expected = join_evidence(attempt_id, identity, binding)
                if (receipt.get("attempt_id") != attempt_id or receipt.get("node_uid") != binding["manifest"]["node_uid"]
                        or receipt.get("manifest_digest") != digest(binding["manifest"])
                        or receipt.get("state") not in {"JOIN_VERIFIED", "COMPLETE"}
                        or receipt.get("join_evidence_ref") != expected):
                    raise ValueError()
            return result
        except (ValueError, TypeError, AttributeError):
            raise AttemptError("INDEPENDENT_PROOF_INVALID") from None


def join_evidence(aid, identity, binding):
    return "evidence:" + digest({"attempt_id": aid, "identity": identity, "binding": binding})[7:]


class EnrollmentReconciler:
    """Concrete remote proof handler; configuration is NOT supplied by the node.

    The private transport must authenticate an exact node to this fixed config.
    An arbitrary caller must never select a config by a self-asserted node UID.
    Recovery evidence is supplied by its independent owner, with bounded validity.
    """
    def __init__(self, config, *, device_token, reconciler_token=None, fetcher=None, now=None):
        self.config = config
        self.device_token = _token(device_token)
        self.reconciler_token = _token(reconciler_token) if reconciler_token else None
        if self.reconciler_token == self.device_token:
            raise AttemptError("PROVIDER_AND_COURIER_CAPABILITIES_MUST_DIFFER")
        self.fetcher = fetcher or HttpFetcher()
        self.now = now or (lambda: dt.datetime.now(dt.timezone.utc).timestamp())

    def handle(self, request):
        cfg = self.config
        if (not isinstance(request, dict) or set(request) != {"protocol", "binding", "identity", "attempt_id", "nonce"}
                or request["protocol"] != PROOF or request["binding"] != cfg["binding"]
                or not isinstance(request["nonce"], str) or not re.fullmatch(r"[0-9a-f]{64}", request["nonce"])):
            raise AttemptError("PROOF_TARGET_MISMATCH")
        recovery = cfg["recovery"]
        if (recovery["evidence_ref"] != cfg["binding"]["recovery_ref"] or recovery["class"] not in {"provider-console", "rescue-console", "physical-console"}
                or not 0 <= self.now() - utc_epoch(recovery["observed_at"]) <= 300
                or self.now() >= utc_epoch(recovery["expires_at"])):
            raise AttemptError("INDEPENDENT_RECOVERY_STALE")
        identity, aid = request["identity"], request["attempt_id"]
        receipt = None
        if aid is not None and (not isinstance(aid, str) or not ATTEMPT_RE.fullmatch(aid) or aid != cfg.get("attempt_id")):
            raise AttemptError("PROOF_ATTEMPT_MISMATCH")
        if identity is None:
            # Preflight recovery/target gate: no assertion that a device joined.
            if cfg.get("expected_identity") is not None and aid is not None:
                raise AttemptError("EXISTING_IDENTITY_CANNOT_REENROLL")
        else:
            if not valid_identity(identity):
                raise AttemptError("PROOF_IDENTITY_INVALID")
            expected = cfg.get("expected_identity")
            if expected is not None and expected != identity:
                raise AttemptError("PROVIDER_IDENTITY_CONFLICT")
            if expected is None and (aid is None or aid != cfg.get("attempt_id")):
                raise AttemptError("UNBOUND_NEW_DEVICE")
            self.device(identity, cfg["binding"]["manifest"]["tailscale_tags"])
            if aid is not None:
                receipt = self.reconcile(aid, identity, request)
        stamp = dt.datetime.fromtimestamp(self.now(), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return {"protocol": PROOF, "ok": True, "request_digest": digest(request), "identity": identity,
                "recovery_ref": recovery["evidence_ref"], "evidence_ref": "evidence:" + digest(request)[7:], "observed_at": stamp,
                "attempt": receipt}

    def device(self, identity, tags):
        # Fixed provider origin + exact Self.ID (NodeID), never hostname/list match.
        url = "https://api.tailscale.com/api/v2/device/" + urllib.parse.quote(identity["provider_device_id"], safe="")
        try:
            response = self.fetcher.fetch(Request(url, "GET", {"authorization": "Bearer " + self.device_token}))
            value = response.json() if response.ok else {}
            key = value.get("nodeKey", "")
            # API returns a raw hex key in some supported versions; local Self
            # serializes the typed nodekey prefix. Only that exact normalization.
            if isinstance(key, str) and re.fullmatch(r"[0-9a-f]{64}", key):
                key = "nodekey:" + key
            if (value.get("nodeId") != identity["provider_device_id"] or key != identity["node_key"]
                    or value.get("authorized") is not True or value.get("isEphemeral") is not False
                    or value.get("isExternal") is not False or value.get("os") != "linux"
                    or sorted(value.get("tags", [])) != sorted(tags)):
                raise AttemptError("EXACT_PROVIDER_PROOF_FAILED")
        except AttemptError:
            raise
        except Exception:
            raise AttemptError("PROVIDER_PROOF_UNKNOWN") from None

    def reconcile(self, aid, identity, request):
        if not self.reconciler_token:
            raise AttemptError("RECONCILER_AUTHORITY_REQUIRED")
        cfg = self.config
        binding = cfg["binding"]
        base = {"protocol": PROTOCOL, "node_uid": binding["manifest"]["node_uid"],
                "manifest_digest": digest(binding["manifest"]), "attempt_id": aid}
        origin = _https_url(cfg["courier_url"], root=True) + "/v1/attempts/" + base["node_uid"] + "/"

        def call(action, **fields):
            value = _post(self.fetcher, origin + action, self.reconciler_token, {**base, **fields})
            snap = value.get("snapshot", {})
            if (not isinstance(snap, dict) or any(snap.get(k) != v for k, v in base.items())
                    or snap.get("schema_version") != SCHEMA_VERSION or type(snap.get("revision")) is not int
                    or any(value.get(k) != snap.get(k) for k in ("attempt_id", "state", "revision"))
                    or value.get("quarantined") is True):
                raise AttemptError("RECONCILER_RESPONSE_INVALID")
            return value

        current = call("status")
        if current["state"] in {"RELEASED", "JOIN_UNKNOWN"}:
            try:
                current = call("verify-join", expected_revision=current["revision"], request_id="proof-"+aid,
                    evidence_ref=join_evidence(aid, identity, binding), **identity)
            except AttemptError:
                current = call("status")  # ACK loss never repeats an effect blindly.
        if (current["state"] not in {"JOIN_VERIFIED", "COMPLETE"}
                or current["snapshot"].get("join_evidence_ref") != join_evidence(aid, identity, binding)):
            raise AttemptError("JOIN_RECONCILIATION_REQUIRED")
        # Protected provider IDs/node keys are intentionally absent from the
        # accepted metadata schema. Our authorized exact proof commits this
        # deterministic reference; compare it, never invent extra snapshot keys.
        return {key: current["snapshot"].get(key) for key in
                ("attempt_id", "node_uid", "manifest_digest", "state", "join_evidence_ref", "completion_digest")}
