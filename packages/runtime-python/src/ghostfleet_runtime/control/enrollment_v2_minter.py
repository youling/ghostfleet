"""Enrollment V2 R2 — GitHub OIDC → Tailscale WIF one-off credential minter.

Trusted authority path for Enrollment V2 without storing a long-lived
Tailscale OAuth client secret in GitHub, Cloudflare Worker or Fleet repo.

Target:
  GitHub Actions OIDC -> Tailscale Workload Identity Federation
  -> short-lived API authority (auth_keys only, exact tag)
  -> mint ONE disposable auth key -> deposit into courier -> sanitized receipt

Hard trust-boundary invariants (structurally enforced, not merely documented):

* no TAILSCALE_OAUTH_CLIENT_SECRET / TS_OAUTH_CLIENT_SECRET dependency
* no general Tailscale API key (`all` / `devices: core` with no broad scope)
* no policy / tagOwners mutation
* no caller-selected tags — exactly ``tag:fleet-ssh-target`` only
* no caller-selected tailnet — exactly ``-`` (trust credential default)
* no Cloudflare Tunnel authority
* OIDC claims expected to bind exact the explicitly configured deployment repository repo + workflow/ref/environment
* courier deposit via ephemeral request body / stdin memory only;
  auth key never becomes GitHub output / artifact / log / issue content
* missing WIF config fails closed BEFORE any mint / deposit
* deterministic fakes for OIDC / Tailscale / courier seams in tests;
  no live account contact in repo-only CI

``STATIC_TAILSCALE_SECRET = NONE``
``AUTHORITY = GITHUB_OIDC_TAILSCALE_WIF``
``SCOPE = auth_keys_ONLY``
``TAG = tag:fleet-ssh-target_ONLY``
``TAILNET_OVERRIDE = FORBIDDEN``

Human account gate (after repo acceptance): create ONE Tailscale workload
identity with issuer GitHub Actions, claim exact the explicitly configured deployment repository repo +
narrowest workflow/ref/environment, scope ``auth_keys`` only, tag exact
``tag:fleet-ssh-target`` only, copy non-secret Client ID + Audience into
repo's approved configuration surface (``vars``). Builder must not fabricate
values or broaden authority.

If #89 courier ingress is not yet merged, this module provides a fail-closed
seam/stub contract and refuses to mint or to handoff via
GitHub artifact / output / log / issue.
"""

from __future__ import annotations

import re
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Mapping

V2_TAG: str = __import__("os").environ.get("GHOSTFLEET_ENROLL_TAG", "")
V2_TAILNET: str = "-"  # trust credential default tailnet
V2_REUSABLE: bool = False
V2_EPHEMERAL: bool = False
V2_EXPIRY_SECONDS: int = 600  # <= 10 minutes, fixed
V2_EXPIRY_MIN_SECONDS: int = 60
V2_EXPIRY_MAX_SECONDS: int = 600
V2_PREAUTHORIZED: bool = True  # R0 golden path proven: canonical V2 server mint requires preauthorized=true

V2_WIF_CLIENT_ID_KEY: str = "TAILSCALE_WIF_CLIENT_ID"
V2_WIF_AUDIENCE_KEY: str = "TAILSCALE_WIF_AUDIENCE"
V2_COURIER_URL_KEY: str = "FLEET_COURIER_URL"
V2_COURIER_TOKEN_KEY: str = "FLEET_COURIER_TOKEN"
V2_COURIER_OIDC_AUDIENCE: str = "fleet-enroll-courier"
V2_HANDOFF_URL_KEY: str = "FLEET_ENROLLMENT_HANDOFF_URL"
V2_HANDOFF_TOKEN_KEY: str = "FLEET_ENROLLMENT_HANDOFF_TOKEN"
V2_HANDOFF_SITE_TOKEN_KEY: str = "FLEET_ENROLLMENT_HANDOFF_SITE_TOKEN"
V2_HANDOFF_PROTOCOL: str = "fleet-enrollment-private-handoff/v1"
V2_HANDOFF_PROTOCOL_PROVISIONAL: str = "fleet-enrollment-private-handoff/v2"
_PROVISIONAL_ENROLLMENT_RE = re.compile(r"^enroll-[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

TS_API_BASE: str = "https://api.tailscale.com/api/v2"

_SECRET_TOKEN_RE = re.compile(r"\b(tskey-[A-Za-z0-9_-]+|tskey-auth-[A-Za-z0-9_-]+)\b")
_OIDC_RE = re.compile(r"\beyJ[A-Za-z0-9_-]+\.eyJ")
_IP_RE = re.compile(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")
_COURIER_TICKET_RE = re.compile(r"^FE1(?:-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}){2}(?:(?:-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}){3})?$")

# These are secret-bearing field names, not substrings. In particular,
# ``authority.scope=auth_keys`` is a valid sanitized receipt field.
_FORBIDDEN_RECEIPT_KEYS = frozenset({"auth_key", "ticket", "oidc", "access_token", "site_token", "handoff_token", "authorization", "oai-sites-authorization"})
_RECEIPT_SECRET_RE = re.compile(r"gh[ops]_[A-Za-z0-9_]+|BEGIN[^\r\n]*PRIVATE", re.IGNORECASE)

FORBIDDEN_ENV_KEYS: frozenset[str] = frozenset(
    {
        "TAILSCALE_OAUTH_CLIENT_SECRET",
        "TS_OAUTH_CLIENT_SECRET",
        "TS_OAUTH_CLIENT_ID",
        "TS_API_KEY",
        "TAILSCALE_API_KEY",
        "TS_TAILNET",
        "TAILSCALE_TAILNET",
    }
)

ALLOWED_OIDC_REPOSITORY: str = __import__("os").environ.get("GHOSTFLEET_OIDC_REPOSITORY", "")


class V2MinterError(Exception):
    def __init__(self, code: str, detail: str = "", *, receipt: dict[str, Any] | None = None) -> None:
        self.code = code
        self.receipt = receipt
        super().__init__(f"{code}: {detail}" if detail else code)


def _non_empty(value: Any, max_len: int = 400) -> bool:
    return isinstance(value, str) and 0 < len(value.strip()) <= max_len


def validate_wif_config(env: Mapping[str, Any]) -> dict[str, str]:
    client_id = env.get(V2_WIF_CLIENT_ID_KEY)
    audience = env.get(V2_WIF_AUDIENCE_KEY)
    if not _non_empty(client_id, 300):
        raise V2MinterError("WIF_CONFIG_MISSING", f"{V2_WIF_CLIENT_ID_KEY} is required")
    if not _non_empty(audience, 300):
        raise V2MinterError("WIF_CONFIG_MISSING", f"{V2_WIF_AUDIENCE_KEY} is required")
    cid = str(client_id).strip()
    aud = str(audience).strip()
    if len(cid) < 8 or len(aud) < 3:
        raise V2MinterError("WIF_CONFIG_INVALID", "client_id / audience too short")
    if _SECRET_TOKEN_RE.search(cid) or _SECRET_TOKEN_RE.search(aud):
        raise V2MinterError("WIF_CONFIG_INVALID", "client_id / audience must not be a secret token")
    if " " in cid or " " in aud:
        raise V2MinterError("WIF_CONFIG_INVALID", "client_id / audience must not contain spaces")
    return {"client_id": cid, "audience": aud}


def validate_fixed_mint_semantics(
    *,
    tags: list[str] | None = None,
    tailnet: str | None = None,
    reusable: bool | None = None,
    ephemeral: bool | None = None,
    expiry_seconds: int | None = None,
    preauthorized: bool | None = None,
) -> None:
    if not isinstance(V2_TAG,str) or not re.fullmatch(r"tag:[a-z][a-z0-9-]{0,63}",V2_TAG):
        raise V2MinterError("TRUSTED_ENROLL_TAG_REQUIRED")
    if tailnet is not None and tailnet != V2_TAILNET:
        raise V2MinterError("TAILNET_OVERRIDE_FORBIDDEN", f"tailnet must be {V2_TAILNET!r}")
    if tags is not None:
        if tags != [V2_TAG]:
            raise V2MinterError("TAG_WIDENING_FORBIDDEN", f"tags must be exactly [{V2_TAG!r}]")
    if reusable is not None and reusable is not V2_REUSABLE:
        raise V2MinterError("REUSABLE_WIDENING_FORBIDDEN", "reusable must be false")
    if ephemeral is not None and ephemeral is not V2_EPHEMERAL:
        raise V2MinterError("EPHEMERAL_WIDENING_FORBIDDEN", "ephemeral must be false")
    if expiry_seconds is not None:
        if not isinstance(expiry_seconds, int) or expiry_seconds < V2_EXPIRY_MIN_SECONDS or expiry_seconds > V2_EXPIRY_MAX_SECONDS:
            raise V2MinterError("EXPIRY_WIDENING_FORBIDDEN", f"expiry must be {V2_EXPIRY_MIN_SECONDS}..{V2_EXPIRY_MAX_SECONDS} seconds")
    if preauthorized is not None and not isinstance(preauthorized, bool):
        raise V2MinterError("PREAUTHORIZED_OVERRIDE_FORBIDDEN", "preauthorized must be a boolean (fixed by account posture, never caller input)")


def build_tailscale_key_request(*, description: str = "fleet-enroll-v2-r2") -> dict[str, Any]:
    desc = description.strip() if isinstance(description, str) and description.strip() else "fleet-enroll-v2-r2"
    if len(desc) > 120:
        desc = desc[:120]
    validate_fixed_mint_semantics(
        tags=[V2_TAG],
        tailnet=V2_TAILNET,
        reusable=V2_REUSABLE,
        ephemeral=V2_EPHEMERAL,
        expiry_seconds=V2_EXPIRY_SECONDS,
        preauthorized=V2_PREAUTHORIZED,
    )
    return {
        "capabilities": {"devices": {"create": {"reusable": V2_REUSABLE, "ephemeral": V2_EPHEMERAL, "preauthorized": V2_PREAUTHORIZED, "tags": [V2_TAG]}}},
        "expirySeconds": V2_EXPIRY_SECONDS,
        "description": desc,
    }


def build_tailscale_key_url(*, tailnet: str = V2_TAILNET) -> str:
    if tailnet != V2_TAILNET:
        raise V2MinterError("TAILNET_OVERRIDE_FORBIDDEN")
    return f"{TS_API_BASE}/tailnet/{tailnet}/keys"


@dataclass(frozen=True)
class CourierConfig:
    url: str
    token: str
    auth_kind: str = "static"


@dataclass(frozen=True)
class PrivateHandoffConfig:
    url: str
    token: str = field(repr=False)
    site_token: str | None = field(default=None, repr=False)
    profile: str = "generic"
    expected_url: str | None = None


def resolve_private_handoff_config(env: Mapping[str, Any]) -> PrivateHandoffConfig | None:
    url = env.get(V2_HANDOFF_URL_KEY)
    token = env.get(V2_HANDOFF_TOKEN_KEY)
    site_token = env.get(V2_HANDOFF_SITE_TOKEN_KEY)
    if site_token == "":
        site_token = None
    if url is None and token is None and site_token is None:
        return None
    if not _non_empty(url, 600) or not _non_empty(token, 1000):
        raise V2MinterError("HANDOFF_CONFIG_INVALID", "both handoff URL and token are required")
    import urllib.parse

    parsed = urllib.parse.urlsplit(str(url).strip())
    if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path != "/api/enrollment/handoff"):
        raise V2MinterError("HANDOFF_CONFIG_INVALID", "handoff URL must be exact HTTPS /api/enrollment/handoff ingress")
    secret = str(token).strip()
    if len(secret) < 32:
        raise V2MinterError("HANDOFF_CONFIG_INVALID", "handoff token too short")
    if any(ch.isspace() for ch in secret):
        raise V2MinterError("HANDOFF_CONFIG_INVALID", "handoff token must be a single bearer value")
    profile = env.get("GHOSTFLEET_HANDOFF_PROFILE", "generic")
    expected_url = env.get("GHOSTFLEET_HANDOFF_EXPECTED_URL")
    if profile == "generic":
        if site_token is not None:
            raise V2MinterError("HANDOFF_COMPAT_PROFILE_REQUIRED")
    elif profile == "sites-v1":
        from ghostfleet_runtime.compat.sites import sites_handoff_headers
        try:
            sites_handoff_headers(url=str(url).strip(), expected_url=expected_url, token=secret, site_token=site_token)
        except ValueError as exc:
            raise V2MinterError(str(exc)) from None
    else:
        raise V2MinterError("HANDOFF_PROFILE_UNSUPPORTED")
    return PrivateHandoffConfig(url=str(url).strip(), token=secret, site_token=site_token, profile=profile, expected_url=expected_url)


def _handoff_headers(handoff: PrivateHandoffConfig) -> dict[str, str]:
    headers = {"authorization": f"Bearer {handoff.token}", "content-type": "application/json"}
    if handoff.profile == "sites-v1":
        from ghostfleet_runtime.compat.sites import sites_handoff_headers
        try:
            return sites_handoff_headers(url=handoff.url, expected_url=handoff.expected_url, token=handoff.token, site_token=handoff.site_token)
        except ValueError as exc:
            raise V2MinterError(str(exc)) from None
    if handoff.profile != "generic" or handoff.site_token is not None:
        raise V2MinterError("HANDOFF_COMPAT_PROFILE_REQUIRED")
    return headers


def preflight_private_handoff(*, fetcher: Any, handoff: PrivateHandoffConfig) -> None:
    """Prove both ingress gates before mint using an intentionally invalid envelope.

    The canonical sink authenticates before validating protocol. Its exact 400
    rejection proves authentication and performs no ticket insertion/deletion.
    HTML, redirects, arbitrary 400s and transport uncertainty are not a proof.
    """
    request = _build_request(url=handoff.url, method="POST", headers=_handoff_headers(handoff), body="{}")
    try:
        response = fetcher.fetch(request)
    except Exception as exc:
        raise V2MinterError("PRIVATE_HANDOFF_PREFLIGHT_UNKNOWN", type(exc).__name__) from None
    if response is None or getattr(response, "status", 503) in (401, 403):
        raise V2MinterError("PRIVATE_HANDOFF_PREFLIGHT_FORBIDDEN")
    try:
        data = response.json()
    except Exception:
        data = None
    if (getattr(response, "status", 503) != 400 or not isinstance(data, dict)
            or data.get("error") != "ENROLLMENT_HANDOFF_PROTOCOL_INVALID"):
        raise V2MinterError("PRIVATE_HANDOFF_PREFLIGHT_INVALID")


def resolve_courier_config(env: Mapping[str, Any], *, oidc_token: str | None = None) -> CourierConfig | None:
    url = env.get(V2_COURIER_URL_KEY)
    token = env.get(V2_COURIER_TOKEN_KEY)
    auth_kind = "static"
    if url is None:
        url = env.get("FLEET_COURIER_ADMIN_URL")
    if token is None:
        token = env.get("FLEET_COURIER_ADMIN_TOKEN")
    if token is None and isinstance(oidc_token, str) and oidc_token.count(".") == 2:
        token = oidc_token
        auth_kind = "github_oidc"
    if not _non_empty(url, 600) or not _non_empty(token, 8192):
        return None
    u = str(url).strip()
    t = str(token).strip()
    import urllib.parse

    parsed = urllib.parse.urlsplit(u)
    if parsed.scheme != "https" or not parsed.netloc:
        raise V2MinterError("COURIER_CONFIG_INVALID", "courier URL must be https")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path != "/v1/admin/tickets":
        raise V2MinterError("COURIER_CONFIG_INVALID", "courier URL must be the exact /v1/admin/tickets ingress")
    if auth_kind == "static" and len(t) < 16:
        raise V2MinterError("COURIER_CONFIG_INVALID", "courier token too short")
    if auth_kind == "github_oidc" and (len(t) < 100 or len(t) > 8192):
        raise V2MinterError("COURIER_CONFIG_INVALID", "courier OIDC token has invalid shape")
    return CourierConfig(url=u, token=t, auth_kind=auth_kind)


def _sha256_text(value: str) -> str:
    import hashlib
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _private_handoff_payload(*, ticket: str, expires_at: int, manifest: Mapping[str, Any]) -> dict[str, Any]:
    if _COURIER_TICKET_RE.fullmatch(ticket or "") is None:
        raise V2MinterError("PRIVATE_HANDOFF_TICKET_INVALID")
    if not isinstance(expires_at, int) or expires_at <= int(time.time() * 1000):
        raise V2MinterError("PRIVATE_HANDOFF_EXPIRY_INVALID")
    node_id = manifest.get("node_id")
    node_uid = manifest.get("node_uid")
    if not _non_empty(node_id, 128):
        raise V2MinterError("PRIVATE_HANDOFF_IDENTITY_INVALID")
    payload = {
        "protocol": V2_HANDOFF_PROTOCOL,
        "identity_kind": "canonical",
        "node_id": str(node_id),
        "node_uid": str(node_uid) if node_uid else None,
        "ticket": ticket,
        "ticket_digest": "sha256:" + _sha256_text(ticket),
        "expires_at": expires_at,
        "manifest_digest": "sha256:" + _sha256_text(json.dumps(dict(manifest), sort_keys=True, separators=(",", ":"))),
    }
    if manifest.get("identity_kind") == "provisional":
        enrollment_id = manifest.get("enrollment_id")
        if node_uid is not None or _PROVISIONAL_ENROLLMENT_RE.fullmatch(str(enrollment_id or "")) is None:
            raise V2MinterError("PRIVATE_HANDOFF_IDENTITY_INVALID")
        payload.update(protocol=V2_HANDOFF_PROTOCOL_PROVISIONAL, identity_kind="provisional", enrollment_id=str(enrollment_id))
    elif not _non_empty(node_uid, 128):
        raise V2MinterError("PRIVATE_HANDOFF_IDENTITY_INVALID")
    return payload


def handoff_private_ticket(*, fetcher: Any, handoff: PrivateHandoffConfig, ticket: str, expires_at: int, manifest: Mapping[str, Any]) -> dict[str, Any]:
    if fetcher is None or not hasattr(fetcher, "fetch"):
        raise V2MinterError("PRIVATE_HANDOFF_FETCHER_UNAVAILABLE")
    payload = _private_handoff_payload(ticket=ticket, expires_at=expires_at, manifest=manifest)
    request = _build_request(
        url=handoff.url,
        method="POST",
        headers=_handoff_headers(handoff),
        body=json.dumps(payload),
    )
    try:
        response = fetcher.fetch(request)
    except Exception as exc:  # noqa: BLE001
        raise V2MinterError("PRIVATE_HANDOFF_UNKNOWN", str(type(exc).__name__)) from None
    if response is None or getattr(response, "status", 503) in (401, 403):
        raise V2MinterError("PRIVATE_HANDOFF_FORBIDDEN")
    if not getattr(response, "ok", False):
        raise V2MinterError("PRIVATE_HANDOFF_REJECTED")
    try:
        data = response.json() if hasattr(response, "json") else json.loads(response.text() if hasattr(response, "text") else "{}")
    except Exception:  # noqa: BLE001
        raise V2MinterError("PRIVATE_HANDOFF_ACK_INVALID") from None
    if not isinstance(data, dict) or data.get("ok") is not True or data.get("protocol") != payload["protocol"]:
        raise V2MinterError("PRIVATE_HANDOFF_ACK_INVALID")
    if data.get("ticket_digest") != payload["ticket_digest"] or data.get("identity_kind", "canonical") != payload["identity_kind"]:
        raise V2MinterError("PRIVATE_HANDOFF_ACK_MISMATCH")
    if payload["identity_kind"] == "provisional":
        if data.get("enrollment_id") != payload.get("enrollment_id"):
            raise V2MinterError("PRIVATE_HANDOFF_ACK_MISMATCH")
    elif data.get("node_uid") != payload["node_uid"]:
        raise V2MinterError("PRIVATE_HANDOFF_ACK_MISMATCH")
    raw = json.dumps(data, ensure_ascii=False)
    if ticket in raw or _SECRET_TOKEN_RE.search(raw) or _OIDC_RE.search(raw):
        raise V2MinterError("PRIVATE_HANDOFF_ACK_SECRET_ECHO")
    return {"handoff_ok": True, "ticket_digest": payload["ticket_digest"]}


def revoke_tailscale_key(*, fetcher: Any, access_token: str, key_id: str, tailnet: str = V2_TAILNET) -> dict[str, Any]:
    if fetcher is None or not hasattr(fetcher, "fetch"):
        raise V2MinterError("TS_REVOKE_FETCHER_UNAVAILABLE")
    if not _non_empty(access_token, 4096) or not _non_empty(key_id, 200):
        raise V2MinterError("TS_REVOKE_INVALID")
    validate_fixed_mint_semantics(tailnet=tailnet)
    url = f"{TS_API_BASE}/tailnet/{tailnet}/keys/{key_id}"
    request = _build_request(
        url=url, method="DELETE",
        headers={"authorization": f"Bearer {access_token}"}, body=None,
    )
    try:
        response = fetcher.fetch(request)
    except Exception as exc:  # noqa: BLE001
        raise V2MinterError("TS_REVOKE_UNKNOWN", str(type(exc).__name__)) from None
    if response is None or getattr(response, "status", 503) in (401, 403):
        raise V2MinterError("TS_REVOKE_UNKNOWN")
    if not getattr(response, "ok", False):
        raise V2MinterError("TS_REVOKE_UNKNOWN")
    return {"revoked": True}


def revoke_courier_ticket(*, fetcher: Any, courier: CourierConfig, ticket: str) -> dict[str, Any]:
    if fetcher is None or not hasattr(fetcher, "fetch") or _COURIER_TICKET_RE.fullmatch(ticket or "") is None:
        raise V2MinterError("COURIER_REVOKE_INVALID")
    import urllib.parse
    parsed = urllib.parse.urlsplit(courier.url)
    revoke_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/v1/admin/revoke", "", ""))
    request = _build_request(
        url=revoke_url,
        method="POST",
        headers={"authorization": f"Bearer {courier.token}", "content-type": "application/json"},
        body=json.dumps({"ticket_hash": _sha256_text(ticket)}),
    )
    try:
        response = fetcher.fetch(request)
    except Exception as exc:  # noqa: BLE001
        raise V2MinterError("COURIER_REVOKE_UNKNOWN", str(type(exc).__name__)) from None
    if response is None or not getattr(response, "ok", False):
        raise V2MinterError("COURIER_REVOKE_UNKNOWN")
    try:
        data = response.json() if hasattr(response, "json") else json.loads(response.text() if hasattr(response, "text") else "{}")
    except Exception:  # noqa: BLE001
        raise V2MinterError("COURIER_REVOKE_UNKNOWN") from None
    if not isinstance(data, dict) or data.get("ok") is not True or data.get("state") != "REVOKED":
        raise V2MinterError("COURIER_REVOKE_UNKNOWN")
    return {"revoked": True}


def exchange_oidc_for_access_token(*, fetcher: Any, client_id: str, audience: str, oidc_token: str) -> str:
    if not _non_empty(client_id) or not _non_empty(audience) or not _non_empty(oidc_token, 4096):
        raise V2MinterError("WIF_EXCHANGE_MISSING_INPUT")
    if oidc_token.count(".") != 2:
        raise V2MinterError("OIDC_TOKEN_INVALID")
    if fetcher is None or not hasattr(fetcher, "fetch"):
        raise V2MinterError("WIF_FETCHER_UNAVAILABLE")
    # Official WIF contract (revalidated 2026-09-14): POST /api/v2/oauth/token-exchange
    # with application/x-www-form-urlencoded fields client_id + jwt.
    # `audience` is used to request the GitHub OIDC JWT, not in the exchange.
    import urllib.parse

    body = urllib.parse.urlencode({"client_id": client_id, "jwt": oidc_token})
    request = _build_request(url=f"{TS_API_BASE}/oauth/token-exchange", method="POST", headers={"content-type": "application/x-www-form-urlencoded"}, body=body)
    try:
        response = fetcher.fetch(request)
    except Exception as exc:  # noqa: BLE001
        raise V2MinterError("WIF_EXCHANGE_UNREACHABLE", str(type(exc).__name__)) from None
    if response is None or getattr(response, "status", 503) in (401, 403):
        raise V2MinterError("WIF_EXCHANGE_FORBIDDEN")
    if not getattr(response, "ok", False):
        raise V2MinterError("WIF_EXCHANGE_REJECTED")
    try:
        payload = response.json() if hasattr(response, "json") else json.loads(response.text() if hasattr(response, "text") else "{}")
    except Exception:  # noqa: BLE001
        raise V2MinterError("WIF_EXCHANGE_MALFORMED") from None
    token = payload.get("access_token") if isinstance(payload, dict) else None
    if not _non_empty(token, 4096):
        raise V2MinterError("WIF_ACCESS_TOKEN_UNAVAILABLE")
    tok = str(token).strip()
    # Do not reject a valid Tailscale API access token merely because it is
    # secret-shaped (tskey-api-... / tskey-...). Keep it ephemeral and never log.
    return tok


def mint_one_off_auth_key(*, fetcher: Any, access_token: str, tailnet: str = V2_TAILNET, description: str = "fleet-enroll-v2-r2") -> dict[str, Any]:
    if not _non_empty(access_token, 4096):
        raise V2MinterError("ACCESS_TOKEN_MISSING")
    if fetcher is None or not hasattr(fetcher, "fetch"):
        raise V2MinterError("TS_FETCHER_UNAVAILABLE")
    validate_fixed_mint_semantics(tailnet=tailnet, tags=[V2_TAG], reusable=V2_REUSABLE, ephemeral=V2_EPHEMERAL, expiry_seconds=V2_EXPIRY_SECONDS, preauthorized=V2_PREAUTHORIZED)
    url = build_tailscale_key_url(tailnet=tailnet)
    payload = build_tailscale_key_request(description=description)
    request = _build_request(url=url, method="POST", headers={"authorization": f"Bearer {access_token}", "content-type": "application/json"}, body=json.dumps(payload))
    try:
        response = fetcher.fetch(request)
    except Exception as exc:  # noqa: BLE001
        raise V2MinterError("TS_UPSTREAM_UNREACHABLE", str(type(exc).__name__)) from None
    if response is None or getattr(response, "status", 503) in (401, 403):
        raise V2MinterError("TS_UPSTREAM_FORBIDDEN")
    if not getattr(response, "ok", False):
        raise V2MinterError("TS_UPSTREAM_REJECTED")
    try:
        data = response.json() if hasattr(response, "json") else json.loads(response.text() if hasattr(response, "text") else "{}")
    except Exception:  # noqa: BLE001
        raise V2MinterError("TS_RESPONSE_MALFORMED") from None
    auth_key = data.get("key") if isinstance(data, dict) else None
    key_id = data.get("id") if isinstance(data, dict) else None
    if not _non_empty(auth_key, 200) or not _non_empty(key_id, 200):
        raise V2MinterError("TS_AUTH_KEY_UNAVAILABLE")
    return {"auth_key": str(auth_key).strip(), "key_id": str(key_id).strip(), "tailnet": V2_TAILNET, "tags": [V2_TAG], "reusable": V2_REUSABLE, "ephemeral": V2_EPHEMERAL, "preauthorized": V2_PREAUTHORIZED, "expiry_seconds": V2_EXPIRY_SECONDS}


def build_provisional_manifest(*, seed: str | None = None) -> dict[str, Any]:
    """Build an attempt-local identity for a truly fresh node.

    This is not a Fleet node identity and MUST NOT enter registry/nodes.yaml.
    A deterministic seed is allowed only for workflow retry idempotency.
    """
    if seed is not None:
        if not isinstance(seed, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", seed):
            raise V2MinterError("FRESH_SEED_INVALID")
        value = uuid.uuid5(uuid.NAMESPACE_URL, "ghostfleet/fresh-enrollment/" + seed)
    else:
        value = uuid.uuid4()
    enrollment_id = "enroll-" + str(value)
    return {
        "identity_kind": "provisional",
        "enrollment_id": enrollment_id,
        "node_id": "fleet-bootstrap-" + value.hex[:12],
        "node_uid": None,
        "asset_ref": None,
        "os_family": "debian-family",
        "profile": "managed-linux",
        "tailscale_tags": [V2_TAG],
    }


def build_courier_manifest(*, node_id: str, repo_root: Any | None = None) -> dict[str, Any]:
    """Build the server-prepared courier manifest from Fleet SSOT.

    Resolves ``node_id`` via the deployment-selected Fleet registry input
    (trusted overlay or explicit legacy compatibility) to exact ``node_uid``,
    validates permitted ``managed-linux``/``debian-family`` profile and fixed
    ``tag:fleet-ssh-target``, and returns the manifest that #89's
    ``POST /v1/admin/tickets`` expects. Fail-closed if node not found or
    profile mismatch.
    """
    from pathlib import Path as _Path

    # Resolve repo root (same logic as other Fleet loaders)
    if repo_root is None:
        p = _Path(__file__).resolve().parent
        for _ in range(10):
            if (p / ".git").exists():
                repo_root = p
                break
            p = p.parent
        else:
            repo_root = _Path(__file__).resolve().parent.parent.parent
    else:
        repo_root = _Path(repo_root)
    from ghostfleet_runtime.core.instance_overlay import load_instance_registry, TrustedOverlayError
    try:
        data = load_instance_registry(repo_root)
    except TrustedOverlayError as exc:
        raise V2MinterError(exc.code, "instance source unavailable or invalid") from None
    nodes = data.get("nodes", {}) if isinstance(data, dict) else {}
    if not isinstance(nodes, dict) or node_id not in nodes:
        raise V2MinterError("NODE_ID_NOT_FOUND", f"{node_id} not in registry")
    node = nodes[node_id]
    if not isinstance(node, dict):
        raise V2MinterError("NODE_ID_NOT_FOUND", f"{node_id} not in registry")
    node_uid = node.get("node_uid")
    if not isinstance(node_uid, str) or not re.fullmatch(r"node-[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", node_uid):
        raise V2MinterError("NODE_UID_MISSING", f"{node_id} missing or invalid node_uid {node_uid!r} (must be node-<uuidv4> lowercase)")
    profile = node.get("management_profile")
    # Only managed-linux on debian-family is permitted for V2 R2 enrollment.
    # Other profiles (workstation, android-edge, etc.) are fail-closed.
    if profile != "managed-linux":
        raise V2MinterError("PROFILE_MISMATCH", f"{node_id} profile {profile!r} != managed-linux")
    # Fail closed on Debian-family evidence. management_profile alone is not
    # proof of OS family. Explicit os evidence, when present, must itself be
    # Debian/Ubuntu-compatible; if both os and os_family exist they must agree.
    # Missing/unknown/conflicting evidence must fail before authority use.
    os_val = node.get("os")
    os_family = node.get("os_family")
    is_debian_os = isinstance(os_val, str) and os_val.lower().startswith(("debian", "ubuntu"))
    is_debian_family = os_family == "debian-family"
    # Explicit os, when present, must be debian/ubuntu
    if isinstance(os_val, str) and not is_debian_os:
        raise V2MinterError("OS_FAMILY_MISMATCH", f"{node_id} os {os_val!r} is not debian-family")
    # Explicit os_family, when present, must be debian-family
    if os_family is not None and not is_debian_family:
        raise V2MinterError("OS_FAMILY_MISMATCH", f"{node_id} os_family {os_family!r} is not debian-family")
    # At least one must prove debian-family
    if not is_debian_os and not is_debian_family:
        raise V2MinterError("OS_FAMILY_MISMATCH", f"{node_id} os {os_val!r} is not debian-family")
    return {
        "node_id": node_id,
        "node_uid": node_uid,
        "os_family": "debian-family",
        "profile": "managed-linux",
        "tailscale_tags": [V2_TAG],
    }


def _deposit_to_courier_ack(*, fetcher: Any, courier: CourierConfig, auth_key: str, manifest: dict[str, Any], ttl_seconds: int = 600) -> dict[str, Any]:
    if fetcher is None or not hasattr(fetcher, "fetch"):
        raise V2MinterError("COURIER_FETCHER_UNAVAILABLE")
    if courier is None:
        raise V2MinterError("COURIER_NOT_CONFIGURED")
    if not _non_empty(auth_key, 200):
        raise V2MinterError("AUTH_KEY_MISSING")
    if not _SECRET_TOKEN_RE.search(auth_key) and not auth_key.startswith("tskey-auth-"):
        raise V2MinterError("AUTH_KEY_INVALID_SHAPE")
    # #89's actual admin ingress: POST /v1/admin/tickets with
    # {manifest, auth_key, ttl_seconds}. Production has no auth-key-only fallback.
    if not isinstance(manifest, dict) or not manifest.get("node_id"):
        raise V2MinterError("MANIFEST_INVALID", "manifest must contain node_id")
    if manifest.get("identity_kind") == "provisional":
        if manifest.get("node_uid") is not None or _PROVISIONAL_ENROLLMENT_RE.fullmatch(str(manifest.get("enrollment_id") or "")) is None:
            raise V2MinterError("MANIFEST_INVALID", "provisional manifest requires enrollment_id and no node_uid")
    elif not manifest.get("node_uid"):
        raise V2MinterError("MANIFEST_INVALID", "canonical manifest must contain node_uid")
    if not isinstance(ttl_seconds, int) or ttl_seconds < 30 or ttl_seconds > 600:
        raise V2MinterError("TTL_INVALID", "ttl_seconds must be 30..600")
    body = json.dumps({"manifest": manifest, "auth_key": auth_key, "ttl_seconds": ttl_seconds})
    request = _build_request(url=courier.url, method="POST", headers={"authorization": f"Bearer {courier.token}", "content-type": "application/json"}, body=body)
    try:
        response = fetcher.fetch(request)
    except Exception as exc:  # noqa: BLE001
        raise V2MinterError("COURIER_UNREACHABLE", str(type(exc).__name__)) from None
    if response is None or getattr(response, "status", 503) in (401, 403):
        raise V2MinterError("COURIER_FORBIDDEN")
    if not getattr(response, "ok", False):
        raise V2MinterError("COURIER_REJECTED")
    try:
        if hasattr(response, "json"):
            data = response.json()
        elif hasattr(response, "text"):
            data = json.loads(response.text())
        else:
            raise ValueError("response has no JSON surface")
    except Exception:  # noqa: BLE001
        raise V2MinterError("COURIER_ACK_INVALID", "courier returned non-JSON success response") from None
    if not isinstance(data, dict):
        raise V2MinterError("COURIER_ACK_INVALID", "courier ACK must be an object")
    raw = json.dumps(data, ensure_ascii=False)
    if _SECRET_TOKEN_RE.search(raw) or _OIDC_RE.search(raw):
        raise V2MinterError("COURIER_ECHOED_SECRET")
    if data.get("ok") is not True:
        raise V2MinterError("COURIER_REJECTED", "courier business ACK did not confirm success")
    ticket = data.get("ticket")
    if not isinstance(ticket, str) or _COURIER_TICKET_RE.fullmatch(ticket) is None:
        raise V2MinterError("COURIER_ACK_INVALID", "courier ACK ticket has invalid shape")
    expires_at = data.get("expires_at")
    if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)):
        raise V2MinterError("COURIER_ACK_INVALID", "courier ACK expires_at must be epoch milliseconds")
    now_ms = int(time.time() * 1000)
    # The courier issues immediately using the requested bounded TTL. Allow a small
    # clock/transport margin, but reject stale or implausibly long-lived ACKs.
    if expires_at <= now_ms or expires_at > now_ms + (ttl_seconds + 60) * 1000:
        raise V2MinterError("COURIER_ACK_INVALID", "courier ACK expiry is not a bounded future value")
    returned_manifest = data.get("manifest")
    if not isinstance(returned_manifest, dict):
        raise V2MinterError("COURIER_ACK_INVALID", "courier ACK manifest is missing")
    if returned_manifest.get("node_id") != manifest.get("node_id") or returned_manifest.get("node_uid") != manifest.get("node_uid"):
        raise V2MinterError("COURIER_ACK_IDENTITY_MISMATCH", "courier ACK manifest does not match requested node identity")
    # Internal-only ACK. The ticket must either be handed to the private sink in
    # the same process or immediately discarded by the public wrapper below.
    return {"courier_ok": True, "ticket": ticket, "expires_at": int(expires_at), "manifest": returned_manifest}


def deposit_to_courier(*, fetcher: Any, courier: CourierConfig, auth_key: str, manifest: dict[str, Any], ttl_seconds: int = 600) -> dict[str, Any]:
    _deposit_to_courier_ack(fetcher=fetcher, courier=courier, auth_key=auth_key, manifest=manifest, ttl_seconds=ttl_seconds)
    return {"courier_ok": True}


def sanitize_receipt(*, key_id: str, tags: list[str], expiry_seconds: int, courier_ok: bool, wif_client_id: str) -> dict[str, Any]:
    return {"ok": True, "mint": {"key_id": key_id, "tags": list(tags), "tailnet": V2_TAILNET, "reusable": V2_REUSABLE, "ephemeral": V2_EPHEMERAL, "preauthorized": V2_PREAUTHORIZED, "expiry_seconds": expiry_seconds}, "courier": {"deposited": bool(courier_ok)}, "authority": {"kind": "GITHUB_OIDC_TAILSCALE_WIF", "scope": "auth_keys", "wif_client_id_present": bool(wif_client_id), "wif_audience_present": True}, "sanitized": True}


def is_sanitized_receipt(obj: Any) -> bool:
    def has_forbidden_key(value: Any) -> bool:
        if isinstance(value, Mapping):
            if any(isinstance(key, str) and key.lower() in _FORBIDDEN_RECEIPT_KEYS for key in value):
                return True
            return any(has_forbidden_key(child) for child in value.values())
        if isinstance(value, (list, tuple)):
            return any(has_forbidden_key(child) for child in value)
        return False

    try:
        text = json.dumps(obj, ensure_ascii=False)
    except Exception:
        return False
    if has_forbidden_key(obj) or _RECEIPT_SECRET_RE.search(text):
        return False
    if _SECRET_TOKEN_RE.search(text):
        return False
    if _OIDC_RE.search(text):
        return False
    return True


class _SimpleRequest:
    def __init__(self, url: str, method: str, headers: dict[str, str], body: str | None) -> None:
        self.url = url
        self.method = method
        self.headers = {k.lower(): v for k, v in headers.items()}
        self.body = body

    def json(self) -> Any:  # pragma: no cover — for compatibility
        return json.loads(self.body) if self.body else {}


def _build_request(*, url: str, method: str, headers: dict[str, str], body: str | None) -> Any:
    try:
        import builtins

        RequestCls = getattr(builtins, "Request", None)
        if RequestCls is not None:
            return RequestCls(url, method=method, headers=headers, body=body)
    except Exception:
        pass
    return _SimpleRequest(url=url, method=method, headers={k.lower(): v for k, v in headers.items()}, body=body)




def sanitize_wif_proof_receipt(*, env: Mapping[str, Any], wif_client_id: str) -> dict[str, Any]:
    repository = str(env.get("GITHUB_REPOSITORY") or "").strip()
    ref = str(env.get("GITHUB_REF") or "").strip()
    sha = str(env.get("GITHUB_SHA") or "").strip()
    run_id = str(env.get("GITHUB_RUN_ID") or "").strip()
    run_attempt = str(env.get("GITHUB_RUN_ATTEMPT") or "1").strip()
    workflow_ref = str(env.get("GITHUB_WORKFLOW_REF") or "").strip()
    if repository != ALLOWED_OIDC_REPOSITORY:
        raise V2MinterError("WIF_PROOF_REPOSITORY_INVALID")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise V2MinterError("WIF_PROOF_SHA_INVALID")
    if not run_id.isdigit() or not run_attempt.isdigit():
        raise V2MinterError("WIF_PROOF_RUN_INVALID")
    if not ref.startswith("refs/") or not _non_empty(workflow_ref, 500):
        raise V2MinterError("WIF_PROOF_CONTEXT_INVALID")
    client_digest = _sha256_text(wif_client_id)
    evidence_material = json.dumps(
        {
            "repository": repository,
            "ref": ref,
            "sha": sha,
            "run_id": run_id,
            "run_attempt": run_attempt,
            "workflow_ref": workflow_ref,
            "wif_client_id_sha256": client_digest,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    evidence_ref = "evidence:wif-" + _sha256_text(evidence_material)[:32]
    receipt = {
        "schema": "fleet-wif-runtime-proof/v1",
        "ok": True,
        "proof": "WIF_EXCHANGE_SUCCEEDED",
        "evidence_ref": evidence_ref,
        "source": {
            "repository": repository,
            "ref": ref,
            "sha": sha,
            "run_id": run_id,
            "run_attempt": run_attempt,
            "workflow_ref": workflow_ref,
        },
        "authority_contract": {
            "kind": "GITHUB_OIDC_TAILSCALE_WIF",
            "expected_scope": "auth_keys",
            "expected_tag": V2_TAG,
            "tailnet": V2_TAILNET,
            "wif_client_id_sha256": client_digest,
        },
        "observed_at_epoch_ms": int(time.time() * 1000),
        "sanitized": True,
    }
    if not is_sanitized_receipt(receipt):
        raise V2MinterError("WIF_PROOF_RECEIPT_UNSAFE")
    return receipt


def prove_wif_exchange(*, env: Mapping[str, Any], oidc_token: str, fetcher_wif: Any) -> dict[str, Any]:
    forbidden_present = sorted(key for key in FORBIDDEN_ENV_KEYS if _non_empty(env.get(key), 4096))
    if forbidden_present:
        raise V2MinterError("FORBIDDEN_SECRET_SURFACE", ",".join(forbidden_present))
    wif = validate_wif_config(env)
    # Successful return proves the configured GitHub OIDC trust accepted this run.
    # Keep the returned access token only in this stack frame; do not persist,
    # introspect, mint, call another Tailscale endpoint, or return it.
    access_token = exchange_oidc_for_access_token(
        fetcher=fetcher_wif,
        client_id=wif["client_id"],
        audience=wif["audience"],
        oidc_token=oidc_token,
    )
    if not _non_empty(access_token, 4096):
        raise V2MinterError("WIF_ACCESS_TOKEN_UNAVAILABLE")
    return sanitize_wif_proof_receipt(env=env, wif_client_id=wif["client_id"])


def run_wif_mint_and_deposit(
    *,
    env: Mapping[str, Any],
    oidc_token: str,
    fetcher_wif: Any,
    fetcher_tailscale: Any,
    fetcher_courier: Any,
    fetcher_handoff: Any | None = None,
    courier_oidc_token: str | None = None,
    description: str = "fleet-enroll-v2-r2",
    node_id: str | None = None,
    fresh: bool = False,
    fresh_seed: str | None = None,
    repo_root: Any | None = None,
) -> dict[str, Any]:
    # Existing nodes resolve through Fleet SSOT. Truly fresh nodes use an
    # attempt-local provisional identity and are materialized only after the
    # bootstrap returns protected hardware evidence.
    if fresh:
        if node_id not in (None, ""):
            raise V2MinterError("FRESH_NODE_ID_OVERRIDE_FORBIDDEN")
        manifest = build_provisional_manifest(seed=fresh_seed)
    else:
        if not isinstance(node_id, str) or not node_id.strip():
            raise V2MinterError("NODE_ID_REQUIRED", "node_id is required")
        manifest = build_courier_manifest(node_id=node_id.strip(), repo_root=repo_root)
    if manifest.get("tailscale_tags") != [V2_TAG]:
        raise V2MinterError("MANIFEST_TAG_MISMATCH", "resolved manifest tags must be exactly [tag:fleet-ssh-target]")
    wif = validate_wif_config(env)
    courier = resolve_courier_config(env, oidc_token=courier_oidc_token)
    if courier is None:
        raise V2MinterError("COURIER_NOT_CONFIGURED", "courier admin ingress not yet available — refusing to mint (fail-closed stub)")
    handoff = resolve_private_handoff_config(env)
    if handoff is not None and fetcher_handoff is None:
        fetcher_handoff = fetcher_courier
    validate_fixed_mint_semantics(tags=[V2_TAG], tailnet=V2_TAILNET, reusable=V2_REUSABLE, ephemeral=V2_EPHEMERAL, expiry_seconds=V2_EXPIRY_SECONDS, preauthorized=V2_PREAUTHORIZED)
    if handoff is not None:
        preflight_private_handoff(fetcher=fetcher_handoff, handoff=handoff)
    access_token = exchange_oidc_for_access_token(fetcher=fetcher_wif, client_id=wif["client_id"], audience=wif["audience"], oidc_token=oidc_token)
    issued = mint_one_off_auth_key(fetcher=fetcher_tailscale, access_token=access_token, tailnet=V2_TAILNET, description=description)
    deposit = _deposit_to_courier_ack(fetcher=fetcher_courier, courier=courier, auth_key=issued["auth_key"], manifest=manifest, ttl_seconds=600)
    if handoff is not None:
        try:
            handoff_private_ticket(
                fetcher=fetcher_handoff,
                handoff=handoff,
                ticket=deposit["ticket"],
                expires_at=deposit["expires_at"],
                manifest=manifest,
            )
        except V2MinterError as handoff_error:
            compensation_errors: list[str] = []
            cleanup = {"courier": "REVOKED", "provider_key": "REVOKED"}
            try:
                revoke_courier_ticket(fetcher=fetcher_courier, courier=courier, ticket=deposit["ticket"])
            except V2MinterError as revoke_error:
                compensation_errors.append(revoke_error.code)
                cleanup["courier"] = "UNKNOWN"
            try:
                revoke_tailscale_key(fetcher=fetcher_tailscale, access_token=access_token, key_id=issued["key_id"])
            except V2MinterError as revoke_error:
                compensation_errors.append(revoke_error.code)
                cleanup["provider_key"] = "UNKNOWN"
            code = "PRIVATE_HANDOFF_RECONCILIATION_REQUIRED" if compensation_errors else "PRIVATE_HANDOFF_FAILED_COMPENSATED"
            failure_receipt = sanitize_receipt(key_id=issued["key_id"], tags=issued["tags"], expiry_seconds=issued["expiry_seconds"], courier_ok=True, wif_client_id=wif["client_id"])
            failure_receipt.update({
                "schema": "fleet-enrollment-mint-failure/v1", "ok": False,
                "error": code, "handoff_error": handoff_error.code,
                "cleanup": cleanup, "reconcile_required": bool(compensation_errors),
                "reconciliation": {"ticket_hash": _sha256_text(deposit["ticket"]), "expires_at": deposit["expires_at"]},
            })
            if not is_sanitized_receipt(failure_receipt):
                raise V2MinterError("FAILURE_RECEIPT_UNSAFE") from None
            if compensation_errors:
                raise V2MinterError(
                    code,
                    f"handoff={handoff_error.code}; compensation={','.join(compensation_errors)}",
                    receipt=failure_receipt,
                ) from None
            raise V2MinterError(code, handoff_error.code, receipt=failure_receipt) from None
    receipt = sanitize_receipt(key_id=issued["key_id"], tags=issued["tags"], expiry_seconds=issued["expiry_seconds"], courier_ok=bool(deposit.get("courier_ok")), wif_client_id=wif["client_id"])
    assert is_sanitized_receipt(receipt), "sanitized receipt must not carry secret"
    assert '"auth_key"' not in json.dumps(receipt), "receipt must never contain auth_key field"
    assert '"ticket"' not in json.dumps(receipt), "receipt must never contain ticket"
    return receipt
