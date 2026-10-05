"""Attempt v1 HTTP client and minter orchestration; the courier owns durable state.

This module deliberately has no local attempt database or duplicate state machine.
Provider create is allowed only after a fresh, durably acknowledged reservation.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping

from .enrollment_v2_minter import (
    V2MinterError, V2_TAG, build_tailscale_key_request,
    exchange_oidc_for_access_token, mint_one_off_auth_key, validate_wif_config,
)

PROTOCOL = "fleet-enrollment-attempt/v1"
SCHEMA_VERSION = "1.0.0"
NODE_RE = re.compile(r"node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
ATTEMPT_RE = re.compile(NODE_RE.pattern.replace("node-", "attempt-"))
DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}")
EVIDENCE_RE = re.compile(r"evidence:[A-Za-z0-9._-]{1,128}")
STATES = frozenset({"PREPARED", "MINTING", "MINT_UNKNOWN", "MINTED", "CREDENTIAL_READY", "RELEASED", "JOIN_UNKNOWN", "JOIN_VERIFIED", "COMPLETE", "INVALIDATION_PENDING", "ABORTED"})
MAX_RESPONSE_BYTES = 65536


class AttemptError(Exception):
    """A fixed error code only: never interpolate HTTP bodies or credentials."""
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def validate_manifest(manifest: Any) -> dict[str, Any]:
    if not isinstance(V2_TAG,str) or re.fullmatch(r"tag:[a-z][a-z0-9-]{0,63}",V2_TAG) is None:
        raise AttemptError("TRUSTED_ENROLL_TAG_REQUIRED")
    fields = {"node_id", "node_uid", "os_family", "profile", "tailscale_tags"}
    if not isinstance(manifest, dict) or set(manifest) != fields:
        raise AttemptError("TRUSTED_MANIFEST_INVALID")
    if not isinstance(manifest["node_uid"], str) or NODE_RE.fullmatch(manifest["node_uid"]) is None:
        raise AttemptError("TRUSTED_MANIFEST_INVALID")
    if not isinstance(manifest["node_id"], str) or re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", manifest["node_id"]) is None:
        raise AttemptError("TRUSTED_MANIFEST_INVALID")
    if (manifest["os_family"], manifest["profile"], manifest["tailscale_tags"]) != ("debian-family", "managed-linux", [V2_TAG]):
        raise AttemptError("TRUSTED_MANIFEST_INVALID")
    return dict(manifest)


def _https_url(value: Any, *, root: bool = False, query: bool = False) -> str:
    if not isinstance(value, str) or len(value) > 2000 or any(ord(c) < 33 for c in value):
        raise AttemptError("HTTPS_CONFIG_INVALID")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or (parsed.query and not query):
        raise AttemptError("HTTPS_CONFIG_INVALID")
    if root and parsed.path not in ("", "/"):
        raise AttemptError("HTTPS_CONFIG_INVALID")
    return value.rstrip("/") if root else value


def _token(value: Any) -> str:
    if not isinstance(value, str) or not 32 <= len(value) <= 4096 or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise AttemptError("PRIVATE_AUTH_MISSING")
    return value


@dataclass(frozen=True)
class AttemptConfig:
    courier_url: str
    minter_token: str
    handoff_url: str
    handoff_token: str
    client_binding: str


def resolve_config(env: Mapping[str, str]) -> AttemptConfig:
    # No legacy admin-token fallback and no device-read/reconciler credential.
    binding = env.get("FLEET_ATTEMPT_CLIENT_BINDING", "")
    if DIGEST_RE.fullmatch(binding) is None:
        raise AttemptError("CLIENT_BINDING_MISSING")
    if re.fullmatch(r"[A-Za-z0-9_-]{32,128}", env.get("ENROLL_ATTEMPT_MINTER_TOKEN", "")) is None:
        raise AttemptError("PRIVATE_AUTH_MISSING")
    return AttemptConfig(
        _https_url(env.get("FLEET_ATTEMPT_COURIER_URL"), root=True),
        _token(env.get("ENROLL_ATTEMPT_MINTER_TOKEN")),
        _https_url(env.get("FLEET_ATTEMPT_HANDOFF_URL")),
        _token(env.get("FLEET_ATTEMPT_HANDOFF_TOKEN")), binding,
    )


@dataclass(frozen=True)
class Request:
    url: str
    method: str
    headers: dict[str, str]
    body: str | None = None


@dataclass(frozen=True)
class Response:
    status: int
    payload: Any

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def json(self) -> Any:
        return self.payload


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise AttemptError("HTTP_REDIRECT_FORBIDDEN")


class HttpFetcher:
    """Bounded HTTPS transport; no redirect, retry, response logging or disk cache."""
    def __init__(self, timeout: float = 15):
        self.timeout = timeout
        self.opener = urllib.request.build_opener(_NoRedirect())

    def fetch(self, request: Any) -> Response:
        _https_url(request.url, query=True)
        body = request.body.encode("utf-8") if request.body is not None else None
        if body is not None and len(body) > MAX_RESPONSE_BYTES:
            raise AttemptError("HTTP_REQUEST_TOO_LARGE")
        req = urllib.request.Request(request.url, data=body, method=request.method, headers=request.headers)
        try:
            with self.opener.open(req, timeout=self.timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise AttemptError("HTTP_RESPONSE_TOO_LARGE")
                return Response(response.status, json.loads(raw))
        except AttemptError:
            raise
        except urllib.error.HTTPError as exc:
            # Bodies may contain reflected credentials; do not read/forward them.
            return Response(exc.code, {})
        except Exception:
            raise AttemptError("HTTP_RESPONSE_UNKNOWN") from None


def _post(fetcher: Any, url: str, token: str, body: dict) -> dict:
    request = Request(url, "POST", {"authorization": f"Bearer {token}", "content-type": "application/json"}, json.dumps(body, separators=(",", ":")))
    try:
        response = fetcher.fetch(request)
        if not response.ok:
            raise AttemptError("REMOTE_CALL_REJECTED")
        data = response.json()
        if not isinstance(data, dict) or data.get("ok") is not True:
            raise AttemptError("REMOTE_ACK_INVALID")
        return data
    except AttemptError:
        raise
    except Exception:
        raise AttemptError("REMOTE_RESPONSE_UNKNOWN") from None


class AttemptClient:
    def __init__(self, config: AttemptConfig, manifest: dict, fetcher: Any):
        self.config = config
        self.manifest = validate_manifest(manifest)
        self.manifest_digest = digest(manifest)
        self.mint_request_digest = digest(build_tailscale_key_request(description="fleet-attempt-v1"))
        self.fetcher = fetcher
        self.attempt_id: str | None = None

    def call(self, action: str, **fields: Any) -> dict:
        body = {"protocol": PROTOCOL, "node_uid": self.manifest["node_uid"], "manifest_digest": self.manifest_digest}
        if self.attempt_id is not None:
            body["attempt_id"] = self.attempt_id
        body.update(fields)
        data = _post(self.fetcher, f"{self.config.courier_url}/v1/attempts/{self.manifest['node_uid']}/{action}", self.config.minter_token, body)
        snapshot = data.get("snapshot")
        if not isinstance(snapshot, dict) or snapshot.get("protocol") != PROTOCOL or snapshot.get("schema_version") != SCHEMA_VERSION:
            raise AttemptError("ATTEMPT_ACK_INVALID")
        aid = snapshot.get("attempt_id")
        if not isinstance(aid, str) or ATTEMPT_RE.fullmatch(aid) is None or (self.attempt_id and aid != self.attempt_id):
            raise AttemptError("ATTEMPT_IDENTITY_MISMATCH")
        if snapshot.get("node_uid") != self.manifest["node_uid"] or snapshot.get("manifest_digest") != self.manifest_digest:
            raise AttemptError("ATTEMPT_IDENTITY_MISMATCH")
        if snapshot.get("mint_request_digest") != self.mint_request_digest:
            raise AttemptError("ATTEMPT_IDENTITY_MISMATCH")
        expiry = snapshot.get("expires_at")
        try:
            if not isinstance(expiry, str) or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", expiry) is None:
                raise ValueError()
            datetime.datetime.strptime(expiry, "%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            raise AttemptError("ATTEMPT_EXPIRY_INVALID") from None
        if snapshot.get("state") not in STATES or type(snapshot.get("revision")) is not int or snapshot["revision"] < 0:
            raise AttemptError("ATTEMPT_ACK_INVALID")
        if any(data.get(key) != snapshot.get(key) for key in ("attempt_id", "revision", "state")) or type(data.get("duplicate")) is not bool:
            raise AttemptError("ATTEMPT_ACK_INVALID")
        self.attempt_id = aid
        return data

    def mutation(self, action: str, record: dict, **fields: Any) -> dict:
        return self.call(action, request_id=f"{action}-{self.attempt_id}", expected_revision=record["revision"], **fields)

    def status(self) -> dict:
        return self.call("status")


def _receipt(record: dict, outcome: str = "REENTERED") -> dict:
    # Deliberately allowlist instead of serializing the received snapshot.
    return {"protocol": PROTOCOL, "attempt_id": record["attempt_id"], "state": record["state"], "revision": record["revision"], "outcome": outcome,
            "reconcile_required": record["state"] in {"PREPARED", "MINTING", "MINT_UNKNOWN", "MINTED", "RELEASED", "JOIN_UNKNOWN", "INVALIDATION_PENDING"}, "sanitized": True}


def _unknown(client: AttemptClient, record: dict) -> dict:
    try:
        current = client.status()
        if current["state"] == "MINTING":
            current = client.mutation("mint-unknown", current)
        return _receipt(current, "RECONCILE_REQUIRED")
    except AttemptError:
        # No assertion about remote commit; durable reservation still fences mint.
        result = _receipt(record, "REMOTE_STATUS_UNKNOWN")
        result["reconcile_required"] = True
        return result


def _same_key_mutation(client: AttemptClient, action: str, record: dict, key_id: str, **fields: Any) -> dict:
    """Recover ACK loss using this process's same key, never provider create."""
    try:
        result = client.mutation(action, record, provider_key_id=key_id, **fields)
        allowed = {"MINTED"} if action == "mint-ack" else {"CREDENTIAL_READY"}
        if result["state"] not in allowed or result["snapshot"].get("provider_key_id") != key_id:
            raise AttemptError("SAME_KEY_RECONCILIATION_REQUIRED")
        return result
    except AttemptError:
        current = client.status()
        if current["snapshot"].get("provider_key_id") == key_id and current["state"] in {"CREDENTIAL_READY", "RELEASED", "JOIN_UNKNOWN", "JOIN_VERIFIED", "COMPLETE"}:
            return current
        if action == "mint-ack" and current["state"] == "MINTED" and current["snapshot"].get("provider_key_id") == key_id:
            return current
        expected_state = "MINTING" if action == "mint-ack" else "MINTED"
        if current["state"] == expected_state and (action == "mint-ack" or current["snapshot"].get("provider_key_id") == key_id):
            # State proves no ACK/deposit committed. A session-open may advance
            # revision; retry this same key once at the observed CAS generation.
            retried = client.mutation(action, current, provider_key_id=key_id, **fields)
            expected_result = "MINTED" if action == "mint-ack" else "CREDENTIAL_READY"
            if retried["snapshot"].get("provider_key_id") != key_id or retried["state"] != expected_result:
                raise AttemptError("SAME_KEY_RECONCILIATION_REQUIRED")
            return retried
        raise AttemptError("SAME_KEY_RECONCILIATION_REQUIRED")


def run_attempt_wif_mint(*, env: Mapping[str, str], oidc_token: str | Any, fetcher_wif: Any, fetcher_tailscale: Any,
                         fetcher_attempt: Any, fetcher_handoff: Any, manifest: dict, work_key: str) -> dict:
    config = resolve_config(env)
    wif = validate_wif_config(env)
    if not isinstance(work_key, str) or re.fullmatch(r"[A-Za-z0-9._:/#-]{1,200}", work_key) is None:
        raise AttemptError("WORK_KEY_REQUIRED")
    client = AttemptClient(config, manifest, fetcher_attempt)
    claim_code = secrets.token_urlsafe(32)
    prepared = client.call("prepare", work_key=work_key, manifest=manifest,
                           mint_request_digest=client.mint_request_digest,
                           client_binding=config.client_binding, claim_code=claim_code, ttl_seconds=600)
    if prepared["duplicate"] or prepared["state"] != "PREPARED":
        # A restart does not possess the original private handoff code or key.
        return _receipt(client.status())
    handoff = _post(fetcher_handoff, config.handoff_url, config.handoff_token,
                    {"protocol": PROTOCOL, "attempt_id": client.attempt_id, "node_uid": manifest["node_uid"],
                     "client_binding": config.client_binding, "claim_code": claim_code,
                     "courier_url": config.courier_url, "manifest_digest": client.manifest_digest,
                     "expires_at": prepared["snapshot"]["expires_at"]})
    evidence = handoff.get("evidence_ref")
    if not isinstance(evidence, str) or EVIDENCE_RE.fullmatch(evidence) is None:
        raise AttemptError("PRIVATE_HANDOFF_UNCONFIRMED")
    prepared = client.mutation("handoff", prepared, evidence_ref=evidence)
    # WIF is an auth_keys-only exchange, before consuming the mint reservation.
    token = oidc_token() if callable(oidc_token) else oidc_token
    access_token = exchange_oidc_for_access_token(fetcher=fetcher_wif, client_id=wif["client_id"], audience=wif["audience"], oidc_token=token)
    try:
        reserved = client.mutation("reserve", prepared)
    except AttemptError:
        # Never create after a lost reservation response, even if status=MINTING.
        return _unknown(client, prepared)
    if reserved["duplicate"] or reserved["state"] != "MINTING" or reserved["snapshot"].get("mint_reserved") is not True:
        return _receipt(client.status(), "RESERVATION_NOT_FRESH")
    # A response can arrive after its authority window. Validate wall-clock
    # expiry at the final dispatch boundary, not merely timestamp syntax.
    expires = datetime.datetime.strptime(reserved["snapshot"]["expires_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    if datetime.datetime.now(datetime.timezone.utc) >= expires:
        return _unknown(client, reserved)
    try:
        issued = mint_one_off_auth_key(fetcher=fetcher_tailscale, access_token=access_token, description="fleet-attempt-v1")
        key_id = issued["key_id"]
        if (not isinstance(key_id, str) or re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", key_id) is None
                or re.search(r"(?:tskey|token|secret)[-_]", key_id, re.I) or key_id == issued["auth_key"]):
            raise AttemptError("PROVIDER_KEY_ID_INVALID")
    except (V2MinterError, AttemptError):
        return _unknown(client, reserved)
    try:
        acknowledged = _same_key_mutation(client, "mint-ack", reserved, issued["key_id"])
        if acknowledged["state"] == "MINTED":
            deposited = _same_key_mutation(client, "deposit", acknowledged, issued["key_id"], secret=issued["auth_key"])
        else:
            deposited = acknowledged
        return _receipt(deposited, "CREDENTIAL_DEPOSITED")
    except AttemptError:
        return _unknown(client, reserved)


def read_oidc_token(env: Mapping[str, str], fetcher: Any) -> str:
    audience = validate_wif_config(env)["audience"]
    url = _https_url(env.get("ACTIONS_ID_TOKEN_REQUEST_URL"), query=True)
    token = _token(env.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN"))
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query = [(k, v) for k, v in query if k != "audience"] + [("audience", audience)]
    url = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))
    try:
        response = fetcher.fetch(Request(url, "GET", {"authorization": f"Bearer {token}"}))
        data = response.json() if response.ok else {}
        jwt = data.get("value")
        if not isinstance(jwt, str) or len(jwt) > 16384 or jwt.count(".") != 2:
            raise AttemptError("OIDC_UNAVAILABLE")
        return jwt
    except Exception:
        raise AttemptError("OIDC_UNAVAILABLE") from None
