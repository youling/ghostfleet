"""Fleet instance input boundary: deployment configuration selects one source.

This API is for deployment code, never MCP/model arguments. It does not grant
authority merely because a caller can name a file. The deployment owns its
environment and filesystem permissions. Legacy access is an explicit read-only
compatibility choice; it is never a fallback after an overlay fails validation.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

import yaml

from .registry_validator import FORBIDDEN_FIELDS, TOKEN_PATTERN, IP_PATTERN, HOSTNAME_PATTERN, validate_registry, validate_no_live_state_leak
from .registry_validator import FLEET_CANONICAL_NODE_FIELDS, MANAGEMENT_DERIVED_FIELDS, ASSET_OWNED_LEGACY_FIELDS, DEPRECATED_NON_CANONICAL_FIELDS

TRUSTED_OVERLAY_ENV = "FLEET_TRUSTED_INSTANCE_OVERLAY"
OVERLAY_REVISION_ENV = "FLEET_INSTANCE_OVERLAY_REVISION"
LEGACY_ALLOW_ENV = "FLEET_ALLOW_LEGACY_REGISTRY"
REVISION_PATTERN = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
FORBIDDEN_KEYS = FORBIDDEN_FIELDS | {"secrets", "credential", "credentials", "private_key"}
OVERLAY_NODE_FIELDS = FLEET_CANONICAL_NODE_FIELDS | MANAGEMENT_DERIVED_FIELDS | ASSET_OWNED_LEGACY_FIELDS | DEPRECATED_NON_CANONICAL_FIELDS


class TrustedOverlayError(ValueError):
    def __init__(self, code: str, detail: str = ""):
        self.code, self.detail = code, detail
        super().__init__(f"{code}: {detail}" if detail else code)


class UniqueLoader(yaml.SafeLoader):
    pass


def _unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, str) or key in result:
            raise TrustedOverlayError("TRUSTED_OVERLAY_INVALID", "mapping keys must be unique strings")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _unique_mapping)


def _secret_errors(value: Any) -> list[str]:
    # No input values are echoed in diagnostics (including malformed secrets).
    if isinstance(value, dict):
        errors = ["forbidden secret/live-state field" for key in value
                  if str(key).lower() in FORBIDDEN_KEYS or
                  re.search(r"(?:^|[_-])(?:secret|secrets|token|password|credential|credentials|privatekey|apikey)(?:$|[_-])", str(key), re.I)]
        return errors + [error for child in value.values() for error in _secret_errors(child)]
    if isinstance(value, list):
        return [error for child in value for error in _secret_errors(child)]
    if isinstance(value, str) and "PRIVATE KEY" in value and "BEGIN" in value:
        return ["private key material is forbidden"]
    return []


def validate_overlay_content(data: Any) -> list[str]:
    if not isinstance(data, dict):
        return ["overlay root must be a mapping"]
    errors = _secret_errors(data)
    if set(data) - {"schema_version", "fleet_contract", "last_migration", "nodes"}:
        errors.append("unknown overlay root field")
    if isinstance(data.get("nodes"), dict):
        for node in data["nodes"].values():
            if isinstance(node, dict) and set(node) - OVERLAY_NODE_FIELDS:
                errors.append("unknown overlay node field")
    for field in ("fleet_contract", "last_migration"):
        value = data.get(field)
        if value is not None and (not isinstance(value, str) or TOKEN_PATTERN.match(value) or IP_PATTERN.match(value) or (HOSTNAME_PATTERN.match(value) and not value.endswith(".md"))):
            errors.append("invalid registry metadata")
    # Validate the actual supplied schema version, never normalize it away.
    try:
        errors += validate_registry(data)
        errors += validate_no_live_state_leak(data)
    except (TypeError, AttributeError):
        errors.append("malformed registry field types")
    return errors


def parse_overlay(raw: bytes) -> dict:
    try:
        data = yaml.load(raw.decode("utf-8"), Loader=UniqueLoader)
        errors = validate_overlay_content(data)
    except (UnicodeError, yaml.YAMLError, RecursionError, TypeError, ValueError):
        raise TrustedOverlayError("TRUSTED_OVERLAY_INVALID", "invalid overlay syntax or fields") from None
    if errors:
        raise TrustedOverlayError("TRUSTED_OVERLAY_INVALID", "registry validation failed")
    return data


def _checked_path(path: Path) -> Path:
    path = Path(path)
    if not path.is_absolute() or path.is_symlink():
        raise TrustedOverlayError("TRUSTED_OVERLAY_UNTRUSTED", "requires an absolute regular file, not a symlink")
    if not path.is_file():
        raise TrustedOverlayError("TRUSTED_OVERLAY_MISSING")
    if os.name != "nt" and path.stat().st_mode & 0o022:
        raise TrustedOverlayError("TRUSTED_OVERLAY_UNTRUSTED", "group/world writable overlay")
    return path.resolve()


def get_trusted_overlay_path() -> Path:
    raw = os.environ.get(TRUSTED_OVERLAY_ENV)
    if not raw:
        raise TrustedOverlayError("TRUSTED_OVERLAY_MISSING", f"set {TRUSTED_OVERLAY_ENV} in deployment configuration")
    return _checked_path(Path(raw))


def load_overlay_from_path(path: Path) -> dict:
    """Explicit deployment/test reader. Runtime callers use load_instance_registry."""
    try:
        return parse_overlay(_checked_path(path).read_bytes())
    except OSError:
        raise TrustedOverlayError("TRUSTED_OVERLAY_UNAVAILABLE") from None


def git_bytes(repo: Path, *args: str) -> bytes:
    try:
        return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True).stdout
    except (OSError, subprocess.CalledProcessError):
        raise TrustedOverlayError("REVISION_UNAVAILABLE", "required Git object is unavailable") from None


def verify_commit(repo: Path, revision: str) -> str:
    if not isinstance(revision, str) or not REVISION_PATTERN.fullmatch(revision):
        raise TrustedOverlayError("REVISION_INVALID", "requires a full immutable Git commit ID")
    resolved = git_bytes(repo, "rev-parse", "--verify", f"{revision}^{{commit}}").decode().strip()
    if resolved != revision:
        raise TrustedOverlayError("REVISION_INVALID", "revision must name the commit itself")
    return revision


def versioned_file_bytes(path: Path, revision: str | None = None) -> tuple[bytes, str]:
    """Read pinned Git bytes; reject untracked/dirty bytes or invented IDs."""
    path = _checked_path(path)
    root = Path(git_bytes(path.parent, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    relative = path.relative_to(root).as_posix()
    if revision is None:
        revision = git_bytes(root, "rev-parse", "HEAD").decode().strip()
    verify_commit(root, revision)
    raw = git_bytes(root, "show", f"{revision}:{relative}")
    # Git may check out CRLF on Windows; compare using Git's clean conversion.
    current = git_bytes(root, "hash-object", f"--path={relative}", str(path)).decode().strip()
    pinned = git_bytes(root, "rev-parse", f"{revision}:{relative}").decode().strip()
    if current != pinned:
        raise TrustedOverlayError("OVERLAY_REVISION_MISMATCH", "overlay bytes differ from the pinned commit")
    return raw, revision


def versioned_overlay(path: Path, revision: str | None = None) -> tuple[dict, str]:
    raw, revision = versioned_file_bytes(path, revision)
    return parse_overlay(raw), revision


def load_overlay_revision(path: Path) -> str:
    return versioned_overlay(path)[1]


def is_legacy_allowed(explicit_flag: bool | None = None) -> bool:
    return explicit_flag is True or (explicit_flag is None and os.environ.get(LEGACY_ALLOW_ENV) == "1")


def load_legacy_registry_explicit(repo_root: Path, allow_legacy: bool | None = None) -> dict:
    if not is_legacy_allowed(allow_legacy):
        raise TrustedOverlayError("LEGACY_NOT_ALLOWED", "explicit compatibility selection required")
    if os.environ.get(TRUSTED_OVERLAY_ENV):
        raise TrustedOverlayError("INSTANCE_SOURCE_AMBIGUOUS", "select overlay or legacy, never both")
    return load_overlay_from_path(Path(repo_root).resolve() / "registry" / "nodes.yaml")


def load_trusted_overlay() -> dict:
    return versioned_overlay(get_trusted_overlay_path(), os.environ.get(OVERLAY_REVISION_ENV))[0]


def load_instance_registry(repo_root: Path, *, allow_legacy: bool | None = None) -> dict:
    """One deployment-selected authority. No tool/model selector is accepted."""
    if is_legacy_allowed(allow_legacy):
        return load_legacy_registry_explicit(repo_root, True)
    return load_trusted_overlay()
