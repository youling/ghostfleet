#!/usr/bin/env python3
"""Read provider facts and prepare a separately authorized native K3s Agent."""
import argparse
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

UID = re.compile(r"node-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,64}")
HOST = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9.-]{0,253}")
LOGIN = re.compile(r"[a-z_][a-z0-9_-]{0,30}")
K3S_VERSION = re.compile(r"v1\.\d{1,3}\.\d{1,4}\+k3s\d{1,3}")
VERSION = re.compile(r"[a-zA-Z0-9._+~-]{1,60}")
SHA = re.compile(r"[a-f0-9]{64}")
SSH_KEY = re.compile(r"(?:ssh-ed25519|ecdsa-sha2-nistp256) [A-Za-z0-9+/]{40,400}={0,2}")
AGENT_HOME = Path("/etc/ghostfleet-nextgen/k3s")
AGENT_UNIT = "ghostfleet-nextgen-k3s-agent.service"
PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


class NativeError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise NativeError("REDIRECT_REFUSED")


def require(condition, code):
    if not condition:
        raise NativeError(code)


def match(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value)


def shape(value, fields, optional=()):
    require(isinstance(value, dict) and set(fields) <= value.keys() <= set(fields) | set(optional), "INVALID_PROFILE")


def read(path, *, secret=False, limit=65536):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, "INVALID_LOCAL_FILE")
        if secret:
            require(info.st_uid in (0, os.getuid()) and not info.st_mode & 0o077, "UNSAFE_CREDENTIAL_FILE")
        data = handle.read(limit + 1)
        require(len(data) <= limit, "LOCAL_FILE_TOO_LARGE")
        return data


def request_json(url, token, body=None):
    headers = {"Accept": "application/json", "Authorization": "Bearer " + token}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(url, headers=headers, data=None if body is None else json.dumps(body).encode())
    with build_opener(NoRedirect()).open(request, timeout=10) as response:
        data = response.read(1024 * 1024 + 1)
        require(len(data) <= 1024 * 1024, "PROVIDER_RESPONSE_TOO_LARGE")
        return json.loads(data)


def command(args, *, timeout=12):
    return subprocess.run(args, capture_output=True, timeout=timeout, check=False,
                          env={"PATH": PATH, "LC_ALL": "C", "HOME": str(Path.home())})


def kube(args):
    command_path = shutil.which("kubectl", path=PATH)
    if command_path:
        return [command_path, *args]
    command_path = shutil.which("k3s", path=PATH)
    require(command_path, "KUBECTL_UNAVAILABLE")
    return [command_path, "kubectl", *args]


def receipt(source, dimension, verdict, now, version=None):
    result = {"source": source, "dimension": dimension, "verdict": verdict,
              "observed_at": now.isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    if match(VERSION, version):
        result["version"] = version
    return result


def fresh(value, now, max_seconds):
    if not isinstance(value, str):
        return False
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return timestamp.tzinfo is not None and 0 <= (now - timestamp).total_seconds() <= max_seconds
    except (ValueError, OverflowError):
        return False


def sampled(now):
    # Observations pass a clock, sampled after I/O; direct callers may pass a datetime.
    return now() if callable(now) else now


def tailscale(binding, now):
    shape(binding, ("device_id", "credential_file"))
    device = binding["device_id"]
    require(match(IDENTIFIER, device), "INVALID_TAILSCALE_BINDING")
    token = read(binding["credential_file"], secret=True, limit=4096).decode().strip()
    result = request_json("https://api.tailscale.com/api/v2/device/" + device, token)
    require(device in (result.get("id"), result.get("nodeId")), "TAILSCALE_IDENTITY_MISMATCH")
    now = sampled(now)
    connected, authorized = result.get("connectedToControl"), result.get("authorized")
    # lastSeen can be absent while connected and recent while disconnected.
    verdict = "UNKNOWN" if type(connected) is not bool or type(authorized) is not bool else (
        "READY" if authorized and connected else "UNAVAILABLE")
    return receipt("tailscale-api", "network", verdict, now, result.get("clientVersion"))


def cloudflare(binding, now):
    shape(binding, ("account_id", "tunnel_id", "credential_file"))
    account, tunnel = binding["account_id"], binding["tunnel_id"]
    require(match(re.compile(r"[a-f0-9]{32}"), account) and match(UUID, tunnel), "INVALID_TUNNEL_BINDING")
    token = read(binding["credential_file"], secret=True, limit=4096).decode().strip()
    envelope = request_json("https://api.cloudflare.com/client/v4/accounts/" + account + "/cfd_tunnel/" + tunnel, token)
    tunnel_info = envelope.get("result")
    require(envelope.get("success") is True and isinstance(tunnel_info, dict) and tunnel_info.get("id") == tunnel,
            "TUNNEL_IDENTITY_MISMATCH")
    now = sampled(now)
    status = tunnel_info.get("status")
    verdict = "READY" if status == "healthy" else "UNAVAILABLE" if status in ("down", "inactive", "degraded") else "UNKNOWN"
    return receipt("cloudflare-api", "edge", verdict, now)


def ssh(binding, now, *, diagnostics=None):
    shape(binding, ("host", "port", "login", "host_key", "identity_file", "transport", "dimension"))
    host, port, login = binding["host"], binding["port"], binding["login"]
    require(match(HOST, host) and type(port) is int and 1 <= port <= 65535 and match(LOGIN, login) and
            match(SSH_KEY, binding["host_key"]) and binding["transport"] in ("direct", "tailscale", "cloudflare") and
            binding["dimension"] in ("management", "origin", "rescue"), "INVALID_SSH_BINDING")
    require(binding["transport"] == "direct" or binding["dimension"] != "rescue", "RESCUE_MUST_BE_INDEPENDENT")
    read(binding["identity_file"], secret=True, limit=65536)
    command_path = shutil.which("ssh", path=PATH)
    require(command_path, "OPENSSH_UNAVAILABLE")
    proxy = "none"
    if binding["transport"] == "cloudflare":
        cloudflared = shutil.which("cloudflared", path=PATH)
        require(cloudflared, "CLOUDFLARED_UNAVAILABLE")
        proxy = cloudflared + " access ssh --hostname " + host
    with tempfile.TemporaryDirectory(prefix="gf-ssh-probe-") as temporary:
        known_hosts = Path(temporary) / "known_hosts"
        formatted = host if port == 22 else f"[{host}]:{port}"
        known_hosts.write_text(formatted + " " + binding["host_key"] + "\n", encoding="ascii")
        # The only remote operation is a no-op after native target authentication.
        session = command([
            command_path, "-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
            "-o", "StrictHostKeyChecking=yes", "-o", "GlobalKnownHostsFile=/dev/null", "-o",
            f"UserKnownHostsFile={known_hosts}", "-o", "ClearAllForwardings=yes", "-o", "IdentitiesOnly=yes",
            "-o", "IdentityAgent=none", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
            "-o", "ProxyCommand=" + proxy, "-i", binding["identity_file"], "-p", str(port),
            "-l", login, "--", host, "/usr/bin/true",
        ])
    now = sampled(now)
    if session.returncode == 0:
        return receipt("ssh-probe", binding["dimension"], "READY", now)
    # Output may contain endpoint/user/credential facts: return only fixed codes.
    detail = session.stderr.decode("utf-8", errors="replace").lower()
    if "host key verification failed" in detail or "remote host identification has changed" in detail:
        reason = "SSH_HOST_KEY_REJECTED"
    elif "permission denied" in detail or "no supported authentication methods" in detail:
        reason = "SSH_AUTHENTICATION_FAILED"
    elif any(message in detail for message in ("connection timed out", "connection refused", "no route to host",
                                               "network is unreachable", "could not resolve hostname")):
        reason = "SSH_CONNECTION_FAILED"
    else:
        reason = "SSH_PROBE_FAILED"
    if diagnostics is not None:
        diagnostics.append({"source": "ssh-probe", "dimension": binding["dimension"], "reason": reason})
    return receipt("ssh-probe", binding["dimension"],
                   "UNKNOWN" if reason == "SSH_PROBE_FAILED" else "UNAVAILABLE", now)


def kubernetes(binding, now):
    shape(binding, ("kubeconfig", "context", "cluster_uid", "node_name", "node_uid"))
    require(match(IDENTIFIER, binding["context"]) and match(HOST, binding["node_name"]) and
            match(UUID, binding["cluster_uid"]) and match(UUID, binding["node_uid"]), "INVALID_CLUSTER_BINDING")
    read(binding["kubeconfig"], secret=True)
    args = kube(["--kubeconfig", binding["kubeconfig"], "--context", binding["context"], "--request-timeout=6s"])

    def get(*arguments):
        result = command([*args, *arguments, "-o", "json"])
        require(result.returncode == 0 and len(result.stdout) <= 1024 * 1024, "KUBE_READ_FAILED")
        return json.loads(result.stdout)

    cluster = get("config", "view", "--minify")["clusters"]
    require(len(cluster) == 1 and not cluster[0]["cluster"].get("insecure-skip-tls-verify") and
            urlsplit(cluster[0]["cluster"]["server"]).scheme == "https", "KUBE_TLS_REQUIRED")
    require(get("get", "namespace", "kube-system")["metadata"]["uid"] == binding["cluster_uid"], "CLUSTER_PIN_MISMATCH")
    node = get("get", "node", binding["node_name"])
    require(node["metadata"]["uid"] == binding["node_uid"], "KUBE_NODE_PIN_MISMATCH")
    lease = get("get", "lease", binding["node_name"], "-n", "kube-node-lease")
    now = sampled(now)
    lease_ready = lease["spec"]["holderIdentity"] == binding["node_name"] and fresh(lease["spec"]["renewTime"], now, 90)
    ready = any(item["type"] == "Ready" and item["status"] == "True" for item in node["status"]["conditions"])
    return receipt("kubernetes-api", "compute", "READY" if ready and lease_ready else "UNAVAILABLE",
                   now, node["status"]["nodeInfo"]["kubeletVersion"])


def observations(profile):
    shape(profile, ("node_uid",), ("tailscale", "cloudflare", "ssh", "kubernetes"))
    require(match(UID, profile["node_uid"]), "INVALID_FLEET_UID")
    clock = lambda: datetime.now(timezone.utc)
    result, notices = [], []
    for source, collector, dimension in (
            ("tailscale", tailscale, "network"), ("cloudflare", cloudflare, "edge"),
            ("ssh", ssh, "management"), ("kubernetes", kubernetes, "compute")):
        if source not in profile:
            continue
        if source == "ssh":
            require(isinstance(profile[source], list) and 0 < len(profile[source]) <= 3 and
                    all(isinstance(item, dict) and item.get("dimension") in ("management", "origin", "rescue")
                        for item in profile[source]) and
                    len({item.get("dimension") for item in profile[source]}) == len(profile[source]),
                    "INVALID_SSH_BINDINGS")
            bindings = profile[source]
        else:
            bindings = [profile[source]]
        for binding in bindings:
            try:
                result.append(collector(binding, clock, diagnostics=notices) if source == "ssh"
                              else collector(binding, clock))
            except (NativeError, OSError, ValueError, KeyError, TypeError, IndexError, AttributeError,
                    subprocess.TimeoutExpired) as error:
                now = clock()
                trusted_source = {"tailscale": "tailscale-api", "cloudflare": "cloudflare-api",
                                  "ssh": "ssh-probe", "kubernetes": "kubernetes-api"}[source]
                dimension = binding["dimension"] if source == "ssh" else dimension
                result.append(receipt(trusted_source, dimension, "UNKNOWN", now))
                notices.append({"source": trusted_source, "dimension": dimension,
                                "reason": str(error) if isinstance(error, NativeError) else (
                                    "SSH_TIMEOUT" if source == "ssh" and isinstance(error, subprocess.TimeoutExpired)
                                    else "EVIDENCE_UNAVAILABLE")})
    return {"node_uid": profile["node_uid"], "observations": result, "diagnostics": notices}


def existing_k3s_paths():
    candidates = (Path("/etc/rancher/k3s"), Path("/var/lib/rancher/k3s"),
                  Path.home() / ".rancher/k3s")
    return any(path.exists() or path.is_symlink() for path in candidates)


def discover():
    components = {}
    for executable, unit in (("ssh", "ssh"), ("tailscale", "tailscaled"), ("cloudflared", "cloudflared"),
                             ("k3s", "k3s-agent"), ("k3s", "k3s"), ("k3s", AGENT_UNIT)):
        service = command(["systemctl", "show", unit, "--property=LoadState,ActiveState"])
        state = dict(line.split("=", 1) for line in service.stdout.decode().splitlines() if "=" in line)
        available = bool(shutil.which(executable, path=PATH))
        loaded = state.get("LoadState")
        components[unit] = {"binary_found": available, "unit": loaded or "unknown",
                            "activity": state.get("ActiveState", "unknown")}
    # Include custom names, inactive unit files and running units. Inventory errors
    # are uncertainty, not proof of absence. Do not read service environments.
    owner_state = "detected" if existing_k3s_paths() else "clear"
    for inventory in ("list-unit-files", "list-units"):
        result = command(["systemctl", inventory, "--all", "--no-legend", "--no-pager", "*k3s*"])
        if result.returncode != 0:
            owner_state = "unknown" if owner_state == "clear" else owner_state
        else:
            units = [line.split()[0] for line in result.stdout.decode().splitlines() if line.strip()]
            if any(unit != AGENT_UNIT for unit in units):
                owner_state = "detected"
    # A custom systemd unit can run k3s under a name without 'k3s'. Read only
    # process names, never argv/environ, which may carry credentials.
    try:
        for process in Path("/proc").iterdir():
            if process.name.isdecimal():
                try:
                    name = (process / "comm").read_text().strip()
                except FileNotFoundError:  # process exited during inventory
                    continue
                if name == "k3s" or name.startswith("k3s-"):
                    owner_state = "detected"
    except OSError:
        owner_state = "unknown" if owner_state == "clear" else owner_state
    components["k3s-ownership"] = {"state": owner_state}
    return components


def agent_plan(profile, current):
    shape(profile, ("node_uid", "server", "ca_sha256", "version", "sha256", "node_name"), ("node_ip", "flannel_iface"))
    server = urlsplit(profile["server"])
    require(match(UID, profile["node_uid"]) and match(K3S_VERSION, profile["version"]) and
            match(SHA, profile["sha256"]) and match(SHA, profile["ca_sha256"]) and
            match(HOST, profile["node_name"]) and server.scheme == "https" and server.hostname and
            not (server.username or server.password or server.path or server.query or server.fragment),
            "INVALID_AGENT_PROFILE")
    if "node_ip" in profile:
        ipaddress.ip_address(profile["node_ip"])
    require("flannel_iface" not in profile or match(re.compile(r"[a-zA-Z0-9_.-]{1,15}"), profile["flannel_iface"]),
            "INVALID_FLANNEL_INTERFACE")
    if any(current[unit]["unit"] != "not-found" or current[unit]["activity"] != "inactive" or
           current[unit].get("binary_found", False) for unit in ("k3s", "k3s-agent")) or (
            current.get("k3s-ownership", {}).get("state", "clear") != "clear") or existing_k3s_paths():
        outcome = "OWNERSHIP_REVIEW"
    else:
        outcome = "PREPARE_DEDICATED_AGENT"
    payload = {"outcome": outcome, "profile": profile, "schema": "ghostfleet-k3s-plan/v1"}
    return {**payload, "plan_sha256": hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()}


def agent_token(data, ca_sha256):
    """Accept only native Agent bootstrap credentials, never shared static passwords.

    K3s static agent-token defaults to the server secret; even a node: prefix
    cannot establish separation. Native bootstrap tokens have a distinct parser
    and authentication path (docs.k3s.io/cli/token; pkg/clientaccess/token.go).
    """
    require(isinstance(data, bytes), "INVALID_AGENT_CREDENTIAL")
    try:
        token = data.decode("ascii").removesuffix("\n")
    except UnicodeDecodeError:
        raise NativeError("INVALID_AGENT_CREDENTIAL") from None
    parsed = re.fullmatch(r"K10([a-f0-9]{64})::([a-z0-9]{6}\.[a-z0-9]{16})", token)
    require(parsed is not None, "AGENT_BOOTSTRAP_CREDENTIAL_REQUIRED")
    require(parsed[1] == ca_sha256, "AGENT_CA_PIN_MISMATCH")
    return token


def apply_agent(profile, approval, artifact, token_file):
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    plan = agent_plan(profile, discover())
    require(plan["outcome"] == "PREPARE_DEDICATED_AGENT" and plan["plan_sha256"] == approval, "PLAN_CHANGED")
    token = agent_token(read(token_file, secret=True, limit=1024), profile["ca_sha256"])
    data = read(artifact, limit=128 * 1024 * 1024)
    require(hashlib.sha256(data).hexdigest() == profile["sha256"], "K3S_ARTIFACT_MISMATCH")
    config = {"server": profile["server"], "node-name": profile["node_name"],
              "token-file": str(AGENT_HOME / "token"), "data-dir": "/var/lib/ghostfleet-nextgen-k3s"}
    for option in ("node_ip", "flannel_iface"):
        if option in profile:
            config[option.replace("_", "-")] = profile[option]
    marker = json.dumps(plan, sort_keys=True).encode()
    if AGENT_HOME.exists():
        require(not AGENT_HOME.is_symlink() and read(AGENT_HOME / "plan.json") == marker and
                read(AGENT_HOME / "token", secret=True) == token.encode() and
                hashlib.sha256(read(AGENT_HOME / "k3s", limit=128 * 1024 * 1024)).hexdigest() == profile["sha256"] and
                json.loads(read(AGENT_HOME / "config.json")) == config, "EXISTING_ATTACHMENT_CONFLICT")
        return "ALREADY_PREPARED"
    AGENT_HOME.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    owner = AGENT_HOME.parent.lstat()
    require(stat.S_ISDIR(owner.st_mode) and owner.st_uid == 0 and not owner.st_mode & 0o022, "UNSAFE_AGENT_DIRECTORY")
    with tempfile.TemporaryDirectory(prefix=".agent-", dir=AGENT_HOME.parent) as temporary:
        stage = Path(temporary) / "agent"
        stage.mkdir(mode=0o700)
        (stage / "k3s").write_bytes(data)
        (stage / "k3s").chmod(0o700)
        version = command([str(stage / "k3s"), "--version"])
        require(version.returncode == 0 and version.stdout.decode().splitlines()[0].split()[2] == profile["version"],
                "K3S_VERSION_MISMATCH")
        token_path = stage / "token"
        with os.fdopen(os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as handle:
            handle.write(token.encode())
        (stage / "config.json").write_text(json.dumps(config, sort_keys=True))
        (stage / "plan.json").write_bytes(marker)
        # Directory rename commits the complete attachment. A systemd start is a separate owner operation.
        os.rename(stage, AGENT_HOME)
    return "PREPARED"


def publish(value, endpoint, credential):
    url = urlsplit(endpoint)
    require(url.scheme == "https" and url.hostname and endpoint == url.scheme + "://" + url.netloc and
            not url.username and not url.password, "INVALID_PANEL_ORIGIN")
    token = read(credential, secret=True, limit=4096).decode().strip()
    for observation in value["observations"]:
        result = request_json(endpoint + "/v2/nodes/" + value["node_uid"] + "/observation", token, observation)
        require(result.get("ok") is True and result.get("node_uid") == value["node_uid"], "OBSERVATION_REJECTED")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("discover")
    observe = commands.add_parser("observe")
    observe.add_argument("profile", type=Path)
    observe.add_argument("--panel-origin")
    observe.add_argument("--credential-file", type=Path)
    for action in ("plan-agent", "apply-agent"):
        agent = commands.add_parser(action)
        agent.add_argument("profile", type=Path)
        if action == "apply-agent":
            agent.add_argument("--approve-plan", required=True)
            agent.add_argument("--artifact", type=Path, required=True)
            agent.add_argument("--token-file", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == "discover":
            output = discover()
        else:
            profile = json.loads(read(args.profile))
            if args.action == "observe":
                output = observations(profile)
                require(bool(args.panel_origin) == bool(args.credential_file), "MISSING_OBSERVER_CONFIGURATION")
                if args.panel_origin:
                    publish(output, args.panel_origin, args.credential_file)
            elif args.action == "plan-agent":
                output = agent_plan(profile, discover())
            else:
                output = {"state": apply_agent(profile, args.approve_plan, args.artifact, args.token_file)}
        print(json.dumps(output, sort_keys=True))
    except (NativeError, OSError, ValueError, TypeError, IndexError, subprocess.TimeoutExpired) as error:
        print(str(error) if isinstance(error, NativeError) else "NATIVE_OPERATION_FAILED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
