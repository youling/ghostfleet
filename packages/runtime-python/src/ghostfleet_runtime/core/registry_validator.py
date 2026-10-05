"""Fleet registry schema validator for nodes.yaml.

Validates Fleet schema (1.2.0) with deterministic rules.
No external dependencies beyond stdlib + pyyaml.

Schema 1.1.0 (Fleet Identity v2, ADR-001 / legacy mechanism contract):
- every node carries an immutable unique ``node_uid = node-<uuidv4>``
  (Fleet primary identity, minted once, never provider-derived);
- ``node_id`` remains the canonical human-readable natural key;
- ``aliases`` are historical compatibility names;
- node_id / alias / node_uid namespaces are globally collision-checked
  (fail closed).

Schema 1.2.0 (legacy mechanism contract FO2B3 / ARCHITECT_FO2B3_TAILSCALE_SSH_PRIMARY):
- adds ONE optional management-domain field ``management_provider_refs``,
  a map of explicitly allowlisted provider-scoped correlation refs bound
  to the exact node_uid; current keys are tailscale and cloudflare;
- ``node_uid`` remains immutable Fleet identity; the provider ref is a
  rotatable/rebindable management correlation only (not a second identity);
- the value must be a bounded, non-empty opaque string that fails the
  current IP/FQDN/token/secret scans (it is NOT a hostname/MagicDNS/IP/node
  name);
- absence is legal for nodes not yet bound; unknown provider keys are
  rejected. Cloudflare stores the non-secret exact remotely-managed Tunnel UUID.
"""

import re
from typing import Any

VALID_LIFECYCLE_STATES = {
    "DISCOVERED", "REGISTERED", "ENROLLED", "VERIFIED", "MANAGED",
    "DEGRADED", "RETIRED",
}

# Canonical registry schema version (FO2B3 / legacy mechanism contract).
SCHEMA_VERSION = "1.2.0"

# Provider keys recognized under management_provider_refs. Unknown keys fail
# closed. Provider refs are management correlations, never node identity.
KNOWN_PROVIDER_REFS = {"tailscale", "cloudflare"}

# Bound on the opaque provider ref length. It must be a bounded non-empty
# opaque string; the upper cap reduces accidental secret/topology sprawl.
PROVIDER_REF_MIN_LENGTH = 1
PROVIDER_REF_MAX_LENGTH = 128

# Legacy asset-domain values — compatibility validation only; asset_status
# is an optional field, never canonical Fleet schema truth.
VALID_ASSET_STATUSES = {"active", "retired", "unknown"}

VALID_NODE_TYPES = {
    "workstation", "secondary-workstation", "mobile-workstation",
    "server", "vps", "execution-node", "laptop", "phone", "tablet",
}

# Canonical profiles defined in fleet/00_shared/profiles/. A registry ref must resolve
# to one of these (Single Canonical Owner + Pointer/Adapter model); dangling
# refs like historical "tailscale-primary"/"ansible-linux" are not allowed.
# Keep in sync with fleet/00_shared/profiles/*.yaml — verified by ref-resolution tests.
KNOWN_PROFILES = {"managed-linux", "managed-windows", "workstation", "phone", "android-edge"}

# Fields that MUST NOT appear in registry (live-state / secret forbidden)
FORBIDDEN_FIELDS = {
    "ip", "ipv4", "ipv6", "hostname", "fqdn",
    "heartbeat", "last_seen", "timestamp", "load", "temperature",
    "session", "token", "key", "secret", "password",
    "api_key", "auth_token", "tailscale_key",
}

# --- Registry truth-boundary guardrails v1 (legacy mechanism contract) ---
# Non-destructive classification: presence is compatibility debt, never
# authority. ``validate_registry()`` still accepts 1.2.0 legacy fields (no
# hard break this round); ``audit_registry_deprecation()`` surfaces them as
# deterministic warnings. ``validate_next_strict()`` (and legacy alias
# ``validate_proposed_12_strict``) previews the future allowlist but is NOT
# enforced by ``validate_registry`` in v1. Exact OS/arch/virtualization
# normalization is deferred to the separate next-strict adjudication after
# this guardrail round. FO2B3's 1.2.0 schema owns ``management_provider_refs``;
# guardrails must not claim 1.2 for purge — use NEXT_STRICT.

# Fleet-domain truth/pointer; may be optional but belongs in Fleet.
# FO2B3: ``management_provider_refs`` is Fleet-owned management correlation
# (node_uid remains sole immutable identity; provider ref is rotatable
# secondary correlation, never a second identity).
FLEET_CANONICAL_NODE_FIELDS = frozenset({
    "type", "fleet_state", "node_uid", "aliases", "asset_ref",
    "management_profile", "recovery_profile", "roles", "capabilities",
    "management_provider_refs",
})

# Management-purpose platform facts. Retained only with explicit management
# semantics/provenance; must never become copied Asset inventory values.
# Final normalized shape is deferred to the next-strict adjudication.
MANAGEMENT_DERIVED_FIELDS = frozenset({
    "os", "arch", "virtualization",
})

# Asset-owned compatibility debt. Canonical values live in the external asset owner;
# Fleet copies are migration provenance only — never authority, never
# refreshed, never a lifecycle gate, never an authorization input.
ASSET_OWNED_LEGACY_FIELDS = frozenset({
    "asset_status", "model", "region",
    "cpu", "cpu_cores", "gpu",
    "ram_gb", "ram_type",
    "storage_gb", "storage_model", "storage_type",
    "motherboard", "display", "wifi",
    "ethernet_gbps", "machine_type", "submodel",
})

# Non-canonical Fleet fields adjudicated for deprecation in this round:
# - ``agents``: concrete Agent product/runtime lists are not Fleet canonical
#   truth (Agent/execution placement belongs to ai-hub/control-plane).
# - ``automation_profile``: legacy duplicate selector; ``management_profile``
#   + Fleet eligibility rules remain the canonical authority.
DEPRECATED_NON_CANONICAL_FIELDS = frozenset({
    "agents", "automation_profile",
})

FIELD_CLASS_FLEET_CANONICAL = "FLEET_CANONICAL"
FIELD_CLASS_MANAGEMENT_DERIVED = "MANAGEMENT_DERIVED"
FIELD_CLASS_ASSET_OWNED_LEGACY = "ASSET_OWNED_LEGACY"
FIELD_CLASS_DEPRECATED_NON_CANONICAL = "DEPRECATED_NON_CANONICAL"
FIELD_CLASS_UNKNOWN = "UNKNOWN"

# asset_ref: canonical pointer to the the external asset owner asset identity.
# Non-null values must match asset-<uuidv4> exactly (v4 variant/version bits);
# null and absent are legal in v1. No asset_ref_status in v1.
ASSET_REF_PATTERN = re.compile(
    r"^asset-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z"
)

# node_uid: immutable Fleet primary identity (ADR-001). Must be a freshly
# minted random UUIDv4 with the `node-` prefix — never derived from provider,
# Tailscale, Cloudflare or asset identifiers, and never reused after retire.
NODE_UID_PATTERN = re.compile(
    r"^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z"
)

# Regex: reject values that look like IPs, hostnames with dots, tokens
IP_PATTERN = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$")
HOSTNAME_PATTERN = re.compile(r"^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$")
TOKEN_PATTERN = re.compile(r"^(tskey|ghp|gho|sk-|key-|token-)", re.IGNORECASE)
CLOUDFLARE_TUNNEL_ID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")


class RegistryValidationError(Exception):
    """Raised when registry validation fails."""

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__(f"Registry validation failed: {len(errors)} error(s)")


def validate_schema_version(data: dict) -> list[str]:
    """Validate top-level schema version."""
    errors = []
    sv = data.get("schema_version")
    if sv != SCHEMA_VERSION:
        errors.append(f"schema_version must be '{SCHEMA_VERSION}', got {sv!r}")
    return errors


def _validate_provider_refs(node_id: str, node: dict) -> list[str]:
    """Validate the optional ``management_provider_refs`` map (schema 1.2.0).

    Rules:
    - only explicitly allowlisted provider keys are accepted;
    - cloudflare must be an exact non-secret Tunnel UUIDv4;
    - values must be bounded non-empty provider correlation strings;
    - it must fail the current IP/FQDN/token/secret value scans (reused below);
    - a provider ref bound to ``node_uid`` must NOT change ``node_uid``.
    Node identity remains the immutable root; the provider ref is a rotatable
    management correlation only.
    """
    errors: list[str] = []
    refs = node.get("management_provider_refs")
    if refs is None:
        return errors
    if not isinstance(refs, dict):
        errors.append(f"Node {node_id}: 'management_provider_refs' must be a mapping")
        return errors

    for provider, value in refs.items():
        if provider not in KNOWN_PROVIDER_REFS:
            errors.append(
                f"Node {node_id}: unknown management_provider_refs key "
                f"{provider!r}; v1.2.0 recognizes only {sorted(KNOWN_PROVIDER_REFS)}"
            )
            continue
        if not isinstance(value, str):
            errors.append(
                f"Node {node_id}: management_provider_refs.{provider} must be a string"
            )
            continue
        if not value.strip():
            errors.append(
                f"Node {node_id}: management_provider_refs.{provider} must be a "
                "non-empty opaque string"
            )
            continue
        if provider == "cloudflare" and not CLOUDFLARE_TUNNEL_ID_PATTERN.match(value):
            errors.append(
                f"Node {node_id}: management_provider_refs.cloudflare must be a UUIDv4 Tunnel id"
            )
            continue
        if not (PROVIDER_REF_MIN_LENGTH <= len(value) <= PROVIDER_REF_MAX_LENGTH):
            errors.append(
                f"Node {node_id}: management_provider_refs.{provider} length "
                f"must be within [{PROVIDER_REF_MIN_LENGTH}, "
                f"{PROVIDER_REF_MAX_LENGTH}]"
            )
            continue
        # The provider ref is a correlation reference, NOT a hostname/IP/MagicDNS
        # /token/secret. Reuse the forbidden-value scan to keep it opaque and
        # topology-free (no dots that look like FQDN, no IP, no token prefixes).
        sub_errors: list[str] = []
        _check_forbidden_values(node_id, value, sub_errors, f".management_provider_refs.{provider}")
        if sub_errors:
            errors.extend(sub_errors)
    return errors


def validate_node(node_id: str, node: dict) -> list[str]:
    """Validate a single node entry."""
    errors = []

    if not isinstance(node, dict):
        return [f"Node {node_id}: must be a mapping"]

    # Required fields — Fleet management-domain truth only. Asset-domain
    # fields (see asset_status below) must never be required here.
    # node_uid is required since schema 1.1.0 (Fleet Identity v2, ADR-001):
    # immutable, unique, provider-neutral primary identity.
    for field in ("type", "fleet_state", "node_uid"):
        if field not in node:
            errors.append(f"Node {node_id}: missing required field '{field}'")

    # node_uid format: node-<uuidv4> exactly (fresh random v4; version and
    # variant bits enforced, same strictness as asset_ref).
    node_uid = node.get("node_uid")
    if node_uid is not None:
        if not isinstance(node_uid, str):
            errors.append(f"Node {node_id}: 'node_uid' must be a string")
        elif not NODE_UID_PATTERN.match(node_uid):
            errors.append(
                f"Node {node_id}: invalid node_uid '{node_uid}' "
                "(must match node-<uuidv4>)"
            )

    # Type validation
    node_type = node.get("type")
    if node_type and node_type not in VALID_NODE_TYPES:
        errors.append(f"Node {node_id}: invalid type '{node_type}'")

    # Legacy compatibility: 'asset_status' is an asset-domain field kept only
    # as migration provenance / compatibility debt per the contracts/FLEET.md
    # mixed-field rule. It is NOT canonical Fleet schema truth and must never
    # be required; absent/null is valid for pure management nodes. When
    # present, its value is still validated so legacy records stay
    # well-formed.
    asset_status = node.get("asset_status")
    if asset_status is not None and asset_status not in VALID_ASSET_STATUSES:
        errors.append(f"Node {node_id}: invalid asset_status '{asset_status}'")

    # Fleet state: schema validity only. Every lifecycle state defined by
    # contracts/FLEET.md is a valid schema value; migration-time or
    # evidence-transition restrictions live in validate_lifecycle_evidence().
    fleet_state = node.get("fleet_state")
    if fleet_state and fleet_state not in VALID_LIFECYCLE_STATES:
        errors.append(f"Node {node_id}: invalid fleet_state '{fleet_state}'")

    # Aliases must be a list
    aliases = node.get("aliases")
    if aliases is not None and not isinstance(aliases, list):
        errors.append(f"Node {node_id}: 'aliases' must be a list")

    # asset_ref: optional and nullable; non-null must match asset-<uuidv4>.
    # It is a pointer to the the external asset owner canonical asset identity, never a
    # lifecycle gate (eligibility is decided by Fleet contract/profile evidence).
    asset_ref = node.get("asset_ref")
    if asset_ref is not None:
        if not isinstance(asset_ref, str):
            errors.append(f"Node {node_id}: 'asset_ref' must be a string or null")
        elif not ASSET_REF_PATTERN.match(asset_ref):
            errors.append(
                f"Node {node_id}: invalid asset_ref '{asset_ref}' "
                "(must match asset-<uuidv4>)"
            )

    # asset_ref_status is not part of the v1 schema; reject it explicitly.
    if "asset_ref_status" in node:
        errors.append(
            f"Node {node_id}: 'asset_ref_status' is not part of the v1 schema"
        )

    # Profile validation
    for profile_field in ("management_profile", "recovery_profile", "automation_profile"):
        val = node.get(profile_field)
        if val is not None and val not in KNOWN_PROFILES:
            errors.append(f"Node {node_id}: unknown {profile_field} '{val}'")

    # Forbidden field scan
    for key in node:
        if key.lower() in FORBIDDEN_FIELDS:
            errors.append(f"Node {node_id}: forbidden field '{key}' (live-state/secret)")

    # Schema 1.2.0: optional management_provider_refs map (tailscale only).
    errors.extend(_validate_provider_refs(node_id, node))

    # Forbidden value patterns (scan all string values)
    _check_forbidden_values(node_id, node, errors)

    return errors


def _check_forbidden_values(node_id: str, obj: Any, errors: list[str], path: str = ""):
    """Recursively check string values for forbidden patterns."""
    if isinstance(obj, str):
        if IP_PATTERN.match(obj):
            errors.append(f"Node {node_id}{path}: value looks like an IP address")
        if HOSTNAME_PATTERN.match(obj) and "." in obj and not obj.endswith(".yaml") and not obj.endswith(".md"):
            errors.append(f"Node {node_id}{path}: value looks like a hostname/FQDN")
        if TOKEN_PATTERN.match(obj):
            errors.append(f"Node {node_id}{path}: value looks like a token/key")
    elif isinstance(obj, dict):
        for k, v in obj.items():
            _check_forbidden_values(node_id, v, errors, f".{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _check_forbidden_values(node_id, v, errors, f"[{i}]")


def validate_registry(data: dict) -> list[str]:
    """Validate complete registry structure. Returns list of error strings."""
    errors = []

    if not isinstance(data, dict):
        return ["Registry root must be a YAML mapping"]

    errors.extend(validate_schema_version(data))

    nodes = data.get("nodes")
    if not isinstance(nodes, dict):
        errors.append("'nodes' must be a mapping")
        return errors

    if len(nodes) == 0:
        errors.append("'nodes' must contain at least one entry")

    seen_ids = set()
    for node_id, node_data in nodes.items():
        if node_id in seen_ids:
            errors.append(f"Duplicate node_id: {node_id}")
        seen_ids.add(node_id)
        errors.extend(validate_node(node_id, node_data))

    errors.extend(_validate_identity_namespaces(nodes))

    return errors


def _validate_identity_namespaces(nodes: dict) -> list[str]:
    """Fail-closed global collision checks across the identity namespaces.

    Fleet Identity v2 (ADR-001): node_id, aliases and node_uid must each be
    unambiguous resolution keys. A name appearing in more than one slot
    (e.g. an alias equal to another node's canonical node_id, or a reused
    node_uid) makes identity resolution non-deterministic and is rejected.
    """
    errors: list[str] = []

    # 1. node_uid global uniqueness (never reuse, never duplicate).
    seen_uids: dict[str, str] = {}
    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            continue
        uid = node.get("node_uid")
        if not isinstance(uid, str):
            continue
        if uid in seen_uids:
            errors.append(
                f"Duplicate node_uid {uid}: used by both "
                f"{seen_uids[uid]!r} and {node_id!r}"
            )
        else:
            seen_uids[uid] = node_id

    # 2. node_id / alias / node_uid namespace disjointness.
    all_node_ids = set(nodes.keys())
    all_uids = set(seen_uids.keys())
    seen_names: dict[str, str] = {}
    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            continue
        for alias in node.get("aliases") or []:
            if not isinstance(alias, str):
                continue
            if alias in seen_names:
                errors.append(
                    f"Alias collision: {alias!r} is used by both "
                    f"{seen_names[alias]!r} and {node_id!r}"
                )
            elif alias in all_node_ids:
                errors.append(
                    f"Alias collision: {alias!r} (alias of {node_id!r}) "
                    "equals the canonical node_id of another node"
                )
            elif alias in all_uids:
                errors.append(
                    f"Alias collision: {alias!r} (alias of {node_id!r}) "
                    "equals a node_uid"
                )
            else:
                seen_names[alias] = node_id

    # 3. A canonical node_id must never collide with any node_uid.
    for node_id in all_node_ids:
        if node_id in all_uids:
            errors.append(
                f"Identity collision: node_id {node_id!r} equals a node_uid"
            )

    return errors


def validate_no_live_state_leak(data: dict) -> list[str]:
    """Additional check: ensure no registry entry looks like live-state data."""
    errors = []
    nodes = data.get("nodes", {})
    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            continue
        # Check for timestamp-like fields
        for key in ("last_seen", "heartbeat_ts", "updated_at", "created_at"):
            if key in node:
                errors.append(f"Node {node_id}: live-state field '{key}' not allowed")
    return errors


def classify_node_field(field: str) -> str:
    """Classify one registry node field into its truth-boundary class.

    Returns one of ``FLEET_CANONICAL`` / ``MANAGEMENT_DERIVED`` /
    ``ASSET_OWNED_LEGACY`` / ``DEPRECATED_NON_CANONICAL`` / ``UNKNOWN``.

    Classification is descriptive only: it never changes
    ``validate_registry()`` acceptance. Enforcement lives in the future
    NEXT_STRICT seam (see ``validate_next_strict``). ``management_provider_refs``
    is FLEET_CANONICAL (FO2B3 correlation, not identity).
    """
    if field in FLEET_CANONICAL_NODE_FIELDS:
        return FIELD_CLASS_FLEET_CANONICAL
    if field in MANAGEMENT_DERIVED_FIELDS:
        return FIELD_CLASS_MANAGEMENT_DERIVED
    if field in ASSET_OWNED_LEGACY_FIELDS:
        return FIELD_CLASS_ASSET_OWNED_LEGACY
    if field in DEPRECATED_NON_CANONICAL_FIELDS:
        return FIELD_CLASS_DEPRECATED_NON_CANONICAL
    return FIELD_CLASS_UNKNOWN


def audit_node_deprecation(node_id: str, node: dict) -> list[str]:
    """Return deterministic deprecation warnings for one node (warning only).

    Reports ``ASSET_OWNED_LEGACY``, ``DEPRECATED_NON_CANONICAL`` and
    ``UNKNOWN`` fields present on the node. ``FLEET_CANONICAL`` (including
    ``management_provider_refs``) and ``MANAGEMENT_DERIVED`` fields produce
    no warnings here; management-derived normalization is deferred to the
    next-strict adjudication.
    """
    warnings: list[str] = []
    if not isinstance(node, dict):
        return warnings
    for field in sorted(node.keys()):
        cls = classify_node_field(field)
        if cls == FIELD_CLASS_ASSET_OWNED_LEGACY:
            warnings.append(
                f"Node {node_id!r}: field {field!r} is ASSET_OWNED_LEGACY "
                "compatibility debt (canonical truth lives in the external asset owner; "
                "do not treat as Fleet authority)"
            )
        elif cls == FIELD_CLASS_DEPRECATED_NON_CANONICAL:
            if field == "agents":
                warnings.append(
                    f"Node {node_id!r}: field {field!r} is DEPRECATED_NON_CANONICAL "
                    "(concrete Agent product lists are not Fleet canonical truth; "
                    "Agent/execution placement belongs to ai-hub/control-plane)"
                )
            elif field == "automation_profile":
                warnings.append(
                    f"Node {node_id!r}: field {field!r} is DEPRECATED_NON_CANONICAL "
                    "(legacy duplicate selector; management_profile + Fleet "
                    "eligibility rules remain canonical)"
                )
            else:
                warnings.append(
                    f"Node {node_id!r}: field {field!r} is DEPRECATED_NON_CANONICAL"
                )
        elif cls == FIELD_CLASS_UNKNOWN:
            warnings.append(
                f"Node {node_id!r}: field {field!r} is UNKNOWN "
                "(not part of Fleet classification; fail-closed in NEXT_STRICT)"
            )
    return warnings


def audit_registry_deprecation(data: dict) -> list[str]:
    """Return deterministic deprecation warnings for the whole registry.

    Iterates nodes in sorted ``node_id`` order; each node's warnings are
    already field-sorted. The final list is sorted for determinism. Empty
    means no legacy/deprecated/unknown debt was observed. This audit never
    fails ``validate_registry()`` — it is the Stage 1 semantic fence before
    the NEXT_STRICT hard enforcement.
    """
    warnings: list[str] = []
    nodes = data.get("nodes", {}) if isinstance(data, dict) else {}
    if not isinstance(nodes, dict):
        return warnings
    for node_id in sorted(nodes.keys()):
        node = nodes[node_id]
        if not isinstance(node, dict):
            continue
        warnings.extend(audit_node_deprecation(node_id, node))
    return sorted(warnings)


def proposed_next_strict_allowed_node_fields() -> frozenset:
    """Return the NEXT_STRICT node-field allowlist (preview seam).

    Allowed in NEXT_STRICT preview = ``FLEET_CANONICAL`` (including
    ``management_provider_refs`` per FO2B3) + ``MANAGEMENT_DERIVED``
    (pending final OS/arch/virtualization normalization). ``ASSET_OWNED_LEGACY``,
    ``DEPRECATED_NON_CANONICAL`` and ``UNKNOWN`` fields are rejected by
    ``validate_next_strict()``. The exact management-derived
    normalization is intentionally left to the separate next-strict
    adjudication. FO2B3 owns schema 1.2.0; guardrails must not claim 1.2
    for purge — use NEXT_STRICT.
    """
    return FLEET_CANONICAL_NODE_FIELDS | MANAGEMENT_DERIVED_FIELDS


def proposed_12_allowed_node_fields() -> frozenset:  # pragma: no cover - alias
    return proposed_next_strict_allowed_node_fields()


def validate_next_strict(data: dict) -> list[str]:
    """Preview the future NEXT_STRICT allowlist policy without enforcing it.

    Returns error strings for every ``ASSET_OWNED_LEGACY`` /
    ``DEPRECATED_NON_CANONICAL`` / ``UNKNOWN`` node field present. Callers
    use this to measure migration distance; ``validate_registry()`` does NOT
    call it so the current registry keeps passing.
    """
    errors: list[str] = []
    nodes = data.get("nodes", {}) if isinstance(data, dict) else {}
    if not isinstance(nodes, dict):
        return ["Registry 'nodes' must be a mapping"]
    allowed = proposed_next_strict_allowed_node_fields()
    for node_id in sorted(nodes.keys()):
        node = nodes[node_id]
        if not isinstance(node, dict):
            continue
        for field in sorted(node.keys()):
            if field in allowed:
                continue
            cls = classify_node_field(field)
            if cls == FIELD_CLASS_ASSET_OWNED_LEGACY:
                errors.append(
                    f"Node {node_id!r}: field {field!r} is ASSET_OWNED_LEGACY and "
                    "is rejected in NEXT_STRICT (canonical truth lives "
                    "in the external asset owner)"
                )
            elif cls == FIELD_CLASS_DEPRECATED_NON_CANONICAL:
                errors.append(
                    f"Node {node_id!r}: field {field!r} is DEPRECATED_NON_CANONICAL and "
                    "is rejected in NEXT_STRICT"
                )
            else:
                errors.append(
                    f"Node {node_id!r}: field {field!r} is UNKNOWN and "
                    "is rejected in NEXT_STRICT (fail-closed allowlist)"
                )
    return sorted(errors)


def validate_proposed_12_strict(data: dict) -> list[str]:  # pragma: no cover - alias
    return validate_next_strict(data)


# Lifecycle states that require enrollment/verification evidence before use.
# DEGRADED is included: per contracts/FLEET.md it applies only to nodes
# previously VERIFIED/MANAGED, so it needs prior-state evidence too.
EVIDENCE_REQUIRED_STATES = {"ENROLLED", "VERIFIED", "MANAGED", "DEGRADED"}

# Migration/foundation policy: no enrollment or verification evidence exists
# yet, so only pre-evidence states may be persisted.
FOUNDATION_EVIDENCE_STATES = {"DISCOVERED", "REGISTERED", "RETIRED"}


def validate_lifecycle_evidence(
    data: dict,
    permitted_states: set[str] | None = None,
    prior_verified_managed: set[str] | None = None,
) -> list[str]:
    """Enforce lifecycle transition/evidence gating, separate from schema validity.

    The canonical schema validator (validate_registry/validate_node) accepts
    every lifecycle state defined by contracts/FLEET.md. This layer applies
    the current evidence context: any state not permitted by the evidence
    context is rejected, and DEGRADED additionally requires prior
    VERIFIED/MANAGED evidence per the contract.

    The foundation migration carries no evidence, so only
    ``FOUNDATION_EVIDENCE_STATES`` may appear by default. Callers with a
    durable evidence chain (future F2/F3) pass an explicit
    ``permitted_states`` set and, for DEGRADED nodes, the
    ``prior_verified_managed`` node ids. This is a context rule, not a
    schema rule.
    """
    errors = []
    if permitted_states is None:
        permitted_states = FOUNDATION_EVIDENCE_STATES
    prior_verified_managed = prior_verified_managed or set()

    nodes = data.get("nodes", {})
    if not isinstance(nodes, dict):
        return errors

    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            continue
        state = node.get("fleet_state")
        if state not in VALID_LIFECYCLE_STATES:
            continue
        if state not in permitted_states:
            errors.append(
                f"Node {node_id}: fleet_state '{state}' is not permitted in the "
                "current evidence context"
            )
        elif state == "DEGRADED" and node_id not in prior_verified_managed:
            errors.append(
                f"Node {node_id}: fleet_state 'DEGRADED' requires prior "
                "VERIFIED/MANAGED evidence per contracts/FLEET.md"
            )
    return errors


def load_and_validate(yaml_content: str) -> dict:
    """Load YAML content and validate as Fleet v1 registry.

    Returns validated data dict on success.
    Raises RegistryValidationError on failure.
    """
    import yaml

    data = yaml.safe_load(yaml_content)
    all_errors = validate_registry(data)
    all_errors.extend(validate_no_live_state_leak(data))

    if all_errors:
        raise RegistryValidationError(all_errors)

    return data
