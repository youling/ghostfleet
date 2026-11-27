#!/usr/bin/env python3
"""Submit GhostFleet's bounded version evidence."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

UID = re.compile(r"node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
SECRET = re.compile(r"gf_hb_[a-zA-Z0-9_-]{43}")
STATE = Path("/var/lib/ghostfleet-nextgen")


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
            # systemd can grant DynamicUser an ACL on a root:root 0440 credential.
            require(info.st_uid in (0, os.getuid()) and not info.st_mode & (0o037 if systemd_credential else 0o077),
                    "UNSAFE_CREDENTIAL")
        try:
            return json.loads(handle.read(4097))
        except (ValueError, UnicodeError) as error:
            raise NodeError("INVALID_JSON") from error


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


def identity(value):
    require(isinstance(value, dict) and valid(UID, value.get("node_uid")) and
            valid(SECRET, value.get("reporting_token")), "INVALID_IDENTITY")
    return value


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
    command = operations.add_parser("report")
    command.add_argument("--identity", type=Path, required=True)
    command.add_argument("--release-root", type=Path, default=STATE / "software")
    args = parser.parse_args()
    try:
        report(args.identity, args.release_root, args.allow_local_fixture)
        print("GHOSTFLEET_" + args.action.upper() + "_OK")
    except (NodeError, OSError) as error:
        print(str(error) if isinstance(error, NodeError) else "LOCAL_IO_FAILED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
