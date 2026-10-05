"""One Linux common, opt-in convergence engine for primary enrollment.

It establishes primary identity/service postconditions, not lifecycle promotion
or full remote-maintenance acceptance. CF-B, Human and privileged lanes retain
their independent authority and typed acceptance contracts.
"""
from __future__ import annotations
import re

from ghostfleet_runtime.control.enrollment_attempt import AttemptError, DIGEST_RE, EVIDENCE_RE, digest, validate_manifest
from ghostfleet_runtime.control.enrollment_node import NodeAttempt, TailscaleNode
from ghostfleet_runtime.control.enrollment_proof import ProofAdapter, valid_identity
from .system import MARKER, STATE, DESCRIPTOR, CHECKPOINT, SESSION, ConvergeError

CONFIG_FIELDS = {"protocol", "manifest", "machine_id_sha256", "provider_instance", "projection",
                 "profile_generation", "rollback_ref", "recovery_ref", "packages", "proof_adapter", "handoff_path"}


def validate_config(value):
    if not isinstance(value, dict) or set(value) != CONFIG_FIELDS or value["protocol"] != MARKER:
        raise ConvergeError("CONVERGER_CONFIG_INVALID")
    validate_manifest(value["manifest"])
    if (not isinstance(value["machine_id_sha256"], str) or not DIGEST_RE.fullmatch(value["machine_id_sha256"])
            or not isinstance(value["profile_generation"], str) or not DIGEST_RE.fullmatch(value["profile_generation"])):
        raise ConvergeError("TARGET_GENERATION_INVALID")
    provider = value["provider_instance"]
    if (not isinstance(provider, dict) or set(provider) != {"provider", "instance_id"}
            or any(not isinstance(v, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", v) for v in provider.values())):
        raise ConvergeError("PROVIDER_INSTANCE_INVALID")
    projection = value["projection"]
    if (not isinstance(projection, dict) or set(projection) != {"schema_version", "product_source_revision", "instance_overlay_revision", "projection_digest"}
            or projection["schema_version"] != "1.0.0"
            or any(not isinstance(projection[k], str) or not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", projection[k])
                   for k in ("product_source_revision", "instance_overlay_revision"))
            or not isinstance(projection["projection_digest"], str) or not DIGEST_RE.fullmatch(projection["projection_digest"])):
        raise ConvergeError("PROJECTION_REQUIRED")
    if any(not isinstance(value[k], str) or not EVIDENCE_RE.fullmatch(value[k]) for k in ("rollback_ref", "recovery_ref")):
        raise ConvergeError("RECOVERY_ROLLBACK_REQUIRED")
    packages = value["packages"]
    # First family hook intentionally supports only the primary Tailscale
    # package. Dependencies must already exist; upgrades need a separate plan.
    if (not isinstance(packages, dict) or set(packages) != {"tailscale"}
            or not isinstance(packages["tailscale"], str) or not re.fullmatch(r"[0-9][A-Za-z0-9.+:~_-]{0,127}", packages["tailscale"])):
        raise ConvergeError("PACKAGE_MANIFEST_INVALID")
    adapter = value["proof_adapter"]
    if (not isinstance(adapter, dict) or set(adapter) != {"path", "sha256"}
            or not isinstance(adapter["path"], str) or not adapter["path"].startswith("/")
            or not isinstance(adapter["sha256"], str) or not DIGEST_RE.fullmatch(adapter["sha256"])):
        raise ConvergeError("PROOF_ADAPTER_CONFIG_INVALID")
    if value["handoff_path"] is not None and (not isinstance(value["handoff_path"], str) or not value["handoff_path"].startswith("/")):
        raise ConvergeError("HANDOFF_PATH_INVALID")
    return value


class Converger:
    def __init__(self, system, config, *, provider=None, proof=None, attempt_factory=NodeAttempt):
        self.system = system
        self.config = validate_config(config)
        self.provider = provider or TailscaleNode(system.runner)
        self.proof = proof or ProofAdapter(system, config["proof_adapter"])
        self.attempt_factory = attempt_factory
        self.binding = {k: config[k] for k in ("manifest", "machine_id_sha256", "provider_instance", "projection", "profile_generation", "recovery_ref")}
        self.uid = config["manifest"]["node_uid"]
        self.actions = []

    def detect(self):
        host = self.system.host_identity()
        if host["machine_id_sha256"] != self.config["machine_id_sha256"] or host["os_family"] != self.config["manifest"]["os_family"]:
            raise ConvergeError("EXACT_HOST_MISMATCH")
        for destination in (DESCRIPTOR, CHECKPOINT, SESSION, STATE+"/admission.lock"):
            self.system.validate_destination(destination)
        descriptor = self.system.read_json(DESCRIPTOR, optional=True)
        checkpoint = self.system.read_json(CHECKPOINT, optional=True)
        legacy = self.system.read_json("/var/lib/fleet/enrollment-report.json", optional=True)
        for existing in (descriptor, checkpoint):
            if existing is not None and (existing.get("owner") != MARKER or existing.get("node_uid") != self.uid):
                raise ConvergeError("FOREIGN_FLEET_STATE")
        if legacy is not None and legacy.get("node_uid") != self.uid:
            raise ConvergeError("LEGACY_UID_CONFLICT")
        if descriptor is not None:
            if (descriptor.get("machine_id_sha256") != self.binding["machine_id_sha256"]
                    or descriptor.get("provider_instance") != self.binding["provider_instance"]
                    or not valid_identity(descriptor.get("identity"))):
                raise ConvergeError("DESCRIPTOR_IDENTITY_CONFLICT")
        packages = {name: self.system.family.package(name) for name in self.config["packages"]}
        if any(version is not None and version != self.config["packages"][name] for name, version in packages.items()):
            raise ConvergeError("PACKAGE_UPGRADE_SEPARATE_PLAN")
        service = self.system.service()
        if service["LoadState"] == "not-found" and packages["tailscale"] is not None:
            raise ConvergeError("SERVICE_DEFINITION_MISSING")
        observed = self.provider.observe() if service["ActiveState"] == "active" else None
        if observed is not None and descriptor is not None and observed["identity"] != descriptor["identity"]:
            raise ConvergeError("LIVE_IDENTITY_CONFLICT")
        files = {path: self.system.file_observation(path) for path in (DESCRIPTOR, CHECKPOINT)}
        return {"host": host, "descriptor": descriptor, "packages": packages, "service": service, "provider": observed, "owned_files": files}

    def desired_files(self, identity, attempt_id):
        descriptor = {"owner": MARKER, "node_uid": self.uid, **self.binding, "identity": identity}
        postconditions = {"binding": self.binding, "identity": identity, "packages": self.config["packages"],
                          "service": {"LoadState": "loaded", "ActiveState": "active", "UnitFileState": "enabled"}}
        completion = digest(postconditions)
        checkpoint = {"owner": MARKER, "node_uid": self.uid, "phase": "CHECKPOINT", "scope": "primary-enrollment",
                      "attempt_id": attempt_id, "postconditions_digest": completion, "rollback_ref": self.config["rollback_ref"], **self.binding}
        return descriptor, checkpoint, completion

    def plan(self, state, attempt_id):
        changes = []
        if any(v is None for v in state["packages"].values()):
            changes.append("install-missing-exact-packages")
        if state["service"]["UnitFileState"] != "enabled":
            changes.append("enable-tailscaled")
        if state["service"]["ActiveState"] != "active":
            changes.append("start-tailscaled-and-reread-identity")
        if state["provider"] is not None:
            if state["provider"]["identity"] is None:
                changes.append("claim-same-attempt-and-join")
            elif state["provider"]["state"] == "Stopped":
                changes.append("resume-existing-identity")
        else:
            changes.append("identity-plan-deferred-until-daemon-readable")
        identity = state["provider"]["identity"] if state["provider"] else None
        if identity is None:
            changes.append("owned-file-plan-deferred-until-live-identity-verified")
        else:
            descriptor, checkpoint, _ = self.desired_files(identity, attempt_id)
            if not self.system.file_matches(DESCRIPTOR, descriptor):
                changes.append("write-owned-descriptor")
            if not self.system.file_matches(CHECKPOINT, checkpoint):
                changes.append("write-owned-checkpoint")
        return {"protocol": MARKER, "binding": self.binding, "attempt_id": attempt_id,
                "rollback_ref": self.config["rollback_ref"], "observed_preconditions_digest": digest(state), "changes": changes}

    def run(self):
        # Lock is admission only. It is not a completion/checkpoint authority.
        self.detect()  # Wrong host/foreign state must not create even admission files.
        with self.system.lock():
            return self._run()

    def read_attempt(self):
        if self.config["handoff_path"]:
            handoff = self.system.read_json(self.config["handoff_path"], secret=True)
            return self.attempt_factory(handoff, self.config["manifest"], self.system)
        return None

    def plan_readonly(self):
        state = self.detect()
        attempt = self.read_attempt()  # Validates local binding, no HTTP/write.
        return self.plan(state, attempt.handoff["attempt_id"] if attempt else None)

    def _run(self):
        state = self.detect()  # Every invocation, regardless of checkpoint.
        attempt = self.read_attempt()
        aid = attempt.handoff["attempt_id"] if attempt else None
        observed = state["provider"]
        if attempt is None and ((observed is not None and observed["identity"] is None)
                                or state["packages"]["tailscale"] is None and state["descriptor"] is None):
            raise ConvergeError("PRIVATE_HANDOFF_REQUIRED")
        preflight_identity = observed["identity"] if observed else (state["descriptor"]["identity"] if state["descriptor"] else None)
        self.proof.verify(self.binding, preflight_identity, aid)
        plan = self.plan(state, aid)
        # Before the first managed effect, re-read all observable preconditions.
        if self.detect() != state:
            raise ConvergeError("PRECONDITIONS_CHANGED")
        missing = {k: self.config["packages"][k] for k, v in state["packages"].items() if v is None}
        if missing:
            self.system.family.install(missing)
            self.actions.append("install-missing-exact-packages")
            state = self.detect()
        if state["service"]["UnitFileState"] != "enabled":
            self.system.service_action("enable")
            self.actions.append("enable-tailscaled")
            state = self.detect()
        if state["service"]["ActiveState"] != "active":
            self.system.service_action("start")
            self.actions.append("start-tailscaled")
            state = self.detect()
        observed = state["provider"]
        if observed is None:
            raise ConvergeError("SERVICE_POSTCONDITION_FAILED")
        identity_plan = self.plan(state, aid)
        plan["verified_identity_changes"] = [change for change in identity_plan["changes"]
                                               if change in {"claim-same-attempt-and-join", "resume-existing-identity"}]
        identity = observed["identity"]
        if identity is None:
            if state["descriptor"] is not None:
                raise ConvergeError("PERSISTED_IDENTITY_LOST")
            if attempt is None:
                raise ConvergeError("PRIVATE_HANDOFF_REQUIRED")
            secret = attempt.claim()
            attempt.before_join()  # Persist dispatch fence before invoking CLI.
            try:
                attempt.authorize_join()  # Final deadline/session gate after fsync.
                self.provider.join(secret, self.config["manifest"]["node_id"])
            except AttemptError:
                attempt.join_unknown()
                # Only fresh exact self + independent provider proof can rescue
                # an ambiguous result. There is no second call to join.
            finally:
                secret = None
            self.actions.append("join-same-attempt")
            state = self.detect()
            identity = state["provider"]["identity"] if state["provider"] else None
            if identity is None:
                raise ConvergeError("JOIN_OUTCOME_UNKNOWN")
        else:
            # A matching local descriptor alone never substitutes for provider
            # proof. A stopped daemon is started, then inspected before choice.
            self.proof.verify(self.binding, identity, aid)
            if observed["state"] == "Stopped":
                self.provider.resume()
                self.actions.append("resume-existing-identity")
        final = self.detect()
        if (final["provider"] != {"state": "Running", "identity": identity}
                or final["packages"] != self.config["packages"]
                or final["service"] != {"LoadState": "loaded", "ActiveState": "active", "UnitFileState": "enabled"}):
            raise ConvergeError("LIVE_POSTCONDITION_FAILED")
        proof = self.proof.verify(self.binding, identity, aid)
        # Resolve the initially deferred file plan only with verified live
        # identity. This bounded subplan precedes every owned file mutation.
        file_plan = self.plan(final, aid)
        plan["verified_file_changes"] = [change for change in file_plan["changes"] if change.startswith("write-owned-")]
        descriptor, checkpoint, completion = self.desired_files(identity, aid)
        if self.system.write_json(DESCRIPTOR, descriptor):
            self.actions.append("write-owned-descriptor")
        # The independent controller can attest terminal completion read-only
        # after a node resume expires. Fresh local/provider proof above remains
        # mandatory; a checkpoint alone never bypasses session authority.
        if attempt is not None:
            terminal = proof.get("attempt") or {}
            if terminal.get("state") == "COMPLETE":
                if terminal.get("completion_digest") != completion:
                    raise ConvergeError("TERMINAL_COMPLETION_CONFLICT")
            else:
                attempt.complete(completion)
        if self.system.write_json(CHECKPOINT, checkpoint):
            self.actions.append("write-owned-checkpoint")
        return {"protocol": MARKER, "outcome": "PRIMARY_CONVERGED", "node_uid": self.uid, "plan": plan,
                "material_delta": self.actions, "postconditions_digest": completion, "proof_ref": proof["evidence_ref"],
                "lifecycle_promoted": False}
