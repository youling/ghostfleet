"""One-time enrollment with protected input and durable before-claim resume."""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import stat
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from ghostfleet_runtime.control.enrollment_console import ATTEMPT_PROTOCOL, CONSOLE_PROTOCOL, DIGEST_RE, NODE_RE
from ghostfleet_runtime.control.enrollment_attempt import AttemptError

BEARER_RE = re.compile(r"[A-Za-z0-9_-]{32,128}")
ATTEMPT_RE = re.compile(r"attempt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
TEMPLATE_RE = re.compile(r"[a-z0-9][a-z0-9-]{2,63}")
RESUME_PATH = "/var/lib/fleet/enrollment-console/ticket-resume.json"
HANDOFF_PATH = "/var/lib/fleet/converger-v1/handoff.json"
CONFIG_PATH = "/etc/youling-fleet/converger.json"


class EnrollError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def ticket_url(value: str) -> tuple[str, str]:
    if not isinstance(value, str) or len(value) > 1800 or any(ord(c) < 33 for c in value):
        raise EnrollError("TICKET_URL_INVALID")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise EnrollError("TICKET_URL_INVALID")
    m = re.fullmatch(r"/v1/enrollment-tickets/([A-Za-z0-9_-]{32,128})", parsed.path)
    if not m:
        raise EnrollError("TICKET_URL_INVALID")
    return value, m.group(1)


class HttpClaimClient:
    def __init__(self, *, timeout: float = 15):
        self.timeout = timeout
        self.opener = urllib.request.build_opener(_NoRedirect())

    def claim(self, url: str, short_code: str, resume_capability: str) -> dict[str, Any]:
        ticket_url(url)
        body = json.dumps({"short_code": short_code, "resume_capability": resume_capability}, separators=(",", ":")).encode()
        req = urllib.request.Request(url, data=body, method="POST", headers={"content-type": "application/json", "accept": "application/json"})
        try:
            with self.opener.open(req, timeout=self.timeout) as response:
                raw = response.read(65537)
                if len(raw) > 65536:
                    raise EnrollError("CLAIM_RESPONSE_TOO_LARGE")
                data = json.loads(raw)
                if response.status < 200 or response.status >= 300 or not isinstance(data, dict):
                    raise EnrollError("CLAIM_REJECTED")
                return data
        except EnrollError:
            raise
        except urllib.error.HTTPError:
            raise EnrollError("CLAIM_REJECTED") from None
        except Exception:
            raise EnrollError("CLAIM_OUTCOME_UNKNOWN") from None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise EnrollError("CLAIM_REDIRECT_FORBIDDEN")


class RootEnrollmentState:
    """Root-owned exact-write state. Resume is saved before the first claim."""
    def __init__(self, root: str | os.PathLike[str] = "/"):
        self.root = Path(root).absolute()

    def _path(self, absolute: str) -> Path:
        if not absolute.startswith("/") or ".." in Path(absolute).parts:
            raise EnrollError("LOCAL_PATH_INVALID")
        return self.root / absolute.lstrip("/")

    def _parents(self, path: Path) -> None:
        current = self.root
        for part in path.parent.relative_to(self.root).parts:
            current /= part
            if not current.exists():
                current.mkdir(mode=0o700)
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o022:
                raise EnrollError("LOCAL_PATH_UNTRUSTED")

    def read(self, absolute: str) -> dict[str, Any] | None:
        path = self._path(absolute)
        if not path.exists() and not path.is_symlink():
            return None
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 65536:
            raise EnrollError("LOCAL_STATE_UNTRUSTED")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (OSError, ValueError):
            raise EnrollError("LOCAL_STATE_INVALID") from None

    def write_exact(self, absolute: str, value: dict[str, Any]) -> None:
        path = self._path(absolute)
        self._parents(path)
        content = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
        prior = self.read(absolute)
        if prior is not None:
            if (json.dumps(prior, sort_keys=True, separators=(",", ":")) + "\n").encode() == content:
                return
            raise EnrollError("LOCAL_STATE_CONFLICT")
        fd, tmp = tempfile.mkstemp(prefix=".fleet-enroll-", dir=path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(content); stream.flush(); os.fsync(stream.fileno())
            os.replace(tmp, path)
            directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def resume(self, url: str, bearer: str) -> str:
        prior = self.read(RESUME_PATH)
        if prior:
            if prior.get("owner") != "fleet-enroll/v1" or prior.get("ticket_url") != url or prior.get("bearer") != bearer or BEARER_RE.fullmatch(str(prior.get("resume_capability", ""))) is None:
                raise EnrollError("TICKET_RESUME_CONFLICT")
            return prior["resume_capability"]
        cap = secrets.token_urlsafe(32)
        self.write_exact(RESUME_PATH, {"owner": "fleet-enroll/v1", "ticket_url": url, "bearer": bearer, "resume_capability": cap})
        return cap

    def retire_resume(self) -> None:
        path = self._path(RESUME_PATH)
        if path.exists() or path.is_symlink():
            self.read(RESUME_PATH)
            path.unlink()
            directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)


def validate_claim(data: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(data, dict) or data.get("protocol") != CONSOLE_PROTOCOL:
        raise EnrollError("CLAIM_BINDING_INVALID")
    handoff = data.get("attempt_handoff")
    boot = data.get("bootstrap_generation")
    if not isinstance(handoff, dict) or not isinstance(boot, dict):
        raise EnrollError("CLAIM_BINDING_INVALID")
    required_handoff = {"protocol", "node_uid", "attempt_id", "manifest_digest", "client_binding", "claim_code", "courier_url", "expires_at"}
    if set(handoff) != required_handoff or handoff["protocol"] != ATTEMPT_PROTOCOL:
        raise EnrollError("CLAIM_BINDING_INVALID")
    if NODE_RE.fullmatch(str(handoff["node_uid"])) is None or ATTEMPT_RE.fullmatch(str(handoff["attempt_id"])) is None \
            or DIGEST_RE.fullmatch(str(handoff["manifest_digest"])) is None or DIGEST_RE.fullmatch(str(handoff["client_binding"])) is None \
            or BEARER_RE.fullmatch(str(handoff["claim_code"])) is None \
            or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", str(handoff["expires_at"])) is None:
        raise EnrollError("CLAIM_BINDING_INVALID")
    courier = urlsplit(str(handoff["courier_url"]))
    if courier.scheme != "https" or not courier.hostname or courier.username or courier.password or courier.query or courier.fragment or courier.path not in ("", "/"):
        raise EnrollError("CLAIM_BINDING_INVALID")
    required_boot = {"schema_version", "template_id", "template_digest", "attempt_id", "node_uid", "converger_config"}
    if set(boot) != required_boot or boot["schema_version"] != "1.0.0" or TEMPLATE_RE.fullmatch(str(boot["template_id"])) is None \
            or DIGEST_RE.fullmatch(str(boot["template_digest"])) is None or boot["attempt_id"] != handoff["attempt_id"] \
            or boot["node_uid"] != handoff["node_uid"] or not isinstance(boot["converger_config"], dict):
        raise EnrollError("BOOTSTRAP_BINDING_INVALID")
    if data.get("template_id") != boot["template_id"] or data.get("template_digest") != boot["template_digest"]:
        raise EnrollError("BOOTSTRAP_BINDING_INVALID")
    return handoff, boot


def run_enrollment(*, url: str, short_code: str, claim_client: Any, state: RootEnrollmentState,
                   system: Any, converger_factory: Callable[[Any, dict[str, Any]], Any]) -> dict[str, Any]:
    url, bearer = ticket_url(url)
    if re.fullmatch(r"[0-9]{4,12}", short_code or "") is None:
        raise EnrollError("TICKET_CODE_INVALID")
    resume = state.resume(url, bearer)  # durable before network claim
    data = claim_client.claim(url, short_code, resume)
    handoff, boot = validate_claim(data)
    config = dict(boot["converger_config"])
    if config.get("handoff_path") != HANDOFF_PATH:
        raise EnrollError("BOOTSTRAP_HANDOFF_PATH_INVALID")
    try:
        converger = converger_factory(system, config)  # constructor validates config before persistence
    except AttemptError:
        raise
    except Exception:
        raise EnrollError("BOOTSTRAP_CONFIG_INVALID") from None
    state.write_exact(HANDOFF_PATH, handoff)
    state.write_exact(CONFIG_PATH, config)
    try:
        result = converger.run()
    except AttemptError:
        raise
    except Exception:
        raise EnrollError("CONVERGER_OUTCOME_UNKNOWN") from None
    state.retire_resume()
    return {"outcome": "ENROLLMENT_COMMAND_COMPLETE", "attempt_id": handoff["attempt_id"], "node_uid": handoff["node_uid"], "converger": result}


def parse_enrollment_input(raw: bytes) -> dict[str, str]:
    """Bounded strict input; errors never reflect URL, short code or JSON body."""
    if not isinstance(raw, bytes) or len(raw) > 16384:
        raise EnrollError("ENROLLMENT_INPUT_TOO_LARGE")
    try:
        pairs = []
        def strict_object(values):
            result = {}
            for key, value in values:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=strict_object)
        if not isinstance(value, dict) or set(value) != {"one_time_url", "short_code"}:
            raise ValueError()
        ticket_url(value["one_time_url"])
        if not isinstance(value["short_code"], str) or re.fullmatch(r"[0-9]{4,12}", value["short_code"]) is None:
            raise ValueError()
        return value
    except Exception:
        raise EnrollError("ENROLLMENT_INPUT_INVALID") from None


def read_enrollment_input(*, ticket_file=None, ticket_stdin=False, interactive=False, stream=None):
    if sum((bool(ticket_file), bool(ticket_stdin), bool(interactive))) != 1:
        raise EnrollError("ONE_ENROLLMENT_INPUT_REQUIRED")
    if interactive:
        import getpass
        # getpass refuses no-echo fallbacks instead of exposing credentials.
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            try:
                value = {"one_time_url": getpass.getpass("One-time URL: "), "short_code": getpass.getpass("Short code: ")}
            except Exception:
                raise EnrollError("HIDDEN_INPUT_UNAVAILABLE") from None
        return parse_enrollment_input(json.dumps(value).encode())
    if ticket_stdin:
        supplied = stream or sys.stdin.buffer
        if getattr(supplied, "isatty", lambda: False)():
            raise EnrollError("PRIVATE_PIPE_REQUIRED")
        return parse_enrollment_input(supplied.read(16385))
    path = Path(ticket_file)
    if not path.is_absolute() or ".." in path.parts:
        raise EnrollError("INPUT_FILE_UNTRUSTED")
    fd = None
    try:
        # Verify each ancestor before open; final inode verification rejects symlinks and races.
        current = Path(path.anchor)
        for part in path.parent.parts[1:]:
            current /= part
            info = current.lstat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise EnrollError("INPUT_FILE_UNTRUSTED")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 16384:
            raise EnrollError("INPUT_FILE_UNTRUSTED")
        with os.fdopen(fd, "rb") as supplied:
            fd = None
            return parse_enrollment_input(supplied.read(16385))
    except EnrollError:
        raise
    except Exception:
        raise EnrollError("INPUT_FILE_UNTRUSTED") from None
    finally:
        if fd is not None:
            os.close(fd)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Consume one Fleet Control Panel enrollment ticket")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--ticket-file", help="Absolute root-owned mode-0600 JSON input; never a bearer value")
    group.add_argument("--ticket-stdin", action="store_true", help="Read bounded JSON from a private pipe without echo")
    group.add_argument("--interactive", action="store_true", help="Read URL and code with hidden terminal input")
    args = parser.parse_args(argv)
    try:
        if sys.platform != "linux" or os.geteuid() != 0:
            raise EnrollError("LINUX_ROOT_REQUIRED")
        supplied = read_enrollment_input(ticket_file=args.ticket_file, ticket_stdin=args.ticket_stdin, interactive=args.interactive)
        from ghostfleet_runtime.linux.converger import Converger
        from ghostfleet_runtime.linux.system import LinuxSystem
        result = run_enrollment(url=supplied["one_time_url"], short_code=supplied["short_code"], claim_client=HttpClaimClient(),
                                state=RootEnrollmentState(), system=LinuxSystem(), converger_factory=Converger)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (EnrollError, AttemptError) as exc:
        code = getattr(exc, "code", "ENROLLMENT_FAILED")
        print(json.dumps({"outcome": "RECONCILE_REQUIRED", "reason": code}), file=sys.stderr)
        return 2
    except Exception:
        print('{"outcome":"RECONCILE_REQUIRED","reason":"LOCAL_OUTCOME_UNKNOWN"}', file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
