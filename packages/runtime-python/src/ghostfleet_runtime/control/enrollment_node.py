"""Node-side CF-A claim/resume and Tailscale adapter. Never owns mint authority."""
from __future__ import annotations
import datetime as dt
import json
import math
import re
import secrets

from .enrollment_attempt import (PROTOCOL, SCHEMA_VERSION, ATTEMPT_RE, DIGEST_RE, STATES,
    AttemptError, HttpFetcher, _https_url, _post, digest, validate_manifest)

CAP = re.compile(r"[A-Za-z0-9_-]{32,128}")
DEVICE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
NODE_KEY = re.compile(r"nodekey:[0-9a-f]{64}")
RESUME_PATH = "/var/lib/fleet/converger-v1/resume.json"


def utc_epoch(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
        raise AttemptError("ATTEMPT_EXPIRY_INVALID")
    try:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc).timestamp()
    except ValueError:
        raise AttemptError("ATTEMPT_EXPIRY_INVALID") from None


class NodeAttempt:
    """Private handoff + root-only local resume. The courier owns attempt truth."""
    def __init__(self, handoff, manifest, store, fetcher=None, now=None):
        self.handoff = handoff
        self.manifest = validate_manifest(manifest)
        self.store = store
        self.fetcher = fetcher or HttpFetcher()
        self.now = now or (lambda: dt.datetime.now(dt.timezone.utc).timestamp())
        if (not isinstance(handoff, dict) or set(handoff) != {"protocol","node_uid","attempt_id","manifest_digest","client_binding","claim_code","courier_url","expires_at"}
            or handoff["protocol"] != PROTOCOL or handoff["node_uid"] != manifest["node_uid"]
            or handoff["manifest_digest"] != digest(manifest)
            or not isinstance(handoff["attempt_id"], str) or not ATTEMPT_RE.fullmatch(handoff["attempt_id"])
            or not isinstance(handoff["client_binding"], str) or not DIGEST_RE.fullmatch(handoff["client_binding"])
            or not isinstance(handoff["claim_code"], str) or not CAP.fullmatch(handoff["claim_code"])):
            raise AttemptError("HANDOFF_BINDING_INVALID")
        _https_url(handoff["courier_url"], root=True)
        utc_epoch(handoff["expires_at"])
        self.local = self.store.read_json(RESUME_PATH, secret=True, optional=True)
        if self.local and any(self.local.get(k) != handoff[k] for k in ("attempt_id","node_uid","manifest_digest","client_binding")):
            raise AttemptError("RESUME_BINDING_CONFLICT")
        if self.local and (self.local.get("owner") != "fleet-linux-converger/v1"
                           or not isinstance(self.local.get("resume_capability"), str) or not CAP.fullmatch(self.local["resume_capability"])
                           or type(self.local.get("join_dispatched")) is not bool
                           or type(self.local.get("session_not_after")) not in {int, float}
                           or not math.isfinite(self.local["session_not_after"])
                           or not 0 < self.local["session_not_after"] <= utc_epoch(handoff["expires_at"])
                           or "claim_request" not in self.local):
            raise AttemptError("RESUME_INVALID")

    def save(self):
        self.store.write_json(RESUME_PATH, self.local, secret=True)

    def call(self, action, token, **fields):
        body = {k:self.handoff[k] for k in ("protocol","node_uid","attempt_id","manifest_digest")}
        body.update(fields)
        result = _post(self.fetcher, self.handoff["courier_url"] + "/v1/attempts/" + self.manifest["node_uid"] + "/" + action, token, body)
        snapshot = result.get("snapshot", {})
        if (not isinstance(snapshot, dict) or snapshot.get("protocol") != PROTOCOL or snapshot.get("schema_version") != SCHEMA_VERSION
            or any(snapshot.get(k) != body[k] for k in ("node_uid","attempt_id","manifest_digest"))
            or snapshot.get("state") not in STATES or type(snapshot.get("revision")) is not int
            or snapshot["revision"] < 0 or type(result.get("duplicate")) is not bool
            or any(result.get(k) != snapshot.get(k) for k in ("attempt_id","revision","state"))
            or result.get("quarantined") is True):
            raise AttemptError("ATTEMPT_RESPONSE_BINDING_INVALID")
        if utc_epoch(snapshot.get("expires_at")) != utc_epoch(self.handoff["expires_at"]):
            raise AttemptError("ATTEMPT_EXPIRY_MISMATCH")
        return result

    def status(self, *, code=False):
        if code:
            # T2 additive metadata seam: code + exact binding, only before claim.
            return self.call("status", self.handoff["claim_code"], client_binding=self.handoff["client_binding"])
        if not self.local:
            raise AttemptError("RESUME_REQUIRED")
        return self.call("status", self.local["resume_capability"])

    def open(self):
        if self.now() >= utc_epoch(self.handoff["expires_at"]):
            raise AttemptError("ATTEMPT_EXPIRED_OWNER_RECONCILE")
        if not self.local:
            self.local = {"owner":"fleet-linux-converger/v1", **{k:self.handoff[k] for k in ("attempt_id","node_uid","manifest_digest","client_binding")},
                          "resume_capability":secrets.token_urlsafe(32), "claim_request":None, "join_dispatched":False,
                          "session_not_after": min(self.now()+300, utc_epoch(self.handoff["expires_at"]))}
            self.save()  # Must complete fsync before the first open-session request.
        try:
            return self.status()
        except AttemptError:
            pass
        # Read/CAS can race the minter. Bounded retry never changes resume or
        # requests a new attempt; expired/lost sessions fail closed.
        for _ in range(2):
            current = self.status(code=True)
            try:
                return self.call("open-session", self.handoff["claim_code"], client_binding=self.handoff["client_binding"],
                    resume_capability=self.local["resume_capability"], expected_revision=current["revision"],
                    request_id=f"open-{self.handoff['attempt_id']}-{current['revision']}")
            except AttemptError:
                try:
                    return self.status()
                except AttemptError:
                    continue
        raise AttemptError("SESSION_OPEN_UNKNOWN")

    def claim(self):
        current = self.open()
        if self.local["join_dispatched"] or current["state"] != "CREDENTIAL_READY":
            raise AttemptError("CLAIM_RECONCILIATION_REQUIRED")
        if self.now() >= utc_epoch(self.handoff["expires_at"]):
            raise AttemptError("ATTEMPT_EXPIRED_OWNER_RECONCILE")
        if self.local["claim_request"] is None:
            self.local["claim_request"] = {"request_id":"claim-"+self.handoff["attempt_id"], "expected_revision":current["revision"],
                                            "client_binding":self.handoff["client_binding"]}
            self.save()
        response = self.call("claim", self.local["resume_capability"], **self.local["claim_request"])
        secret = response.get("secret")
        if response["state"] != "RELEASED" or response["duplicate"] or not isinstance(secret, str) or not re.fullmatch(r"tskey-auth-[A-Za-z0-9_-]{10,200}", secret):
            raise AttemptError("CLAIM_RESPONSE_UNKNOWN")
        return secret

    def before_join(self):
        self.local["join_dispatched"] = True
        self.save()

    def authorize_join(self):
        # T2's session lasts at most 300 seconds from server open. Our persisted
        # bound starts BEFORE the first open request, so it is conservative and
        # can never be extended by retry/ACK loss. Check AFTER fence fsync and
        # again AFTER the authenticated read, immediately before provider I/O.
        deadline = min(self.local["session_not_after"], utc_epoch(self.handoff["expires_at"]))
        if self.now() >= deadline:
            raise AttemptError("JOIN_AUTHORITY_EXPIRED")
        current = self.status()
        if current["state"] != "RELEASED" or self.now() >= deadline:
            raise AttemptError("JOIN_AUTHORITY_EXPIRED_OR_CHANGED")

    def join_unknown(self):
        try:
            current = self.status()
            if current["state"] == "RELEASED":
                self.call("join-unknown", self.local["resume_capability"], client_binding=self.handoff["client_binding"],
                          expected_revision=current["revision"], request_id="join-unknown-"+self.handoff["attempt_id"])
        except AttemptError:
            pass  # Original durable RELEASED still fences a second claim/join.

    def complete(self, completion_digest):
        current = self.status()
        if current["state"] == "COMPLETE":
            if current["snapshot"].get("completion_digest") != completion_digest:
                raise AttemptError("COMPLETION_CONFLICT")
            return current
        if current["state"] != "JOIN_VERIFIED":
            raise AttemptError("INDEPENDENT_JOIN_PROOF_REQUIRED")
        try:
            result = self.call("complete", self.local["resume_capability"], expected_revision=current["revision"],
                               request_id="complete-"+self.handoff["attempt_id"], completion_digest=completion_digest)
            if result["state"] != "COMPLETE" or result["snapshot"].get("completion_digest") != completion_digest:
                raise AttemptError("COMPLETE_ACK_INVALID")
            return result
        except AttemptError:
            current = self.status()
            if current["state"] == "COMPLETE" and current["snapshot"].get("completion_digest") == completion_digest:
                return current
            raise AttemptError("COMPLETE_ACK_UNKNOWN") from None


class TailscaleNode:
    def __init__(self, runner):
        self.runner = runner

    def observe(self):
        code, raw = self.runner.run(["/usr/bin/tailscale", "status", "--self", "--peers=false", "--json"])
        if code != 0:
            raise AttemptError("TAILSCALE_STATE_UNKNOWN")
        try:
            data = json.loads(raw)
            state = data["BackendState"]
            own = data.get("Self")
            if state not in {"Running", "Stopped", "NeedsLogin", "NoState"}:
                raise ValueError()
            if own is None or (not own.get("ID") and not own.get("PublicKey")):
                if state not in {"NeedsLogin", "NoState"}:
                    raise ValueError()
                return {"state":state, "identity":None}
            if not DEVICE.fullmatch(own.get("ID", "")) or not NODE_KEY.fullmatch(own.get("PublicKey", "")):
                raise ValueError()
            return {"state":state, "identity":{"provider_device_id":own["ID"], "node_key":own["PublicKey"]}}
        except (KeyError, ValueError, TypeError, AttributeError):
            raise AttemptError("TAILSCALE_STATE_INVALID") from None

    def join(self, secret, node_id):
        # Auth key is pipe input, never an argument, environment value or file.
        code, _ = self.runner.run(["/usr/bin/tailscale", "up", "--auth-key=file:/dev/stdin", "--hostname="+node_id], input_text=secret, timeout=60)
        if code != 0:
            raise AttemptError("JOIN_OUTCOME_UNKNOWN")

    def resume(self):
        code, _ = self.runner.run(["/usr/bin/tailscale", "up"], timeout=30)
        if code != 0:
            raise AttemptError("TAILSCALE_RESUME_UNKNOWN")
