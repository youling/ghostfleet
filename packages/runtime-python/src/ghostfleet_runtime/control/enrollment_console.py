"""Reusable Control Panel enrollment runtime for Fleet the versioned enrollment contract.

This module owns only the Human-facing ticket envelope. Canonical enrollment
truth stays in the existing Enrollment Attempt runtime; provider effects are
performed by injected adapters using SecretReference values.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import stat
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol
from urllib.parse import quote, urlsplit

import yaml

CONSOLE_PROTOCOL = "fleet-enrollment-console/v1"
ATTEMPT_PROTOCOL = "fleet-enrollment-attempt/v1"
TICKET_PROTOCOL = "fleet-enrollment-ticket/v1"
PROVIDER_PROTOCOL = "fleet-control-panel-provider-adapter/v1"
SCHEMA_VERSION = "1.0.0"
PROVIDERS = ("github", "tailscale", "cloudflare")
SUPPORTED_V0_TEMPLATES = frozenset({"managed-linux-standard"})
UNKNOWN_ATTEMPT_STATES = frozenset({"MINT_UNKNOWN", "JOIN_UNKNOWN", "INVALIDATION_PENDING"})
FORBIDDEN_CUSTOMER_CAPABILITIES = frozenset({"PRIVILEGED_TYPED_OPS", "ROOTLESS_JOBS", "AGENT_RUNTIME"})

NODE_RE = re.compile(r"node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
ATTEMPT_RE = re.compile(r"attempt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
WORK_RE = re.compile(r"[A-Za-z0-9._:/#-]{1,200}")
CAP_RE = re.compile(r"[A-Za-z0-9_-]{32,128}")
DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}")
REF_RE = re.compile(r"secretref://(github|tailscale|cloudflare)/[A-Za-z0-9._~:/-]{1,220}")
EVIDENCE_RE = re.compile(r"evidence:[A-Za-z0-9._-]{1,128}")
SECRET_KEY_RE = re.compile(r"(?:^|_)(?:secret|token|password|credential|auth_key|api_key|private_key)(?:$|_)", re.I)


class ConsoleError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def digest(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def utc(value: dt.datetime | None = None) -> dt.datetime:
    value = value or dt.datetime.now(dt.timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc).replace(microsecond=0)


def iso(value: dt.datetime) -> str:
    return utc(value).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str) -> dt.datetime:
    try:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except (TypeError, ValueError):
        raise ConsoleError("ATTEMPT_EXPIRY_INVALID") from None


def https_root(value: str) -> str:
    if not isinstance(value, str) or len(value) > 1800 or any(ord(c) < 33 for c in value):
        raise ConsoleError("HTTPS_ROOT_INVALID")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ConsoleError("HTTPS_ROOT_INVALID")
    return value.rstrip("/")


def assert_secret_free(value: Any) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or SECRET_KEY_RE.search(key):
                raise ConsoleError("BOOTSTRAP_SECRET_FIELD_FORBIDDEN")
            assert_secret_free(item)
    elif isinstance(value, list):
        for item in value:
            assert_secret_free(item)
    elif isinstance(value, str) and re.search(r"(?:tskey-auth-|gh[pousr]_|-----BEGIN [A-Z ]*PRIVATE KEY-----)", value):
        raise ConsoleError("BOOTSTRAP_SECRET_VALUE_FORBIDDEN")


@dataclass(frozen=True)
class SecretReference:
    provider: str
    ref: str
    profile_ref: str

    @classmethod
    def parse(cls, provider: str, value: Any, profile_ref: str) -> "SecretReference":
        if provider not in PROVIDERS or not isinstance(value, str) or REF_RE.fullmatch(value) is None:
            raise ConsoleError("SECRET_REFERENCE_REQUIRED")
        if not value.startswith(f"secretref://{provider}/"):
            raise ConsoleError("SECRET_REFERENCE_PROVIDER_MISMATCH")
        if not isinstance(profile_ref, str) or not 1 <= len(profile_ref) <= 128:
            raise ConsoleError("PROVIDER_PROFILE_INVALID")
        return cls(provider, value, profile_ref)

    def public(self) -> dict[str, str]:
        return {"provider": self.provider, "profile_ref": self.profile_ref, "ref_digest": digest(self.ref)}


@dataclass(frozen=True)
class AttemptPreparation:
    attempt_id: str
    node_uid: str
    manifest_digest: str
    expires_at: str
    courier_url: str
    state: str
    duplicate: bool = False


@dataclass(frozen=True)
class ProviderBindingResult:
    provider: str
    state: str
    reference_digest: str
    evidence_ref: str | None = None
    protocol: str = PROVIDER_PROTOCOL

    def __post_init__(self) -> None:
        if self.protocol != PROVIDER_PROTOCOL or self.provider not in PROVIDERS or self.state not in {"READY", "UNKNOWN", "UNSUPPORTED"}:
            raise ConsoleError("PROVIDER_RESULT_INVALID")
        if DIGEST_RE.fullmatch(self.reference_digest) is None:
            raise ConsoleError("PROVIDER_RESULT_INVALID")
        if self.evidence_ref is not None and EVIDENCE_RE.fullmatch(self.evidence_ref) is None:
            raise ConsoleError("PROVIDER_RESULT_INVALID")


class AttemptGateway(Protocol):
    def prepare(self, *, work_key: str, manifest: Mapping[str, Any], claim_code: str,
                client_binding: str, ttl_seconds: int) -> AttemptPreparation: ...
    def status(self, *, attempt: AttemptPreparation, manifest: Mapping[str, Any],
               client_binding: str) -> AttemptPreparation: ...


class ProviderAdapter(Protocol):
    def bind_or_reconcile(self, *, reference: SecretReference, template: Mapping[str, Any],
                          attempt: AttemptPreparation) -> ProviderBindingResult: ...


class BootstrapGenerator(Protocol):
    def build(self, *, template: Mapping[str, Any], template_digest: str,
              manifest: Mapping[str, Any], attempt: AttemptPreparation,
              provider_results: Mapping[str, ProviderBindingResult]) -> Mapping[str, Any]: ...


class TemplateCatalog:
    def __init__(self, templates: Mapping[str, Mapping[str, Any]]):
        self.templates = {k: json.loads(json.dumps(v)) for k, v in templates.items()}

    @classmethod
    def from_directory(cls, directory: str | os.PathLike[str]) -> "TemplateCatalog":
        values: dict[str, Mapping[str, Any]] = {}
        for path in sorted(Path(directory).glob("*.yaml")):
            item = yaml.safe_load(path.read_text(encoding="utf-8"))
            if not isinstance(item, dict):
                raise ConsoleError("TEMPLATE_INVALID")
            values[item.get("template_id", path.stem)] = item
        return cls(values)

    def get(self, template_id: str) -> tuple[dict[str, Any], str]:
        item = self.templates.get(template_id)
        if item is None:
            raise ConsoleError("TEMPLATE_NOT_FOUND")
        self._validate(item)
        if item.get("template_id") != template_id:
            raise ConsoleError("TEMPLATE_IDENTITY_MISMATCH")
        item = json.loads(json.dumps(item))
        return item, digest(item)

    @staticmethod
    def _validate(item: Mapping[str, Any]) -> None:
        if item.get("schema_version") != SCHEMA_VERSION or item.get("public_safe") is not True:
            raise ConsoleError("TEMPLATE_INVALID")
        if item.get("lifecycle_ceiling") != "ENROLLED" or item.get("bootstrap", {}).get("command") != "fleet-enroll":
            raise ConsoleError("TEMPLATE_AUTHORITY_INVALID")
        if item.get("trust_profile") == "CUSTOMER_LIMITED" and FORBIDDEN_CUSTOMER_CAPABILITIES.intersection(item.get("requested_capabilities", [])):
            raise ConsoleError("CUSTOMER_CAPABILITY_ESCALATION")
        bindings = item.get("provider_bindings")
        if not isinstance(bindings, dict) or set(bindings) != set(PROVIDERS):
            raise ConsoleError("TEMPLATE_PROVIDER_BINDINGS_INVALID")
        ttl = item.get("bootstrap", {}).get("ticket_ttl_seconds")
        digits = item.get("bootstrap", {}).get("short_code_digits")
        if not isinstance(ttl, int) or not 300 <= ttl <= 600 or not isinstance(digits, int) or not 4 <= digits <= 12:
            raise ConsoleError("TEMPLATE_RUNTIME_WINDOW_UNSUPPORTED")


class SQLiteTicketStore:
    """Protected UX envelope only; Enrollment Attempt remains canonical state."""
    COLUMNS = """work_key,request_digest,phase,revision,ticket_id,bearer,bearer_hash,short_code,
      short_code_mac,claim_code,client_binding,node_uid,manifest_json,manifest_digest,template_id,
      template_digest,bindings_json,attempt_id,courier_url,expires_at,issued_at,consumed_at,
      resume_hash,bootstrap_json,last_outcome"""

    def __init__(self, path: str, *, hmac_key: bytes):
        if not isinstance(hmac_key, (bytes, bytearray)) or len(hmac_key) < 32:
            raise ConsoleError("TICKET_HMAC_KEY_REQUIRED")
        self.key = bytes(hmac_key)
        self.lock = threading.RLock()
        if path != ":memory:":
            self._secure_path(Path(path))
        old = os.umask(0o077)
        try:
            self.db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        finally:
            os.umask(old)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
        PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS console_tickets(
          work_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, phase TEXT NOT NULL,
          revision INTEGER NOT NULL, ticket_id TEXT UNIQUE NOT NULL, bearer TEXT,
          bearer_hash TEXT UNIQUE NOT NULL, short_code TEXT, short_code_mac TEXT NOT NULL,
          claim_code TEXT, client_binding TEXT NOT NULL, node_uid TEXT NOT NULL,
          manifest_json TEXT NOT NULL, manifest_digest TEXT NOT NULL, template_id TEXT NOT NULL,
          template_digest TEXT NOT NULL, bindings_json TEXT NOT NULL, attempt_id TEXT,
          courier_url TEXT, expires_at TEXT, issued_at TEXT, consumed_at TEXT, resume_hash TEXT,
          bootstrap_json TEXT, last_outcome TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS console_ticket_bearer ON console_tickets(bearer_hash);
        """)

    @staticmethod
    def _secure_path(path: Path) -> None:
        try:
            parent = path.parent.lstat()
        except OSError:
            raise ConsoleError("TICKET_STORE_DIRECTORY_REQUIRED") from None
        if stat.S_ISLNK(parent.st_mode) or not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or stat.S_IMODE(parent.st_mode) & 0o077:
            raise ConsoleError("TICKET_STORE_DIRECTORY_UNTRUSTED")
        if path.exists() or path.is_symlink():
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise ConsoleError("TICKET_STORE_UNTRUSTED")
        else:
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
                os.close(fd)
            except OSError:
                raise ConsoleError("TICKET_STORE_CREATE_FAILED") from None

    def _mac(self, ticket_id: str, code: str) -> str:
        return hmac.new(self.key, f"{ticket_id}:{code}".encode(), hashlib.sha256).hexdigest()

    def _row(self, work_key: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM console_tickets WHERE work_key=?", (work_key,)).fetchone()

    def by_work(self, work_key: str) -> sqlite3.Row | None:
        with self.lock:
            return self._row(work_key)

    def begin(self, *, work_key: str, request_digest: str, ticket_id: str, bearer: str,
              short_code: str, claim_code: str, client_binding: str, node_uid: str,
              manifest: Mapping[str, Any], template_id: str, template_digest: str,
              bindings: Mapping[str, SecretReference]) -> sqlite3.Row:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                prior = self._row(work_key)
                if prior:
                    if prior["request_digest"] != request_digest:
                        raise ConsoleError("ENROLLMENT_REQUEST_CONFLICT")
                    self.db.execute("COMMIT")
                    return prior
                values = (work_key, request_digest, "PREPARING", 0, ticket_id, bearer, digest(bearer), short_code,
                          self._mac(ticket_id, short_code), claim_code, client_binding, node_uid,
                          json.dumps(manifest, sort_keys=True, separators=(",", ":")), digest(manifest),
                          template_id, template_digest,
                          json.dumps({k: v.ref for k, v in sorted(bindings.items())}, sort_keys=True),
                          None, None, None, None, None, None, None, "PREPARING")
                self.db.execute(f"INSERT INTO console_tickets({self.COLUMNS}) VALUES({','.join('?' for _ in values)})", values)
                self.db.execute("COMMIT")
                return self._row(work_key)
            except Exception:
                if self.db.in_transaction:
                    self.db.execute("ROLLBACK")
                raise

    def bind_attempt(self, work_key: str, attempt: AttemptPreparation) -> sqlite3.Row:
        if ATTEMPT_RE.fullmatch(attempt.attempt_id or "") is None or NODE_RE.fullmatch(attempt.node_uid or "") is None \
                or DIGEST_RE.fullmatch(attempt.manifest_digest or "") is None:
            raise ConsoleError("ATTEMPT_BINDING_CONFLICT")
        https_root(attempt.courier_url)
        parse_iso(attempt.expires_at)
        with self.lock:
            row = self._row(work_key)
            if not row or (row["attempt_id"] and row["attempt_id"] != attempt.attempt_id):
                raise ConsoleError("ATTEMPT_BINDING_CONFLICT")
            if row["node_uid"] != attempt.node_uid or row["manifest_digest"] != attempt.manifest_digest:
                raise ConsoleError("ATTEMPT_BINDING_CONFLICT")
            if row["courier_url"] and row["courier_url"] != attempt.courier_url:
                raise ConsoleError("ATTEMPT_BINDING_CONFLICT")
            self.db.execute("UPDATE console_tickets SET attempt_id=?,courier_url=?,expires_at=?,last_outcome='ATTEMPT_BOUND' WHERE work_key=?",
                            (attempt.attempt_id, attempt.courier_url, attempt.expires_at, work_key))
            return self._row(work_key)

    def mark_unknown(self, work_key: str) -> None:
        with self.lock:
            self.db.execute("UPDATE console_tickets SET last_outcome='UNKNOWN' WHERE work_key=?", (work_key,))

    def issue(self, work_key: str, *, bootstrap: Mapping[str, Any], issued_at: str) -> sqlite3.Row:
        with self.lock:
            row = self._row(work_key)
            if not row or not row["attempt_id"] or not row["expires_at"]:
                raise ConsoleError("ATTEMPT_NOT_BOUND")
            if row["phase"] == "CONSUMED":
                raise ConsoleError("TICKET_REPLAY_DENIED")
            payload = json.dumps(bootstrap, sort_keys=True, separators=(",", ":"))
            if row["phase"] == "ISSUED":
                if row["bootstrap_json"] != payload:
                    raise ConsoleError("BOOTSTRAP_GENERATION_CONFLICT")
                return row
            if row["phase"] != "PREPARING":
                raise ConsoleError("TICKET_NOT_READY")
            self.db.execute("UPDATE console_tickets SET phase='ISSUED',revision=revision+1,issued_at=?,bootstrap_json=?,last_outcome='ISSUED' WHERE work_key=?",
                            (issued_at, payload, work_key))
            return self._row(work_key)

    def claim(self, *, bearer: str, short_code: str, resume_capability: str, now: dt.datetime) -> dict[str, Any]:
        if CAP_RE.fullmatch(resume_capability or "") is None:
            raise ConsoleError("TICKET_RESUME_INVALID")
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                row = self.db.execute("SELECT * FROM console_tickets WHERE bearer_hash=?", (digest(bearer),)).fetchone()
                if not row:
                    raise ConsoleError("TICKET_NOT_FOUND")
                if not hmac.compare_digest(row["short_code_mac"], self._mac(row["ticket_id"], short_code)):
                    raise ConsoleError("TICKET_CODE_INVALID")
                if not row["expires_at"] or utc(now) >= parse_iso(row["expires_at"]):
                    self.db.execute("UPDATE console_tickets SET phase='EXPIRED',revision=revision+1,bearer=NULL,short_code=NULL,claim_code=NULL,bootstrap_json=NULL,last_outcome='EXPIRED' WHERE work_key=?", (row["work_key"],))
                    self.db.execute("COMMIT")
                    raise ConsoleError("TICKET_EXPIRED")
                rh = digest(resume_capability)
                replayed = row["phase"] == "CONSUMED"
                if row["phase"] == "ISSUED":
                    self.db.execute("UPDATE console_tickets SET phase='CONSUMED',revision=revision+1,consumed_at=?,resume_hash=?,bearer=NULL,short_code=NULL,last_outcome='CONSUMED' WHERE work_key=?",
                                    (iso(now), rh, row["work_key"]))
                    row = self._row(row["work_key"])
                elif row["phase"] != "CONSUMED" or row["resume_hash"] != rh:
                    raise ConsoleError("TICKET_REPLAY_DENIED" if row["phase"] == "CONSUMED" else "TICKET_NOT_READY")
                if not row["claim_code"] or not row["bootstrap_json"] or not row["attempt_id"]:
                    raise ConsoleError("TICKET_MATERIAL_UNAVAILABLE")
                result = {
                    "protocol": CONSOLE_PROTOCOL, "ticket_id": row["ticket_id"], "template_id": row["template_id"],
                    "template_digest": row["template_digest"], "replayed": replayed,
                    "attempt_handoff": {"protocol": ATTEMPT_PROTOCOL, "node_uid": row["node_uid"], "attempt_id": row["attempt_id"],
                        "manifest_digest": row["manifest_digest"], "client_binding": row["client_binding"],
                        "claim_code": row["claim_code"], "courier_url": row["courier_url"], "expires_at": row["expires_at"]},
                    "bootstrap_generation": json.loads(row["bootstrap_json"]),
                }
                self.db.execute("COMMIT")
                return result
            except Exception:
                if self.db.in_transaction:
                    self.db.execute("ROLLBACK")
                raise

    def public_metadata(self, work_key: str) -> dict[str, Any]:
        with self.lock:
            row = self._row(work_key)
            if not row or row["phase"] == "PREPARING":
                raise ConsoleError("TICKET_NOT_ISSUED")
            state = {"ISSUED": "PREPARED", "CONSUMED": "CONSUMED", "EXPIRED": "EXPIRED"}.get(row["phase"])
            if state is None:
                raise ConsoleError("TICKET_STATE_INVALID")
            return {"schema_version": SCHEMA_VERSION, "protocol": TICKET_PROTOCOL, "ticket_id": row["ticket_id"],
                    "attempt_id": row["attempt_id"], "template_id": row["template_id"], "template_digest": row["template_digest"],
                    "node_uid": row["node_uid"], "revision": row["revision"], "state": state, "issued_at": row["issued_at"],
                    "expires_at": row["expires_at"], "claim_material_state": ("CONSUMED" if state == "CONSUMED" else "DESTROYED" if state == "EXPIRED" else "PRESENT_IN_PROTECTED_RUNTIME"),
                    "secret_value_included": False}

    def close(self) -> None:
        with self.lock:
            self.db.close()


class EnrollmentConsole:
    def __init__(self, *, catalog: TemplateCatalog, store: SQLiteTicketStore, attempt_gateway: AttemptGateway,
                 provider_adapters: Mapping[str, ProviderAdapter], bootstrap_generator: BootstrapGenerator,
                 public_base_url: str, manifest_validator: Callable[[Mapping[str, Any]], Mapping[str, Any]],
                 bootstrap_config_validator: Callable[[Mapping[str, Any]], Mapping[str, Any]],
                 now: Callable[[], dt.datetime] | None = None):
        self.catalog, self.store, self.attempt_gateway = catalog, store, attempt_gateway
        self.adapters, self.bootstrap_generator = dict(provider_adapters), bootstrap_generator
        self.public_base_url = https_root(public_base_url)
        self.manifest_validator, self.config_validator = manifest_validator, bootstrap_config_validator
        self.now = now or (lambda: dt.datetime.now(dt.timezone.utc))

    def _refs(self, template: Mapping[str, Any], raw: Mapping[str, Any]) -> dict[str, SecretReference]:
        if not isinstance(raw, Mapping) or set(raw) - set(PROVIDERS):
            raise ConsoleError("PROVIDER_BINDINGS_INVALID")
        out: dict[str, SecretReference] = {}
        for provider in PROVIDERS:
            policy = template["provider_bindings"][provider]
            if policy["mode"] == "OMITTED" and not policy["required"]:
                continue
            if policy["mode"] != "MANUAL_BINDING_V0":
                raise ConsoleError("PROVIDER_MODE_UNSUPPORTED")
            out[provider] = SecretReference.parse(provider, raw.get(provider), policy.get("profile_ref", "default"))
        return out

    def prepare(self, *, work_key: str, template_id: str, manifest: Mapping[str, Any], provider_bindings: Mapping[str, Any]) -> dict[str, Any]:
        if WORK_RE.fullmatch(work_key or "") is None:
            raise ConsoleError("WORK_KEY_REQUIRED")
        template, td = self.catalog.get(template_id)
        if template_id not in SUPPORTED_V0_TEMPLATES:
            raise ConsoleError("TEMPLATE_RUNTIME_UNSUPPORTED")
        manifest = dict(self.manifest_validator(manifest))
        if NODE_RE.fullmatch(str(manifest.get("node_uid", ""))) is None:
            raise ConsoleError("MANIFEST_INVALID")
        refs = self._refs(template, provider_bindings)
        rd = digest({"work_key": work_key, "template_digest": td, "manifest": manifest,
                     "provider_bindings": {k: v.public() for k, v in sorted(refs.items())}})
        row = self.store.by_work(work_key)
        if row and row["request_digest"] != rd:
            raise ConsoleError("ENROLLMENT_REQUEST_CONFLICT")
        if row and row["phase"] == "CONSUMED":
            raise ConsoleError("TICKET_REPLAY_DENIED")
        if not row:
            ticket_id = "ticket-" + str(uuid.uuid4())
            bearer = secrets.token_urlsafe(32)
            digits = template["bootstrap"]["short_code_digits"]
            code = f"{secrets.randbelow(10 ** digits):0{digits}d}"
            claim_code = secrets.token_urlsafe(32)
            binding = digest({"ticket_id": ticket_id, "template_digest": td, "node_uid": manifest["node_uid"]})
            row = self.store.begin(work_key=work_key, request_digest=rd, ticket_id=ticket_id, bearer=bearer,
                                   short_code=code, claim_code=claim_code, client_binding=binding,
                                   node_uid=manifest["node_uid"], manifest=manifest, template_id=template_id,
                                   template_digest=td, bindings=refs)
        claim_code = row["claim_code"]
        if CAP_RE.fullmatch(claim_code or "") is None:
            raise ConsoleError("TICKET_MATERIAL_UNAVAILABLE")
        attempt = self.attempt_gateway.prepare(work_key=work_key, manifest=manifest, claim_code=claim_code,
                                               client_binding=row["client_binding"], ttl_seconds=template["bootstrap"]["ticket_ttl_seconds"])
        if attempt.node_uid != manifest["node_uid"] or attempt.manifest_digest != digest(manifest):
            raise ConsoleError("ATTEMPT_BINDING_CONFLICT")
        self.store.bind_attempt(work_key, attempt)
        results: dict[str, ProviderBindingResult] = {}
        for provider, reference in refs.items():
            adapter = self.adapters.get(provider)
            if adapter is None:
                raise ConsoleError("PROVIDER_ADAPTER_REQUIRED")
            result = adapter.bind_or_reconcile(reference=reference, template=template, attempt=attempt)
            if result.provider != provider or result.reference_digest != digest(reference.ref):
                raise ConsoleError("PROVIDER_RESULT_BINDING_INVALID")
            if result.state == "UNKNOWN":
                self.store.mark_unknown(work_key)
                raise ConsoleError("PROVIDER_RECONCILIATION_REQUIRED")
            if result.state != "READY":
                raise ConsoleError("PROVIDER_ADAPTER_UNSUPPORTED")
            results[provider] = result
        current = self.attempt_gateway.status(attempt=attempt, manifest=manifest, client_binding=row["client_binding"])
        if current.attempt_id != attempt.attempt_id or current.node_uid != attempt.node_uid or current.manifest_digest != attempt.manifest_digest:
            raise ConsoleError("ATTEMPT_STATUS_BINDING_INVALID")
        if current.state in UNKNOWN_ATTEMPT_STATES:
            self.store.mark_unknown(work_key)
            raise ConsoleError("PROVIDER_RECONCILIATION_REQUIRED")
        if current.state != "CREDENTIAL_READY":
            raise ConsoleError("ATTEMPT_NOT_READY")
        bootstrap = dict(self.bootstrap_generator.build(template=template, template_digest=td, manifest=manifest,
                                                        attempt=current, provider_results=results))
        required = {"schema_version", "template_id", "template_digest", "attempt_id", "node_uid", "converger_config"}
        if set(bootstrap) != required or bootstrap["schema_version"] != SCHEMA_VERSION or bootstrap["template_id"] != template_id \
                or bootstrap["template_digest"] != td or bootstrap["attempt_id"] != current.attempt_id \
                or bootstrap["node_uid"] != manifest["node_uid"] or not isinstance(bootstrap["converger_config"], dict):
            raise ConsoleError("BOOTSTRAP_GENERATION_INVALID")
        assert_secret_free(bootstrap)
        try:
            bootstrap["converger_config"] = dict(self.config_validator(bootstrap["converger_config"]))
        except ConsoleError:
            raise
        except Exception:
            raise ConsoleError("BOOTSTRAP_CONFIG_INVALID") from None
        row = self.store.issue(work_key, bootstrap=bootstrap, issued_at=iso(self.now()))
        if not row["bearer"] or not row["short_code"]:
            raise ConsoleError("TICKET_FACTORS_UNAVAILABLE")
        url = f"{self.public_base_url}/v1/enrollment-tickets/{quote(row['bearer'], safe='')}"
        return {"protocol": CONSOLE_PROTOCOL, "ticket_id": row["ticket_id"], "attempt_id": row["attempt_id"],
                "template_id": row["template_id"], "template_digest": row["template_digest"], "node_uid": row["node_uid"],
                "expires_at": row["expires_at"], "one_time_url": url, "short_code": row["short_code"],
                "command": f"sudo fleet-enroll {url} {row['short_code']}",
                "provider_bindings": {k: v.public() for k, v in sorted(refs.items())}, "secret_value_included": False}

    def claim(self, *, bearer: str, short_code: str, resume_capability: str) -> dict[str, Any]:
        if not isinstance(bearer, str) or CAP_RE.fullmatch(bearer) is None:
            raise ConsoleError("TICKET_INVALID")
        if not isinstance(short_code, str) or re.fullmatch(r"[0-9]{4,12}", short_code) is None:
            raise ConsoleError("TICKET_CODE_INVALID")
        return self.store.claim(bearer=bearer, short_code=short_code, resume_capability=resume_capability, now=self.now())


class CanonicalAttemptHttpGateway:
    """Thin adapter over the existing AttemptClient; it stores no attempt state."""
    def __init__(self, *, courier_url: str, minter_token: str, fetcher: Any):
        self.courier_url = https_root(courier_url)
        if CAP_RE.fullmatch(minter_token or "") is None:
            raise ConsoleError("ATTEMPT_MINTER_AUTH_REQUIRED")
        self.minter_token, self.fetcher = minter_token, fetcher

    def _client(self, manifest: Mapping[str, Any], client_binding: str):
        from .enrollment_attempt import AttemptClient, AttemptConfig
        return AttemptClient(AttemptConfig(self.courier_url, self.minter_token,
            "https://unused.invalid/private-handoff", "unused_" + "x" * 32, client_binding), dict(manifest), self.fetcher)

    def prepare(self, *, work_key: str, manifest: Mapping[str, Any], claim_code: str,
                client_binding: str, ttl_seconds: int) -> AttemptPreparation:
        client = self._client(manifest, client_binding)
        result = client.call("prepare", work_key=work_key, manifest=dict(manifest),
                             mint_request_digest=client.mint_request_digest, client_binding=client_binding,
                             claim_code=claim_code, ttl_seconds=ttl_seconds)
        return self._convert(result)

    def status(self, *, attempt: AttemptPreparation, manifest: Mapping[str, Any], client_binding: str) -> AttemptPreparation:
        client = self._client(manifest, client_binding)
        client.attempt_id = attempt.attempt_id
        return self._convert(client.status())

    def _convert(self, result: Mapping[str, Any]) -> AttemptPreparation:
        snap = result["snapshot"]
        return AttemptPreparation(result["attempt_id"], snap["node_uid"], snap["manifest_digest"],
                                  snap["expires_at"], self.courier_url, result["state"], result["duplicate"])
