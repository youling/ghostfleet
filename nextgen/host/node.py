#!/usr/bin/env python3
"""Enroll once or submit GhostFleet's bounded version evidence."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

UID = re.compile(r"node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
SECRET = re.compile(r"gf_hb_[a-zA-Z0-9_-]{43}")
INVITATION = re.compile(r"gf_inv_[a-zA-Z0-9_-]{43}")
SHA = re.compile(r"[0-9a-f]{64}")
STATE = Path("/var/lib/ghostfleet-nextgen")
SETTINGS = Path("/etc/ghostfleet-nextgen/enrollment.json")


class NodeError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise NodeError("REDIRECT_REFUSED")


def require(condition, error):
    if not condition:
        raise NodeError(error)


def read_json(path, private=False, systemd_credential=False):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= 4096, "INVALID_INPUT_FILE")
        if private:
            allowed_group_read = systemd_credential and info.st_gid == os.getgid()
            require(info.st_uid in (0, os.getuid()) and not info.st_mode & (0o037 if allowed_group_read else 0o077),
                    "UNSAFE_CREDENTIAL")
        try:
            return json.loads(handle.read(4097))
        except (ValueError, UnicodeError) as error:
            raise NodeError("INVALID_JSON") from error


def write_json(path, body):
    fd, name = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(body, handle, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def valid(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value)


def origin(value, local):
    require(isinstance(value, str), "INVALID_ORIGIN")
    url = urlsplit(value)
    require(url.netloc and url.hostname and not url.username and not url.password and
            value == url.scheme + "://" + url.netloc, "INVALID_ORIGIN")
    require(url.scheme == "https" or
            (local and url.scheme == "http" and url.hostname in ("127.0.0.1", "::1")), "HTTPS_REQUIRED")
    return value


def post(target, path, body, token=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = Request(target + path, data=json.dumps(body, separators=(",", ":")).encode(), headers=headers)
    try:
        with build_opener(NoRedirect()).open(request, timeout=15) as response:
            payload = response.read(4097)
            require(len(payload) <= 4096, "RESPONSE_LIMIT")
            result = json.loads(payload)
    except HTTPError as error:
        with error:
            raise NodeError("SERVER_STATUS_" + str(error.code)) from None
    except (URLError, TimeoutError, UnicodeError, ValueError) as error:
        raise NodeError("TRANSPORT_OR_RESPONSE_FAILED") from error
    require(isinstance(result, dict) and result.get("ok") is True, "INVALID_RECEIPT")
    return result


def config(path, local):
    value = read_json(path, private=True)
    require(isinstance(value, dict) and set(value) == {"origin", "config_revision"} and
            valid(SHA, value["config_revision"]), "INVALID_TRUST_PROFILE")
    return origin(value["origin"], local), value["config_revision"]


def identity(value):
    require(isinstance(value, dict) and valid(UID, value.get("node_uid")) and
            valid(SECRET, value.get("reporting_token")), "INVALID_IDENTITY")
    return value


def enroll(directory, trusted, invitation_path, local):
    incoming = read_json(invitation_path, private=True)
    require(isinstance(incoming, dict) and set(incoming) == {"node_uid", "invitation"} and
            valid(UID, incoming["node_uid"]) and valid(INVITATION, incoming["invitation"]), "INVALID_INVITATION")
    target, revision = config(trusted, local)
    uid = incoming["node_uid"]
    stored = directory / "identity.json"
    pending = directory / "pending.json"
    if stored.exists():
        current = identity(read_json(stored, private=True))
        require(current["node_uid"] == uid and current["origin"] == target, "IDENTITY_CONFLICT")
    saved = read_json(pending, private=True) if pending.exists() else {}
    if (saved.get("invitation"), saved.get("node_uid"), saved.get("origin"), saved.get("config_revision")) != (
            incoming["invitation"], uid, target, revision):
        saved = {**incoming, "origin": target, "config_revision": revision,
                 "reporting_token": "gf_hb_" + secrets.token_urlsafe(32)}
        write_json(pending, saved)
    require(valid(SECRET, saved.get("reporting_token")), "INVALID_PENDING_CREDENTIAL")
    result = post(target, "/v2/claim", {"invitation": incoming["invitation"], "expected_node_uid": uid,
                                      "reporting_token": saved["reporting_token"], "config_revision": revision})
    require(result.get("node_uid") == uid and result.get("registration") in ("APPLIED", "ALREADY_APPLIED"),
            "INVALID_CLAIM_RECEIPT")
    write_json(stored, {key: saved[key] for key in ("node_uid", "origin", "reporting_token")})
    pending.unlink(missing_ok=True)


def adopt(directory, trusted, legacy, expected_uid, local):
    target, _ = config(trusted, local)
    prior = identity(read_json(legacy, private=True))
    require(prior["node_uid"] == expected_uid and prior.get("origin") == target, "IDENTITY_CONFLICT")
    copy = {key: prior[key] for key in ("node_uid", "origin", "reporting_token")}
    stored = directory / "identity.json"
    if stored.exists():
        require(read_json(stored, private=True) == copy, "IDENTITY_CONFLICT")
    else:
        write_json(stored, copy)


def report(identity_file, release_root, local):
    credentials = os.environ.get("CREDENTIALS_DIRECTORY")
    own = identity(read_json(identity_file, private=True,
                             systemd_credential=bool(credentials and identity_file.parent == Path(credentials))))
    artifact = read_json(release_root / "current" / "receipt.json")
    runtime = read_json(Path(__file__).resolve().parent / "receipt.json")
    uid = own["node_uid"]
    result = post(origin(own.get("origin"), local), "/v2/nodes/" + uid + "/evidence",
                  {"installed": artifact, "runtime": runtime}, own["reporting_token"])
    require(result.get("node_uid") == uid, "INVALID_EVIDENCE_RECEIPT")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-local-fixture", action="store_true")
    operations = parser.add_subparsers(dest="action", required=True)
    for action in ("enroll", "adopt"):
        command = operations.add_parser(action)
        command.add_argument("--state", type=Path, default=STATE / "private")
        command.add_argument("--trust", type=Path, default=SETTINGS)
        if action == "enroll":
            command.add_argument("--invitation-file", type=Path, required=True)
        else:
            command.add_argument("--legacy-config", type=Path, required=True)
            command.add_argument("--expected-node-uid", required=True)
    command = operations.add_parser("report")
    command.add_argument("--identity", type=Path, required=True)
    command.add_argument("--release-root", type=Path, default=STATE / "software")
    args = parser.parse_args()
    try:
        if args.action == "report":
            report(args.identity, args.release_root, args.allow_local_fixture)
        else:
            args.state.mkdir(mode=0o700, parents=True, exist_ok=True)
            info = args.state.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
                    "UNSAFE_STATE_DIRECTORY")
            fd = os.open(args.state / "identity.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                if args.action == "enroll":
                    enroll(args.state, args.trust, args.invitation_file, args.allow_local_fixture)
                else:
                    adopt(args.state, args.trust, args.legacy_config, args.expected_node_uid, args.allow_local_fixture)
        print("GHOSTFLEET_" + args.action.upper() + "_OK")
    except (NodeError, OSError) as error:
        print(str(error) if isinstance(error, NodeError) else "LOCAL_IO_FAILED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
