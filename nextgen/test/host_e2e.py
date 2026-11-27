"""Cross-process fixture. Invoked by host-e2e.mjs with a loopback Worker."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys
import tempfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from test_update import NEXTGEN, UpdateTest
from update import UpdateError, active, pull

ORIGIN = sys.argv[1]
OPERATOR = os.environ.pop("GHOSTFLEET_FIXTURE_OPERATOR")
REVISION = "a" * 64
PROFILE = {"platform": "debian13-amd64", "channel": "canary", "config_revision": REVISION, "desired": None}


def api(path, body=None, token=None, expected=200):
    request = Request(ORIGIN + path, data=json.dumps(body).encode() if body is not None else None,
                      headers={"Content-Type": "application/json",
                               **({"Authorization": "Bearer " + token} if token else {})})
    try:
        with urlopen(request, timeout=8) as response:
            assert response.status == expected, (path, response.status, expected)
            return json.load(response)
    except HTTPError as denied:
        with denied:
            assert denied.code == expected, (path, denied.code, expected)
            return json.load(denied)


def private_json(path, value):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle)
    return path


def node(installed, action, *args, reporter=None):
    if action == "report":
        # Mirror LoadCredential with a temporary per-service readable copy.
        with tempfile.TemporaryDirectory(dir=installed.parent) as directory:
            credential = Path(directory) / "identity.json"
            identity_index = args.index("--identity") + 1
            credential.write_bytes(Path(args[identity_index]).read_bytes())
            account = pwd.getpwnam("nobody")
            os.chown(credential, account.pw_uid, account.pw_gid)
            credential.chmod(0o400)
            Path(directory).chmod(0o711)
            options = list(args)
            options[identity_index] = credential
            entry = reporter or installed.parent / "report.py"
            invocation = [action] if reporter else []
            output = subprocess.run([sys.executable, "-I", str(entry), "--allow-local-fixture", *invocation,
                                     *map(str, options)], timeout=20, capture_output=True,
                                    user=account.pw_uid, group=account.pw_gid, extra_groups=[])
    else:
        output = subprocess.run([sys.executable, "-I", str(NEXTGEN / "host/enroll.py"), "--allow-local-fixture",
                                 action, *map(str, args)], timeout=20, capture_output=True)
    assert output.returncode == 0, ("NODE_COMMAND_FAILED", action, output.stderr.decode().strip())


def catalog(uid):
    return next(item for item in api("/v2/nodes", token=OPERATOR)["nodes"] if item["node_uid"] == uid)


def exercise(fixture):
    base, installed = fixture.workspace, fixture.installed
    launcher = base / "report.py"
    launcher.write_bytes((NEXTGEN / "host/report.py").read_bytes())
    launcher.chmod(0o644)
    first, package1 = fixture.channel("0.3.0~rc1")
    second, package2 = fixture.channel("0.3.0~rc2", reporter=fixture.reporter + b"\n# Second reviewed candidate\n")
    rejected, _ = fixture.channel("0.3.0~rc3", expired=True)
    rollback, package4 = fixture.channel("0.3.0~rc4")
    trust = private_json(base / "trusted.json", {"origin": ORIGIN, "config_revision": REVISION})
    assert pull(installed, first, "amd64") == "ACTIVATED"
    assert active(installed)["sha256"] == hashlib.sha256(package1.read_bytes()).hexdigest()
    invite = api("/v2/invitations", {"label": "First enrollment", "profile": PROFILE}, OPERATOR, expected=201)
    uid = invite["node_uid"]
    invitation = private_json(base / "invite.json", {key: invite[key] for key in ("node_uid", "invitation")})
    state = base / "new-identity"
    node(installed, "enroll", "--state", state, "--trust", trust, "--invitation-file", invitation)
    credential = state / "identity.json"
    original = credential.read_bytes()
    old_reporter = (installed / "current/node.py").resolve()
    node(installed, "enroll", "--state", state, "--trust", trust, "--invitation-file", invitation)
    assert credential.read_bytes() == original
    node(installed, "report", "--release-root", installed, "--identity", credential)
    assert catalog(uid)["versions"]["runtime"]["version"] == "0.3.0~rc1"
    assert catalog(uid)["health"]["compute"]["verdict"] == "UNKNOWN"

    old = api("/v0/enrollment-tickets", {"label": "Legacy fixture"}, OPERATOR, expected=201)
    legacy_uid = old["ticket"]["node_uid"]
    claimed = api("/v1/enrollment-tickets/" + old["ticket"]["ticket_id"] + "/claim", {"short_code": old["short_code"]})
    legacy_token = claimed["reporting_token"]
    heartbeat_path = "/v1/nodes/" + legacy_uid + "/heartbeat"
    heartbeat = {"protocol": "ghostfleet-heartbeat/v1", "boot_id": None, "reporter_version": "1",
                 "services": {"ssh": "active", "tailscaled": "not_found", "cloudflared": "not_found"}}
    api(heartbeat_path, heartbeat, legacy_token)
    old_settings = private_json(base / "legacy.json", {"origin": ORIGIN, "node_uid": legacy_uid,
        "reporting_token": legacy_token, "units": {"ssh": "ssh.service"}})
    preserved_legacy = old_settings.read_bytes()
    api("/v2/nodes/" + legacy_uid + "/adopt", {"profile": PROFILE}, OPERATOR)
    legacy_state = base / "legacy-identity"
    node(installed, "adopt", "--state", legacy_state, "--trust", trust, "--legacy-config", old_settings,
         "--expected-node-uid", legacy_uid)

    assert pull(installed, second, "amd64") == "ACTIVATED"
    assert active(installed)["sha256"] == hashlib.sha256(package2.read_bytes()).hexdigest()
    api("/v2/nodes/" + uid + "/desired", {"desired": active(installed)}, OPERATOR)
    node(installed, "report", "--release-root", installed, "--identity", credential, reporter=old_reporter)
    assert catalog(uid)["versions"]["state"] == "RUNTIME_UNVERIFIED"
    assert catalog(uid)["versions"]["runtime"]["version"] == "0.3.0~rc1"
    node(installed, "report", "--release-root", installed, "--identity", credential)
    assert catalog(uid)["versions"]["state"] == "CURRENT"
    node(installed, "report", "--release-root", installed, "--identity", legacy_state / "identity.json")
    api(heartbeat_path, heartbeat, legacy_token)
    assert catalog(legacy_uid)["versions"]["legacy_reporter"] == "1"
    assert catalog(legacy_uid)["versions"]["runtime"]["version"] == "0.3.0~rc2"
    assert old_settings.read_bytes() == preserved_legacy

    try:
        pull(installed, rejected, "amd64")
    except UpdateError:
        assert active(installed)["version"] == "0.3.0~rc2"
    else:
        raise RuntimeError("EXPIRED_UPDATE_WAS_ACCEPTED")
    assert pull(installed, rollback, "amd64") == "ACTIVATED"
    assert active(installed)["sha256"] == hashlib.sha256(package4.read_bytes()).hexdigest()
    assert (installed / "current/node.py").read_bytes() == fixture.reporter
    assert credential.read_bytes() == original
    node(installed, "report", "--release-root", installed, "--identity", credential)
    current = catalog(uid)
    assert current["versions"]["runtime"]["version"] == "0.3.0~rc4"
    api("/v2/nodes/" + uid + "/revoke", {}, OPERATOR)
    api("/v2/nodes/" + uid + "/evidence", {"installed": None, "runtime": None},
        json.loads(original)["reporting_token"], expected=401)
    assert catalog(uid)["reporting"] == "REVOKED"


if __name__ == "__main__":
    UpdateTest.setUpClass()
    try:
        scenario = UpdateTest("test_upgrade_noop_and_reviewed_roll_forward")
        scenario.setUp()
        exercise(scenario)
        print("HOST_E2E_PASS enrollment signed updates roll-forward old-UID migration active report revoke")
    finally:
        UpdateTest.doClassCleanups()
