#!/usr/bin/env bash
# Real selected-capability installation driven by the published courier block.
# GitHub-hosted ephemeral Ubuntu VM ONLY. No Fleet/NAS, no production node.
set -Eeuo pipefail
IFS=$'\n\t'

if [[ "$(id -u)" -ne 0 || "${GITHUB_ACTIONS:-}" != true ||
      "${RUNNER_ENVIRONMENT:-}" != github-hosted ||
      "${GHOSTFLEET_DISPOSABLE_TEST_CONFIRMED:-}" != 1 ||
      -z "${GITHUB_WORKSPACE:-}" ]]; then
  echo "DENIED: disposable GitHub-hosted root runner required" >&2
  exit 3
fi
if [[ -d /etc/openmediavault || -e /etc/openmediavault/config.xml ]]; then
  echo "DENIED: OMV must not be the disposable test target" >&2
  exit 3
fi
ordinary="${GHOSTFLEET_TEST_ORDINARY_USER:-}"
[[ "$ordinary" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$ordinary" != root &&
   "$ordinary" != ghostfleet-ops ]] || exit 3
id "$ordinary" >/dev/null
if id ghostfleet-ops >/dev/null 2>&1 || [[ -e /etc/youling-fleet/privileged-operations/control.json ]]; then
  echo "DENIED: preexisting managed account or state" >&2
  exit 3
fi

work="$(mktemp -d)"
if [[ "${GHOSTFLEET_DISPOSABLE_KEEP_WORK:-0}" = 1 ]]; then
  trap 'echo "kept: $work" >&2' EXIT
else
  trap 'rm -rf "$work"' EXIT
fi
chmod 0700 "$work"

privileged_root="$GITHUB_WORKSPACE/packages/runtime-python/src/ghostfleet_runtime/resources/fleet/10_platforms/linux/common/operations/privileged"
for file in managed-linux-privileged-operations.sh fleet_privctl.py fleet_privileged_ssh_entry.py fleet_admin_command.py; do
  [[ -r "$privileged_root/$file" ]] || { echo "missing $file" >&2; exit 3; }
done
for tool in node ssh-keygen python3 sha256sum visudo useradd loginctl getent; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 3; }
done

ssh-keygen -q -t ed25519 -N '' -C 'synthetic-selected-capability' -f "$work/privileged-ops"

# Render the exact published capability lane plus the template-selected data
# block. Nothing here is re-implemented for the test.
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [work, privilegedRoot] = process.argv.slice(1);
const workspace = process.env.GITHUB_WORKSPACE;
const module = await import(pathToFileURL(join(workspace, "packages/bootstrap/src/index.js")).href);
const read = (name) => readFileSync(join(privilegedRoot, name), "utf8");
const unit = [
  "[Unit]",
  "Description=GhostFleet managed runtime (disposable canary)",
  "",
  "[Service]",
  "Type=oneshot",
  "ExecStart=/bin/true",
  "",
  "[Install]",
  "WantedBy=default.target",
  "",
].join("\n");
const selection = {
  source: "template",
  template_digest: "sha256:" + "0".repeat(64),
  version: "managed-linux-privileged-operations/disposable-1",
  helper_required: true,
  linger_required: true,
  user_service_required: true,
  control_account: "ghostfleet-ops",
  installer: "managed-linux-privileged-operations.sh",
  privileged_key: "privileged-ops.pub",
  user_unit: { name: "ghostfleet-managed.service", artifact: "ghostfleet-managed.service" },
  artifacts: [
    { name: "managed-linux-privileged-operations.sh", mode: "0750", content: read("managed-linux-privileged-operations.sh") },
    { name: "fleet_privctl.py", mode: "0755", content: read("fleet_privctl.py") },
    { name: "fleet_privileged_ssh_entry.py", mode: "0755", content: read("fleet_privileged_ssh_entry.py") },
    { name: "fleet_admin_command.py", mode: "0755", content: read("fleet_admin_command.py") },
    { name: "privileged-ops.pub", mode: "0644", content: readFileSync(join(work, "privileged-ops.pub"), "utf8") },
    { name: "ghostfleet-managed.service", mode: "0644", content: unit },
  ],
};
writeFileSync(join(work, "capability-data.sh"), module.renderCapabilityBlock(selection) + "\n");
writeFileSync(join(work, "empty-data.sh"), module.renderCapabilityBlock(null) + "\n");
// The claim channel: the same selection, base64-encoded exactly as the claim
// response delivers it, so the published parser is what runs here.
writeFileSync(join(work, "claim.json"), JSON.stringify({
  capability_required: true,
  capability_selection: module.encodeCapabilitySelection(selection),
}) + "\n");
const courier = module.BOOTSTRAP_SH;
const begin = courier.indexOf(module.CAPABILITY_SECTION_BEGIN);
const end = courier.indexOf(module.CAPABILITY_SECTION_END);
if (begin < 0 || end < begin) throw new Error("capability section markers missing");
writeFileSync(join(work, "capability-library.sh"), courier.slice(begin, end + module.CAPABILITY_SECTION_END.length) + "\n");
const jsonStart = courier.indexOf("json_flag() {");
const jsonEnd = courier.indexOf(String.fromCharCode(10) + "RESUME_SESSION=");
writeFileSync(join(work, "json-library.sh"), courier.slice(jsonStart, jsonEnd) + "\n");
const shape = module.normalizeSelectedCapability(selection);
writeFileSync(join(work, "selection.json"), JSON.stringify({
  version: shape.version,
  selection_digest: shape.selection_digest,
  artifacts: shape.artifacts.map((item) => ({ name: item.name, sha256: item.sha256, mode: item.mode })),
}, null, 2) + "\n");
' "$work" "$privileged_root"
[[ -s "$work/capability-data.sh" && -s "$work/capability-library.sh" ]] || exit 3

cat > "$work/harness.sh" <<'HARNESS'
#!/bin/sh
set -eu
CHECKPOINT_DIR="${CAPABILITY_CHECKPOINT:?}"
fail() { printf '%s\n' "fleet-enroll: $*" >&2; exit 1; }
. "${CAPABILITY_LIBRARY:?}"
. "${CAPABILITY_DATA:?}"
capability_validate_selection
capability_apply
HARNESS

run_capability() {
  CAPABILITY_CHECKPOINT="$1" CAPABILITY_DATA="$2" CAPABILITY_LIBRARY="$work/capability-library.sh" \
    GHOSTFLEET_OPERATING_USER="$ordinary" \
    sh "$work/harness.sh"
}

cat > "$work/claim-harness.sh" <<'CLAIM_HARNESS'
#!/bin/sh
set -eu
CHECKPOINT_DIR="$CAPABILITY_CHECKPOINT"
fail() { printf '%s\n' "fleet-enroll: $*" >&2; exit 1; }
. "$CAPABILITY_LIBRARY"
. "$JSON_LIBRARY"
CLAIM_JSON="$(cat "$CLAIM_FILE")"
CAPABILITY_REQUIRED="$(json_flag "$CLAIM_JSON" capability_required)"
CAPABILITY_CLAIM_SELECTION_B64="$(json_get "$CLAIM_JSON" capability_selection)"
capability_ingest_claim
capability_apply
CLAIM_HARNESS

# The claim channel, with real root and the real reviewed installer.
run_claim() {
  CAPABILITY_CHECKPOINT="$1" CAPABILITY_LIBRARY="$work/capability-library.sh" \
    JSON_LIBRARY="$work/json-library.sh" CLAIM_FILE="$work/claim.json" \
    GHOSTFLEET_OPERATING_USER="$ordinary" \
    sh "$work/claim-harness.sh"
}
expected_helper_sha="$(sha256sum "$privileged_root/fleet_privctl.py" | awk '{print $1}')"
expected_entry_sha="$(sha256sum "$privileged_root/fleet_privileged_ssh_entry.py" | awk '{print $1}')"

# 1. The template requested nothing: no privileged component may appear.
mkdir -p "$work/checkpoint-empty"
run_capability "$work/checkpoint-empty" "$work/empty-data.sh" >"$work/empty.log" 2>&1
grep -q 'requests no privileged capability' "$work/empty.log"
[[ ! -e /etc/youling-fleet ]] || { echo "unrequested capability created state" >&2; exit 1; }
! id ghostfleet-ops >/dev/null 2>&1 || { echo "unrequested capability created an account" >&2; exit 1; }

# 2. A pinned artifact that cannot be verified must fail before any effect.
python3 - "$work/capability-data.sh" "$work/tampered-data.sh" <<'PY'
import sys
source, target = sys.argv[1], sys.argv[2]
rows, touched = [], False
for line in open(source, encoding="utf-8"):
    if line.startswith("CAPABILITY_ARTIFACT_1=") and not touched:
        prefix, rest = line.split("=", 1)
        name, _digest, mode, blob = rest.strip()[1:-1].split("|", 3)
        rows.append(prefix + "=" + "'" + name + "|" + "0" * 64 + "|" + mode + "|" + blob + "'\n")
        touched = True
    else:
        rows.append(line)
if not touched:
    raise SystemExit("pinned artifact row not found")
open(target, "w", encoding="utf-8").writelines(rows)
PY
if run_capability "$work/checkpoint-tampered" "$work/tampered-data.sh" >"$work/tampered.log" 2>&1; then
  echo "tampered artifact digest was accepted" >&2
  cat "$work/tampered.log" >&2
  exit 1
fi
grep -q 'failed digest verification' "$work/tampered.log" || {
  echo "tampered artifact was rejected for an unexpected reason" >&2
  cat "$work/tampered.log" >&2
  exit 1
}
grep -q 'failed digest verification' "$work/tampered.log"
[[ ! -e /etc/youling-fleet ]] || { echo "tampered capability created state" >&2; exit 1; }
! id ghostfleet-ops >/dev/null 2>&1 || { echo "tampered capability created an account" >&2; exit 1; }

# 3. Real installation through the real reviewed installer, inside one root run.
mkdir -p "$work/checkpoint-new"
if ! run_capability "$work/checkpoint-new" "$work/capability-data.sh" >"$work/new.log" 2>&1; then
  echo "real selected-capability install failed" >&2
  cat "$work/new.log" >&2
  exit 1
fi
grep -q 'mode=NEW' "$work/new.log"
[[ "$(sha256sum /usr/local/libexec/youling-fleet/fleet-privctl | awk '{print $1}')" == "$expected_helper_sha" ]]
[[ "$(sha256sum /usr/local/libexec/youling-fleet/fleet-privileged-ssh-entry | awk '{print $1}')" == "$expected_entry_sha" ]]
visudo -cf /etc/sudoers.d/90-youling-fleet-privileged-operations >/dev/null
grep -q '^Linger=yes$' <<<"$(loginctl show-user ghostfleet-ops -p Linger)"
home="$(getent passwd ghostfleet-ops | cut -d: -f6)"
unit="$home/.config/systemd/user/ghostfleet-managed.service"
[[ -f "$unit" && -L "$home/.config/systemd/user/default.target.wants/ghostfleet-managed.service" ]]
[[ "$(stat -c '%U:%G:%a' "$unit")" == ghostfleet-ops:ghostfleet-ops:644 ]]
grep -q '"mode":"NEW"' "$work/checkpoint-new/capability-state.json"
before_unit="$(sha256sum "$unit")"
before_helper_mtime="$(stat -c %Y /usr/local/libexec/youling-fleet/fleet-privctl)"

# 4. Repeating the converged ceremony is zero delta and reports ADOPT.
mkdir -p "$work/checkpoint-adopt"
run_capability "$work/checkpoint-adopt" "$work/capability-data.sh" >"$work/adopt.log" 2>&1
grep -q 'already converged; zero delta' "$work/adopt.log"
grep -q '"mode":"ADOPT"' "$work/checkpoint-adopt/capability-state.json"
[[ "$(sha256sum "$unit")" == "$before_unit" ]]
[[ "$(stat -c %Y /usr/local/libexec/youling-fleet/fleet-privctl)" == "$before_helper_mtime" ]] || {
  echo "ADOPT re-applied the privileged helper" >&2; exit 1;
}

# 5. The claim channel on the same host: the published parser consumes the
# base64 selection, re-verifies against the real installer and reports ADOPT.
mkdir -p "$work/checkpoint-claim"
if ! run_claim "$work/checkpoint-claim" >"$work/claim.log" 2>&1; then
  echo "claim channel failed" >&2
  cat "$work/claim.log" >&2
  exit 1
fi
grep -q 'already converged; zero delta' "$work/claim.log"
grep -q '"mode":"ADOPT"' "$work/checkpoint-claim/capability-state.json"
claim_digest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["selection_digest"])' "$work/checkpoint-claim/capability-state.json")"
case "$claim_digest" in
  sha256:*) ;;
  *) echo "claim channel recorded no reviewed selection digest" >&2; exit 1 ;;
esac

echo "PASS published selected-capability lane installed the real reviewed helper, user unit and Linger on a disposable root VM; the claim channel consumed the base64 selection through the published parser and reported ADOPT with a recorded digest; unrequested and unverifiable selections made no effect; repeat is ADOPT/zero delta. Real NAS/OMV Linger, user-systemd activation and OMV8 SSH admission NOT_RUN"
