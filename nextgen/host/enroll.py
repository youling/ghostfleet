#!/usr/bin/env python3
"""Manually enroll or adopt a node using the independently installed bootstrap."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tempfile

# In isolated mode import only the helper installed beside this root-owned entry point.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from node import NodeError, SECRET, STATE, UID, identity, origin, post, read_json, require, valid
from update import UpdateError, safe_dir, trusted_parents

INVITATION = re.compile(r"gf_inv_[a-zA-Z0-9_-]{43}")
SHA = re.compile(r"[0-9a-f]{64}")
SETTINGS = Path("/etc/ghostfleet-nextgen/enrollment.json")


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


def config(path, local):
    trusted_parents(path.absolute())
    value = read_json(path, private=True)
    require(isinstance(value, dict) and set(value) == {"origin", "config_revision"} and
            valid(SHA, value["config_revision"]), "INVALID_TRUST_PROFILE")
    return origin(value["origin"], local), value["config_revision"]


def enroll(directory, trusted, invitation_path, local):
    incoming = read_json(invitation_path, private=True)
    require(isinstance(incoming, dict) and set(incoming) == {"node_uid", "invitation"} and
            valid(UID, incoming["node_uid"]) and valid(INVITATION, incoming["invitation"]), "INVALID_INVITATION")
    target, revision = config(trusted, local)
    uid = incoming["node_uid"]
    invitation_digest = hashlib.sha256(incoming["invitation"].encode()).hexdigest()
    stored = directory / "identity.json"
    pending = directory / "pending.json"
    if stored.exists():
        current = identity(read_json(stored, private=True))
        require(current["node_uid"] == uid and current["origin"] == target, "IDENTITY_CONFLICT")
        if current.get("last_invitation_digest") == invitation_digest:
            pending.unlink(missing_ok=True)
            return
    saved = read_json(pending, private=True) if pending.exists() else {}
    require(isinstance(saved, dict), "INVALID_PENDING_CREDENTIAL")
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
    write_json(stored, {"node_uid": uid, "origin": target, "reporting_token": saved["reporting_token"],
                        "last_invitation_digest": invitation_digest})
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
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0, "ROOT_REQUIRED")
        if args.state == STATE / "private":
            safe_dir(STATE)
        args.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        trusted_parents(args.state.absolute())
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
    except (NodeError, UpdateError, OSError) as error:
        print(str(error) if isinstance(error, (NodeError, UpdateError)) else "LOCAL_IO_FAILED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
