"""Normalize configuration claims and reject ambiguous resource ownership."""

import ipaddress
import itertools
import ntpath
import posixpath
import re


KINDS = frozenset(("package", "package-db", "path", "unit", "port", "route", "credential", "store", "lifecycle"))
SCOPES = frozenset(("host", "wsl", "windows", "k3s", "oci", "tailnet", "cloudflare"))
IDENTIFIER = re.compile(r"[a-z][a-z0-9._-]{0,63}")
PACKAGE = re.compile(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?")
UNIT_TYPES = ("service", "socket", "timer", "target", "mount", "path", "slice", "scope")
SYSTEMD_UNIT = re.compile(r"[A-Za-z0-9:@_.-]+\.(?:" + "|".join(UNIT_TYPES) + ")")
VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,127}")
DIGEST = re.compile(r"[a-f0-9]{64}")
STATES = {
    "package": {"present", "absent"},
    "package-db": {"managed"},
    "path": {"present", "absent", "file", "directory"},
    "unit": {"active", "inactive", "present", "absent", "masked"},
    "port": {"reserved"},
    "route": {"present", "absent"},
    "credential": {"retained", "provisioned", "revoked"},
    "store": {"retained", "present", "absent"},
    "lifecycle": {"external", "retained", "running", "stopped", "present", "absent"},
}
OPTIONAL_DESIRED = {
    "package": {"version"}, "path": {"mode", "sha256"}, "unit": {"enabled"},
    "credential": {"reference"}, "lifecycle": {"version"},
}
APT_ROOTS = ("/var/lib/dpkg", "/var/lib/apt", "/var/cache/apt")
UNIT_ROOTS = (
    "/etc/systemd/system", "/etc/systemd/system.control", "/etc/systemd/system.attached",
    "/run/systemd/system", "/run/systemd/system.control", "/run/systemd/system.attached", "/run/systemd/transient",
    "/run/systemd/generator.early", "/run/systemd/generator", "/run/systemd/generator.late",
    "/usr/local/lib/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system",
)
BAD_WINDOWS_PART = re.compile(r"(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?|.*~[0-9]+(?:\..*)?")


class InvalidConfig(Exception):
    """An error safe to report without including a private input value."""


def require(condition, code):
    if not condition:
        raise InvalidConfig(code)


def form(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def fields(value, required, optional=(), code="INVALID_SCHEMA"):
    require(isinstance(value, dict) and set(required) <= value.keys() <= set(required) | set(optional), code)


def domain(scope, platform):
    if scope != "host":
        return scope
    if platform.startswith("wsl-"):
        return "wsl"
    if platform.startswith("windows-"):
        return "windows"
    return "host"


def is_under(path, root):
    return path == root or path.startswith(root.rstrip("/") + "/")


def paths_overlap(first, second):
    return is_under(first, second) or is_under(second, first)


def canonical_path(value, scope, platform):
    require(isinstance(value, str) and 0 < len(value) <= 1024 and
            not any(ord(char) < 32 or ord(char) == 127 for char in value), "INVALID_PATH")
    if domain(scope, platform) == "windows":
        drive, path = ntpath.splitdrive(value.replace("/", "\\"))
        require(form(re.compile(r"[A-Za-z]:"), drive) and path.startswith("\\"), "INVALID_PATH")
        pieces = ntpath.normpath(drive + path).replace("\\", "/").casefold().split("/")
        require(all(not piece.endswith((".", " ")) and not BAD_WINDOWS_PART.fullmatch(piece) and
                    not any(char in '<>:"|?*' for char in piece) for piece in pieces[1:]), "INVALID_PATH")
        return "/".join(pieces)
    require(value.startswith("/") and "\\" not in value, "INVALID_PATH")
    return posixpath.normpath("/" + value.lstrip("/"))


def path_aliases(records, platform):
    require(isinstance(records, list) and len(records) <= 64, "INVALID_PATH_ALIAS")
    result = []
    for entry in records:
        fields(entry, ("from", "to"), code="INVALID_PATH_ALIAS")
        pair = []
        for end in (entry["from"], entry["to"]):
            fields(end, ("scope", "path"), code="INVALID_PATH_ALIAS")
            require(isinstance(end["scope"], str) and end["scope"] in SCOPES, "INVALID_PATH_ALIAS")
            pair.append((end["scope"], canonical_path(end["path"], end["scope"], platform)))
        result.append(tuple(pair))
    sources = [source for source, _ in result]
    for left, right in itertools.combinations(sources, 2):
        require(domain(left[0], platform) != domain(right[0], platform) or
                not paths_overlap(left[1], right[1]), "OVERLAPPING_PATH_ALIAS")
    for _, (scope, target) in result:
        require(not any(domain(scope, platform) == domain(origin, platform) and paths_overlap(target, prefix)
                        for origin, prefix in sources), "OVERLAPPING_PATH_ALIAS")
    return tuple(result)


def resolve_path(value, scope, platform, aliases):
    path = canonical_path(value, scope, platform)
    for (before_scope, before), (after_scope, after) in aliases:
        if domain(scope, platform) == domain(before_scope, platform) and is_under(path, before):
            suffix = path[len(before.rstrip("/")):].lstrip("/")
            return after_scope, canonical_path(after.rstrip("/") + "/" + suffix, after_scope, platform)
    return scope, path


def network(value):
    require(isinstance(value, str) and len(value) < 70 and "%" not in value, "INVALID_ROUTE")
    try:
        result = ipaddress.ip_network(value, strict=False)
    except ValueError:
        raise InvalidConfig("INVALID_ROUTE") from None
    mapped = ipaddress.ip_network("::ffff:0:0/96")
    if result.version == 6 and result.subnet_of(mapped):
        return ipaddress.ip_network((result.network_address.ipv4_mapped, result.prefixlen - 96))
    return result


def port(value):
    require(isinstance(value, str) and len(value) < 80, "INVALID_PORT")
    parts = value.lower().split("/")
    require(len(parts) in (2, 3) and parts[0] in ("tcp", "udp", "sctp"), "INVALID_PORT")
    address = parts[1] if len(parts) == 3 else "*"
    if address.startswith("[") and address.endswith("]"):
        address = address[1:-1]
    require("%" not in address, "INVALID_PORT")
    if address == "*":
        address = None
    else:
        try:
            address = ipaddress.ip_address(address)
        except ValueError:
            raise InvalidConfig("INVALID_PORT") from None
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
    range_pattern = re.compile(r"([0-9]{1,5})(?:-([0-9]{1,5}))?")
    match = range_pattern.fullmatch(parts[-1])
    require(match is not None, "INVALID_PORT")
    begin = int(match[1])
    end = int(match[2] or match[1])
    require(1 <= begin <= end <= 65535, "INVALID_PORT")
    return parts[0], address, begin, end


def port_key(binding):
    protocol, address, begin, end = binding
    address = str(address) if address is not None else "*"
    bounds = str(begin) if begin == end else f"{begin}-{end}"
    return f"{protocol}/{address}/{bounds}"


def address_overlap(left, right):
    if left is None or right is None or str(left) == "::" or str(right) == "::":
        return True
    return left.version == right.version and (left == right or left.is_unspecified or right.is_unspecified)


def port_overlap(left, right):
    lproto, laddr, low, high = left
    rproto, raddr, start, end = right
    return lproto == rproto and low <= end and start <= high and address_overlap(laddr, raddr)


def desired_state(kind, desired):
    fields(desired, ("state",), OPTIONAL_DESIRED.get(kind, ()), code="INVALID_DESIRED_STATE")
    require(isinstance(desired["state"], str) and desired["state"] in STATES[kind], "INVALID_DESIRED_STATE")
    if "version" in desired:
        require(form(VERSION, desired["version"]) and desired["state"] != "absent", "INVALID_DESIRED_STATE")
    if "mode" in desired:
        require(form(re.compile(r"0[0-7]{3}"), desired["mode"]) and desired["state"] != "absent", "INVALID_DESIRED_STATE")
    if "enabled" in desired:
        require(isinstance(desired["enabled"], bool), "INVALID_DESIRED_STATE")
    if "sha256" in desired:
        require(form(DIGEST, desired["sha256"]) and desired["state"] == "file", "INVALID_DESIRED_STATE")
    if "reference" in desired:
        require(form(IDENTIFIER, desired["reference"]), "INVALID_DESIRED_STATE")
    return dict(desired)


def file_key(key):
    return isinstance(key, str) and (key.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", key) is not None)


def normalize_key(kind, scope, key, platform, aliases):
    if kind == "path" or (kind in ("store", "credential") and file_key(key)):
        return resolve_path(key, scope, platform, aliases)
    if kind == "port":
        return scope, port_key(port(key))
    if kind == "route":
        return scope, str(network(key))
    if kind == "package-db":
        require(isinstance(key, str) and key in ("apt", "dpkg", "apt/dpkg", "isolated-apt"), "INVALID_RESOURCE_KEY")
        return scope, "isolated-apt" if key == "isolated-apt" else "apt/dpkg"
    if kind == "package":
        require(form(PACKAGE, key), "INVALID_RESOURCE_KEY")
        # Without observed multi-arch context, a qualified and unqualified claim share a package.
        return scope, key
    if kind == "unit" and domain(scope, platform) != "windows":
        require(form(SYSTEMD_UNIT, key), "INVALID_RESOURCE_KEY")
        return scope, key
    require(isinstance(key, str) and len(key) <= 128 and
            all(form(IDENTIFIER, component) for component in key.lower().split(":")), "INVALID_RESOURCE_KEY")
    return scope, key.lower()


def normalize(spec, platform, aliases, matrix):
    fields(spec, ("id", "kind", "scope", "key", "owner", "mode", "consumers", "recovery"), ("desired",),
           code="INVALID_RESOURCE")
    kind, scope, owner, mode = (spec[name] for name in ("kind", "scope", "owner", "mode"))
    require(form(IDENTIFIER, spec["id"]) and isinstance(kind, str) and kind in KINDS and
            isinstance(scope, str) and scope in SCOPES and isinstance(owner, str) and owner in matrix["owners"] and
            mode in ("manage", "observe") and form(IDENTIFIER, spec["recovery"]), "INVALID_RESOURCE")
    consumers = spec["consumers"]
    require(isinstance(consumers, list) and 0 < len(consumers) <= 32 and
            all(form(IDENTIFIER, item) for item in consumers) and len(set(consumers)) == len(consumers),
            "INVALID_RESOURCE")
    if mode == "manage" and (kind == "path" or (kind in ("store", "credential") and file_key(spec["key"]))):
        name = canonical_path(spec["key"], scope, platform)
        require(not any(domain(origin, platform) == domain(scope, platform) and name != prefix and
                        is_under(prefix, name) for (origin, prefix), _ in aliases), "PATH_COVERS_MOUNT")
    scope, key = normalize_key(kind, scope, spec["key"], platform, aliases)
    if (mode == "manage" and domain(scope, platform) in ("host", "wsl") and
            kind in ("path", "store", "credential") and file_key(key)):
        require(not any(paths_overlap(key, root) for root in APT_ROOTS), "PACKAGE_STATE_REQUIRES_NATIVE_OWNER")
    policy = matrix["owners"][owner]
    if mode == "manage" and kind == "package" and "packages" in policy:
        require(key.partition(":")[0] in policy["packages"], "RESOURCE_OWNER_MISMATCH")
    require(not (mode == "manage" and owner == "ansible" and domain(scope, platform) == "windows"),
            "RESOURCE_OWNER_MISMATCH")
    require(kind in policy["kinds"] and scope in policy["scopes"], "RESOURCE_OWNER_MISMATCH")
    require(("desired" in spec) == (mode == "manage"), "INVALID_DESIRED_STATE")
    result = {**spec, "scope": scope, "key": key, "consumers": sorted(consumers)}
    if mode == "manage":
        require(not (file_key(key) and (key == "/" or re.fullmatch(r"[a-z]:/", key))), "INVALID_PATH")
        result["desired"] = desired_state(kind, spec["desired"])
    return result


def claims(resource, platform):
    kind, key, scope, owner = (resource[part] for part in ("kind", "key", "scope", "owner"))
    location = domain(scope, platform)
    if kind == "port":
        return (("port", "host-network", port(key)),)
    if kind == "route":
        return (("route", "host-network", network(key)),)
    result = [(kind, location, key.partition(":")[0] if kind == "package" else key)]
    if kind in ("credential", "store") and file_key(key):
        result.append(("path", location, key))
    if kind == "unit" and location != "windows":
        for root in UNIT_ROOTS:
            result.extend((("path", location, root + "/" + key), ("path", location, root + "/" + key + ".d")))
    system_package = kind == "package" and location in ("host", "wsl") and owner != "ghostfleet"
    if system_package:
        result.append(("package-db", location, "apt/dpkg"))
    if system_package or (kind == "package-db" and key == "apt/dpkg"):
        result.extend(("path", location, path) for path in APT_ROOTS)
    return tuple(result)


def overlaps(left, right):
    kind, scope, key = left
    if (kind, scope) != right[:2]:
        return False
    other = right[2]
    if kind == "path":
        return paths_overlap(key, other)
    if kind == "port":
        return port_overlap(key, other)
    if kind == "route":
        return key.version == other.version and key.overlaps(other)
    return key == other


def unit_entry_overlaps(entry, rule):
    is_dropin = entry.endswith(".d")
    name = entry.removesuffix(".d")
    prefix = rule.get("prefix")
    protected = rule["key"]
    if is_dropin and name in UNIT_TYPES:
        return prefix or protected.endswith("." + name)
    if not SYSTEMD_UNIT.fullmatch(name):
        return False
    direct = name.startswith(protected) if prefix else name == protected
    if direct:
        return True

    # Templates can supply unit files, while dash-prefix directories provide inherited drop-ins.
    stem, suffix = name.rsplit(".", 1)
    if not (stem.endswith("@") or (is_dropin and stem.endswith("-"))):
        return False
    if prefix:
        return protected.startswith(stem)
    return protected.startswith(stem) and protected.endswith("." + suffix)


def unit_path_overlaps(path, rule):
    for root in UNIT_ROOTS:
        if is_under(root, path):
            return True
        if is_under(path, root):
            entry = path[len(root) + 1:].split("/", 1)[0]
            if unit_entry_overlaps(entry, rule):
                return True
    return False


def protected_claims(resource, platform, policy):
    owned_claims = claims(resource, platform)
    for rule in policy["protected"]:
        if domain(resource["scope"], platform) not in rule["domains"] or resource["owner"] in rule["owners"]:
            continue
        if rule["kind"] == "unit" and domain(resource["scope"], platform) != "windows":
            require(not any(kind == "path" and unit_path_overlaps(key, rule) for kind, _, key in owned_claims),
                    "PROTECTED_RESOURCE")
        for kind, _, key in owned_claims:
            if kind != rule["kind"]:
                continue
            if kind == "path":
                require(not paths_overlap(key, rule["key"]), "PROTECTED_RESOURCE")
            elif rule.get("prefix"):
                require(not key.startswith(rule["key"]), "PROTECTED_RESOURCE")
            else:
                require(key != rule["key"], "PROTECTED_RESOURCE")


def check_unit_writers(active, platform, rules):
    selected = {}
    for resource in active:
        state = resource["desired"]
        if (resource["kind"], resource["key"], state["state"]) == ("lifecycle", "ghostfleet:installer", "present"):
            unit = "ghostfleet-nextgen-report.timer"
        elif resource["kind"] == "unit" and (state["state"] == "active" or state.get("enabled") is True or
                (state["state"] == "present" and "enabled" not in state)):
            unit = resource["key"]
        else:
            continue
        location = domain(resource["scope"], platform)
        for rule in rules:
            if location not in rule["domains"]:
                continue
            for family, units in rule["families"].items():
                if unit in units:
                    slot = (rule["id"], location)
                    require(selected.setdefault(slot, family) == family, "EXCLUSIVE_RUNTIME_WRITER")


def check_conflicts(resources, platform, matrix):
    active = [resource for resource in resources if resource["mode"] == "manage"]
    check_unit_writers(active, platform, matrix["exclusive_units"])
    indexed = []
    for resource in active:
        protected_claims(resource, platform, matrix)
        indexed.append((resource, claims(resource, platform)))
    for (left, left_claims), (right, right_claims) in itertools.combinations(indexed, 2):
        same_owner = left["owner"] == right["owner"]
        require((left_claims[0] != right_claims[0]), "DUPLICATE_RESOURCE_WRITER")
        for a, b in itertools.product(left_claims, right_claims):
            if not overlaps(a, b):
                continue
            kind = a[0]
            if not same_owner or kind == "port":
                require(False, "PACKAGE_MANAGER_CONFLICT" if kind == "package-db" else "RESOURCE_OVERLAP")
            if kind == left["kind"] == right["kind"] == "path":
                parent = left if is_under(b[2], a[2]) else right
                require(parent["desired"]["state"] not in ("absent", "file"), "RESOURCE_OVERLAP")
