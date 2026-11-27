#!/usr/bin/env python3
"""Compile a locked, additive GhostFleet configuration without contacting a target."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys

# The companion module belongs to the same reviewed compiler, even under -I.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from resource_claims import (
    DIGEST, IDENTIFIER, InvalidConfig, check_conflicts, desired_state, fields, form,
    normalize, path_aliases, require,
)


PLATFORMS = ("debian13-amd64", "wsl-debian13-amd64", "windows-amd64")
NODE_UID = re.compile(r"node-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
RELEASE = re.compile(r"(?:0|[1-9][0-9]{0,7})\.(?:0|[1-9][0-9]{0,7})\.(?:0|[1-9][0-9]{0,7})")
MAX_BYTES = 1024 * 1024
MAX_RESOURCES = 256
MATRIX = Path(__file__).resolve().with_name("resource-matrix.json")


def checksum(value):
    return hashlib.sha256(value).hexdigest()


def canonical_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False).encode("utf-8")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def reject_constant(_name):
    raise InvalidConfig("INVALID_JSON")


def read_json(path, digest=None):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as handle:
            meta = os.fstat(handle.fileno())
            require(stat.S_ISREG(meta.st_mode) and 0 < meta.st_size <= MAX_BYTES, "INVALID_INPUT_FILE")
            raw = handle.read(MAX_BYTES + 1)
    except OSError:
        raise InvalidConfig("INPUT_UNAVAILABLE") from None
    require(len(raw) <= MAX_BYTES, "INVALID_INPUT_FILE")
    actual = checksum(raw)
    require(digest is None or actual == digest, "LOCK_DIGEST_MISMATCH")
    try:
        decoded = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=reject_constant)
        # Reject escaped lone surrogates as well as invalid UTF-8 input bytes.
        canonical_bytes(decoded)
    except (UnicodeError, ValueError, RecursionError, OverflowError):
        raise InvalidConfig("INVALID_JSON") from None
    return decoded, actual


def reference(root, entry):
    fields(entry, ("path", "sha256"), code="INVALID_LOCK_REFERENCE")
    path = entry["path"]
    require(isinstance(path, str) and 0 < len(path) < 256 and "\\" not in path and
            not any(ord(char) < 32 for char in path) and form(DIGEST, entry["sha256"]), "INVALID_LOCK_REFERENCE")
    relative = PurePosixPath(path)
    require(relative.suffix == ".json" and not relative.is_absolute() and
            all(piece not in ("", ".", "..") for piece in path.split("/")), "INVALID_LOCK_REFERENCE")
    candidate = root.joinpath(*relative.parts)
    try:
        target = candidate.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        raise InvalidConfig("INPUT_UNAVAILABLE") from None
    require(target.is_relative_to(root) and candidate == target, "INVALID_LOCK_REFERENCE")
    return candidate


def provenance(doc, digest):
    return {"name": doc["name"], "version": doc["version"], "sha256": digest}


def load_layer(root, entry, expected_type, platform):
    path = reference(root, entry)
    document, actual = read_json(path, entry["sha256"])
    fields(document, ("schema", "type", "name", "version", "platforms", "resources"), code="INVALID_LAYER")
    supported = document["platforms"]
    require(document["schema"] == "ghostfleet-config-layer/v1" and document["type"] == expected_type and
            form(IDENTIFIER, document["name"]) and form(RELEASE, document["version"]) and
            isinstance(supported, list) and all(isinstance(item, str) and item in PLATFORMS for item in supported) and
            len(set(supported)) == len(supported) and platform in supported and
            (expected_type != "platform" or supported == [platform]) and
            isinstance(document["resources"], list) and len(document["resources"]) <= MAX_RESOURCES, "INVALID_LAYER")
    return document["resources"], provenance(document, actual)


def apply_override(root, entry, node_uid, platform, resources):
    path = reference(root, entry)
    document, actual = read_json(path, entry["sha256"])
    fields(document, ("schema", "name", "version", "target", "changes"), code="INVALID_OVERRIDE")
    require(document["schema"] == "ghostfleet-config-override/v1" and
            form(IDENTIFIER, document["name"]) and form(RELEASE, document["version"]) and
            document["target"] == {"node_uid": node_uid, "platform": platform} and
            isinstance(document["changes"], list) and len(document["changes"]) <= MAX_RESOURCES,
            "INVALID_OVERRIDE")
    seen = set()
    for entry in document["changes"]:
        fields(entry, ("id", "desired"), code="INVALID_OVERRIDE")
        key, patch = entry["id"], entry["desired"]
        require(form(IDENTIFIER, key) and key not in seen and key in resources and
                resources[key]["mode"] == "manage" and isinstance(patch, dict) and bool(patch),
                "INVALID_OVERRIDE")
        resource = resources[key]
        resource["desired"] = desired_state(resource["kind"], {**resource["desired"], **patch})
        seen.add(key)
    return provenance(document, actual)


def compile_target(lock_path, node_uid, platform, expected_sha256=None):
    require(form(NODE_UID, node_uid) and isinstance(platform, str) and platform in PLATFORMS, "INVALID_TARGET")
    require(expected_sha256 is None or form(DIGEST, expected_sha256), "INVALID_EXPECTED_DIGEST")
    path = Path(lock_path)
    # Resolve the parent separately so a lock-file symlink stays visible to open().
    try:
        root = path.parent.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        raise InvalidConfig("INPUT_UNAVAILABLE") from None
    lock, locked_sha = read_json(root / path.name)
    fields(lock, ("schema", "version", "matrix_sha256", "baseline", "platforms"), ("overrides",), "INVALID_LOCK")
    require(lock["schema"] == "ghostfleet-project-lock/v1" and form(RELEASE, lock["version"]) and
            form(DIGEST, lock["matrix_sha256"]) and isinstance(lock["platforms"], dict) and
            set(lock["platforms"]) <= set(PLATFORMS) and platform in lock["platforms"], "INVALID_LOCK")
    spec = lock["platforms"][platform]
    fields(spec, ("profile", "layers"), ("path_aliases",), "INVALID_LOCK")
    require(isinstance(spec["layers"], list) and len(spec["layers"]) <= 32, "INVALID_LOCK")
    overrides = lock.get("overrides", {})
    require(isinstance(overrides, dict) and all(form(NODE_UID, key) for key in overrides), "INVALID_LOCK")

    matrix, matrix_sha = read_json(MATRIX, lock["matrix_sha256"])
    require(matrix["schema"] == "ghostfleet-resource-matrix/v1", "INVALID_MATRIX")
    aliases = path_aliases(spec.get("path_aliases", []), platform)
    resources = {}
    names = set()
    inputs = {
        "lock": {"version": lock["version"], "sha256": locked_sha},
        "matrix": {"version": matrix["version"], "sha256": matrix_sha},
        "layers": [],
    }

    def add_layer(entry, layer_type):
        entries, meta = load_layer(root, entry, layer_type, platform)
        require(meta["name"] not in names and len(resources) + len(entries) <= MAX_RESOURCES, "DUPLICATE_OR_EXCESS_LAYER")
        names.add(meta["name"])
        for entry in entries:
            resource = normalize(entry, platform, aliases, matrix)
            require(resource["id"] not in resources, "DUPLICATE_RESOURCE_ID")
            resources[resource["id"]] = resource
        return meta

    inputs["baseline"] = add_layer(lock["baseline"], "baseline")
    inputs["platform"] = add_layer(spec["profile"], "platform")
    for entry in spec["layers"]:
        inputs["layers"].append(add_layer(entry, "capability"))
    if node_uid in overrides:
        inputs["override"] = apply_override(root, overrides[node_uid], node_uid, platform, resources)

    ordered = [resources[key] for key in sorted(resources)]
    check_conflicts(ordered, platform, matrix)
    projection = {
        "schema": "ghostfleet-target/v1",
        "target": {"node_uid": node_uid, "platform": platform},
        "controller": {"policy": "exclusive", "lock_key": "ghostfleet-config:" + node_uid},
        "inputs": inputs,
        "resources": ordered,
    }
    digest = checksum(canonical_bytes(projection))
    require(expected_sha256 is None or digest == expected_sha256, "PROJECTION_DIGEST_MISMATCH")
    return {**projection, "projection_sha256": digest}


class Options(argparse.ArgumentParser):
    def error(self, _message):
        raise InvalidConfig("INVALID_ARGUMENTS")


def main():
    parser = Options(description=__doc__)
    parser.add_argument("--lock", type=Path, required=True)
    parser.add_argument("--node-uid", required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--expected-sha256")
    try:
        args = parser.parse_args()
        projection = compile_target(args.lock, args.node_uid, args.platform, args.expected_sha256)
    except InvalidConfig as error:
        print(str(error), file=sys.stderr)
        return 2
    sys.stdout.buffer.write(canonical_bytes(projection) + b"\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
