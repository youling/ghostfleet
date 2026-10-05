"""Product code contributes rules, not nodes. Identity lives beside exact bytes."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

from .instance_overlay import (
    DIGEST_PATTERN, REVISION_PATTERN, TrustedOverlayError, parse_overlay,
    validate_overlay_content,
)


def canonical_bytes(data: dict) -> bytes:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def build_projection(overlay: dict) -> dict:
    if validate_overlay_content(overlay):
        raise TrustedOverlayError("PROJECTION_INVALID", "overlay failed canonical registry validation")
    return copy.deepcopy(overlay)


def compute_projection_digest(projection: dict) -> str:
    return "sha256:" + hashlib.sha256(canonical_bytes(build_projection(projection))).hexdigest()


def validate_projection_identity(identity: dict) -> list[str]:
    fields = {"schema_version", "product_source_revision", "instance_overlay_revision", "projection_digest"}
    if not isinstance(identity, dict) or set(identity) != fields:
        return ["invalid projection identity fields"]
    errors = []
    if identity["schema_version"] != "1.0.0":
        errors.append("invalid identity schema version")
    for field in ("product_source_revision", "instance_overlay_revision"):
        if not isinstance(identity[field], str) or not REVISION_PATTERN.fullmatch(identity[field]):
            errors.append("invalid commit ID")
    if not isinstance(identity["projection_digest"], str) or not DIGEST_PATTERN.fullmatch(identity["projection_digest"]):
        errors.append("invalid digest")
    return errors


def build_projection_with_identity(product_source_revision: str, instance_overlay_revision: str, overlay: dict) -> tuple[dict, dict, bytes]:
    """Pure renderer; deployment tooling verifies commit objects before calling."""
    projection = build_projection(overlay)
    raw = canonical_bytes(projection)
    identity = {
        "schema_version": "1.0.0", "product_source_revision": product_source_revision,
        "instance_overlay_revision": instance_overlay_revision,
        "projection_digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
    }
    if validate_projection_identity(identity):
        raise TrustedOverlayError("PROJECTION_IDENTITY_INVALID")
    return projection, identity, raw


def projection_bytes_for_identity(projection: dict, identity: dict) -> bytes:
    if validate_projection_identity(identity):
        raise TrustedOverlayError("PROJECTION_IDENTITY_INVALID")
    raw = canonical_bytes(build_projection(projection))
    if identity["projection_digest"] != "sha256:" + hashlib.sha256(raw).hexdigest():
        raise TrustedOverlayError("PROJECTION_DIGEST_MISMATCH")
    return raw


def identity_path(path: Path) -> Path:
    return path.with_name(path.name + ".identity.json")


def render_projection_file(projection: dict, identity: dict, output_path: Path) -> Path:
    raw = projection_bytes_for_identity(projection, identity)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(raw)
    identity_path(output_path).write_bytes(canonical_bytes(identity))
    return output_path


def load_projection_file(path: Path) -> tuple[dict, dict]:
    def unique_fields(pairs):
        result = dict(pairs)
        if len(result) != len(pairs):
            raise ValueError("duplicate identity field")
        return result
    try:
        raw = path.read_bytes()
        projection = parse_overlay(raw)
        identity = json.loads(identity_path(path).read_bytes(), object_pairs_hook=unique_fields)
    except (OSError, ValueError):
        raise TrustedOverlayError("PROJECTION_INVALID", "projection or identity cannot be read") from None
    if validate_projection_identity(identity):
        raise TrustedOverlayError("PROJECTION_IDENTITY_INVALID")
    if identity["projection_digest"] != "sha256:" + hashlib.sha256(raw).hexdigest():
        raise TrustedOverlayError("PROJECTION_DIGEST_MISMATCH")
    return projection, identity


def diff_projections(a: dict, b: dict) -> dict:
    a, b = build_projection(a), build_projection(b)
    left, right = a["nodes"], b["nodes"]
    shared = set(left) & set(right)
    return {
        "added": sorted(set(right) - set(left)), "removed": sorted(set(left) - set(right)),
        "changed": sorted(key for key in shared if left[key] != right[key]),
        "unchanged": sorted(key for key in shared if left[key] == right[key]),
        "metadata_changed": {key: a.get(key) != b.get(key) for key in sorted((set(a) | set(b)) - {"nodes"})},
        "a_node_count": len(left), "b_node_count": len(right),
    }


def projections_equivalent(a: dict, b: dict) -> bool:
    return canonical_bytes(build_projection(a)) == canonical_bytes(build_projection(b))
