#!/usr/bin/env bash
# Real selected-capability installation driven by the published courier block.
# GitHub-hosted ephemeral Ubuntu VM ONLY. No Fleet/NAS, no production node.
#
# Account isolation is proved here with real root and real tools: the courier
# creates the dedicated run account, the reviewed installer keeps the privileged
# one, the run account cannot reach the helper through sudo, and a failed
# ceremony removes only the account it created.
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
run_account=ghostfleet-managed
privileged_account=ghostfleet-ops
helper_path=/usr/local/libexec/youling-fleet/fleet-privctl
[[ "$ordinary" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$ordinary" != root &&
   "$ordinary" != "$run_account" && "$ordinary" != "$privileged_account" ]] || exit 3
id "$ordinary" >/dev/null
for account in "$run_account" "$privileged_account"; do
  if id "$account" >/dev/null 2>&1; then
    echo "DENIED: preexisting managed account $account" >&2
    exit 3
  fi
done
if [[ -e /etc/youling-fleet/privileged-operations/control.json ]]; then
  echo "DENIED: preexisting managed state" >&2
  exit 3
fi

work="$(mktemp -d)"
if [[ "${GHOSTFLEET_DISPOSABLE_KEEP_WORK:-0}" = 1 ]]; then
  trap 'echo "kept: $work" >&2' EXIT
else
  trap 'rm -rf "$work"' EXIT
fi
chmod 0700 "$work"

fail_check() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
record_ok() { printf 'OK   %s\n' "$*"; }
evidence() { printf 'EVIDENCE %s\n' "$*"; }

privileged_root="$GITHUB_WORKSPACE/packages/runtime-python/src/ghostfleet_runtime/resources/fleet/10_platforms/linux/common/operations/privileged"
for file in managed-linux-privileged-operations.sh fleet_privctl.py fleet_privileged_ssh_entry.py fleet_admin_command.py; do
  [[ -r "$privileged_root/$file" ]] || { echo "missing $file" >&2; exit 3; }
done
for tool in node ssh-keygen python3 sha256sum visudo useradd userdel loginctl getent; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 3; }
done

ssh-keygen -q -t ed25519 -N '' -C 'synthetic-selected-capability' -f "$work/privileged-ops"

# Render the exact published capability lane plus the template-selected data
# block. Nothing here is re-implemented for the test.
CONTROL_ACCOUNT="$run_account" PRIVILEGED_ACCOUNT="$privileged_account" \
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
  control_account: process.env.CONTROL_ACCOUNT,
  privileged_account: process.env.PRIVILEGED_ACCOUNT,
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
  control_account: shape.control_account,
  privileged_account: shape.privileged_account,
  artifacts: shape.artifacts.map((item) => ({ name: item.name, sha256: item.sha256, mode: item.mode })),
}, null, 2) + "\n");
' "$work" "$privileged_root"
[[ -s "$work/capability-data.sh" && -s "$work/capability-library.sh" ]] || exit 3

# A colliding selection, produced by tampering the rendered data block so the
# courier's own check (not the module's) is what refuses it.
sed "s/^CAPABILITY_CONTROL_ACCOUNT=.*\$/CAPABILITY_CONTROL_ACCOUNT='$privileged_account'/" \
  "$work/capability-data.sh" > "$work/collision-data.sh"
grep -qx "CAPABILITY_CONTROL_ACCOUNT='$privileged_account'" "$work/collision-data.sh" ||
  fail_check "the collision data block was not produced"

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

# A PATH whose loginctl always fails: the ceremony then fails after the account
# and the unit exist, which is exactly the state rollback must undo.
install -d -m 0755 "$work/failing-bin"
printf '#!/bin/sh\nexit 1\n' > "$work/failing-bin/loginctl"
chmod 0755 "$work/failing-bin/loginctl"
run_capability_with_failing_loginctl() {
  CAPABILITY_CHECKPOINT="$1" CAPABILITY_DATA="$2" CAPABILITY_LIBRARY="$work/capability-library.sh" \
    GHOSTFLEET_OPERATING_USER="$ordinary" \
    PATH="$work/failing-bin:/usr/sbin:/usr/bin:/sbin:/bin" \
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
[[ ! -e /etc/youling-fleet ]] || fail_check "unrequested capability created state"
! id "$privileged_account" >/dev/null 2>&1 || fail_check "unrequested capability created the privileged account"
! id "$run_account" >/dev/null 2>&1 || fail_check "unrequested capability created the run account"

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
  fail_check "tampered artifact digest was accepted"
fi
grep -q 'failed digest verification' "$work/tampered.log" || {
  echo "tampered artifact was rejected for an unexpected reason" >&2
  cat "$work/tampered.log" >&2
  exit 1
}
[[ ! -e /etc/youling-fleet ]] || fail_check "tampered capability created state"
! id "$privileged_account" >/dev/null 2>&1 || fail_check "tampered capability created the privileged account"

# 3. The run account may never be the privileged operations account. The
#    refusal happens before any account, unit or helper effect.
mkdir -p "$work/checkpoint-collision"
if run_capability "$work/checkpoint-collision" "$work/collision-data.sh" >"$work/collision.log" 2>&1; then
  fail_check "a colliding run account was accepted"
fi
grep -q 'must not be the privileged operations account' "$work/collision.log" || {
  echo "the collision was refused for an unexpected reason" >&2
  cat "$work/collision.log" >&2
  exit 1
}
record_ok "collision refused: $(grep -o 'must not be the privileged operations account[^"]*' "$work/collision.log" | head -n1)"
[[ ! -e /etc/youling-fleet ]] || fail_check "the collision created helper state"
! id "$privileged_account" >/dev/null 2>&1 || fail_check "the collision created the privileged account"
! id "$run_account" >/dev/null 2>&1 || fail_check "the collision created the run account"

# 4. Real installation through the real reviewed installer, inside one root run.
mkdir -p "$work/checkpoint-new"
if ! run_capability "$work/checkpoint-new" "$work/capability-data.sh" >"$work/new.log" 2>&1; then
  echo "real selected-capability install failed" >&2
  cat "$work/new.log" >&2
  exit 1
fi
grep -q 'mode=NEW' "$work/new.log"
grep -q 'created the dedicated managed run account' "$work/new.log"
run_uid="$(id -u "$run_account")"
[[ "$run_uid" -ne 0 ]] || fail_check "the run account is root"
run_shell="$(getent passwd "$run_account" | cut -d: -f7)"
[[ "$run_shell" == /usr/sbin/nologin ]] || fail_check "the run account shell is $run_shell"
record_ok "run account created: $run_account uid=$run_uid shell=$run_shell"
run_home="$(getent passwd "$run_account" | cut -d: -f6)"
[[ -d "$run_home" ]] || fail_check "the run account has no home directory"
[[ "$(stat -c '%U' "$run_home")" == "$run_account" ]] || fail_check "the run home is not owned by the run account"
# Negative proof: the run account has no sudo lane and no root-equivalent group.
run_groups="$(id -nG "$run_account")"
for group in sudo wheel admin docker lxd disk shadow; do
  if printf '%s\n' "$run_groups" | tr ' ' '\n' | grep -qx "$group"; then
    fail_check "the run account is in the root-equivalent group $group"
  fi
done
record_ok "run account groups: $run_groups"
sudo_listing="$(sudo -l -U "$run_account" 2>&1 || true)"
if [[ "$sudo_listing" != *"is not allowed to run sudo"* ]]; then
  printf '%s\n' "$sudo_listing" >&2
  fail_check "the run account has a sudo grant"
fi
record_ok "sudo -l -U $run_account: not allowed"
if grep -rlw "$run_account" /etc/sudoers /etc/sudoers.d/ >/dev/null 2>&1; then
  fail_check "a sudoers file mentions the run account"
fi
record_ok "no sudoers file mentions $run_account"
# The same negative from the inside: the run account cannot invoke the helper.
if su -s /bin/sh "$run_account" -c "sudo -n $helper_path </dev/null" >"$work/run-account-sudo.log" 2>&1; then
  fail_check "the run account reached the privileged helper through sudo"
fi
if grep -q '"ok":true' "$work/run-account-sudo.log"; then
  fail_check "the privileged helper answered the run account"
fi
# sudo's refusal wording changes between versions ("not allowed to run sudo",
# "a password is required", "I'm sorry ... I'm afraid I can't do that"), so the
# property asserted is the non-zero exit above plus a recognisable refusal here.
if ! grep -Eq 'not allowed to run sudo|a password is required|I.m sorry|not in the sudoers file' "$work/run-account-sudo.log"; then
  cat "$work/run-account-sudo.log" >&2
  fail_check "the run account's sudo attempt failed for an unexpected reason"
fi
record_ok "negative: $run_account cannot sudo -n $helper_path"

# Positive: the privileged operations account still reaches the same helper
# through its bounded NOPASSWD rule. The helper itself rejects the empty
# request, which proves sudo admitted the exact pinned command.
sudo -l -U "$privileged_account" 2>/dev/null | grep -q "$helper_path" || fail_check "the ops sudoers rule does not name the helper"
if su -s /bin/sh "$privileged_account" -c "sudo -n $helper_path </dev/null" >"$work/ops-sudo.log" 2>&1; then
  fail_check "the helper accepted an empty request"
fi
grep -q '"ok":false' "$work/ops-sudo.log" || {
  cat "$work/ops-sudo.log" >&2
  fail_check "the ops lane did not execute the helper"
}
record_ok "positive: $privileged_account runs sudo -n $helper_path and the helper answers $(cat "$work/ops-sudo.log")"

[[ "$(sha256sum /usr/local/libexec/youling-fleet/fleet-privctl | awk '{print $1}')" == "$expected_helper_sha" ]]
[[ "$(sha256sum /usr/local/libexec/youling-fleet/fleet-privileged-ssh-entry | awk '{print $1}')" == "$expected_entry_sha" ]]
visudo -cf /etc/sudoers.d/90-youling-fleet-privileged-operations >/dev/null
grep -q '^Linger=yes$' <<<"$(loginctl show-user "$run_account" -p Linger)"
[[ "$(loginctl show-user "$privileged_account" -p Linger)" == "Linger=no" ]] ||
  fail_check "Linger was enabled for the privileged account"
home="$run_home"
unit="$home/.config/systemd/user/ghostfleet-managed.service"
[[ -f "$unit" && -L "$home/.config/systemd/user/default.target.wants/ghostfleet-managed.service" ]]
[[ "$(stat -c '%U:%G:%a' "$unit")" == "$run_account:$run_account:644" ]] ||
  fail_check "unit ownership/mode is $(stat -c '%U:%G:%a' "$unit")"
record_ok "unit owner:group:mode = $(stat -c '%U:%G:%a' "$unit")"
python3 - "$work/checkpoint-new/capability-state.json" "$run_account" "$privileged_account" <<'PY'
import json, sys
state = json.load(open(sys.argv[1], encoding="utf-8"))
assert state["mode"] == "NEW", state
assert state["control_account"] == sys.argv[2], state
assert state["privileged_account"] == sys.argv[3], state
assert state["control_account_state"] == "CREATED", state
assert state["control_account_created_by_courier"] is True, state
print("state:", json.dumps({k: state[k] for k in ("mode", "control_account", "privileged_account", "control_account_state", "control_account_created_by_courier")}))
PY
before_unit="$(sha256sum "$unit")"
before_helper_mtime="$(stat -c %Y /usr/local/libexec/youling-fleet/fleet-privctl)"

# 5. Repeating the converged ceremony is zero delta and reports ADOPT. It must
#    not create a second account or re-run the installer.
mkdir -p "$work/checkpoint-adopt"
run_capability "$work/checkpoint-adopt" "$work/capability-data.sh" >"$work/adopt.log" 2>&1
grep -q 'already converged; zero delta' "$work/adopt.log"
grep -q '"mode":"ADOPT"' "$work/checkpoint-adopt/capability-state.json"
[[ "$(id -u "$run_account")" == "$run_uid" ]] || fail_check "the run account changed uid"
[[ "$(sha256sum "$unit")" == "$before_unit" ]]
[[ "$(stat -c %Y /usr/local/libexec/youling-fleet/fleet-privctl)" == "$before_helper_mtime" ]] || {
  echo "ADOPT re-applied the privileged helper" >&2; exit 1;
}

# 6. Only what this ceremony created is rolled back. Two distinct run accounts
#    keep this proof independent of the converged lane above: a failing Linger
#    step happens after the account and the unit already exist.
rollback_account=gf-run-rollback
sed "s/^CAPABILITY_CONTROL_ACCOUNT=.*\$/CAPABILITY_CONTROL_ACCOUNT='$rollback_account'/" \
  "$work/capability-data.sh" > "$work/rollback-data.sh"
grep -qx "CAPABILITY_CONTROL_ACCOUNT='$rollback_account'" "$work/rollback-data.sh" ||
  fail_check "the rollback data block was not produced"
mkdir -p "$work/checkpoint-rollback"
if run_capability_with_failing_loginctl "$work/checkpoint-rollback" "$work/rollback-data.sh" >"$work/rollback.log" 2>&1; then
  fail_check "a ceremony whose Linger step failed reported success"
fi
grep -q 'selected Linger could not be enabled' "$work/rollback.log" || {
  cat "$work/rollback.log" >&2
  fail_check "the rollback run failed for an unexpected reason"
}
! id "$rollback_account" >/dev/null 2>&1 || fail_check "the run account this ceremony created survived its rollback"
[[ ! -e "/home/$rollback_account" ]] || fail_check "the created run account home survived the rollback"
! grep -rlw "$rollback_account" /etc/sudoers /etc/sudoers.d/ >/dev/null 2>&1 ||
  fail_check "the rolled-back account left a sudoers entry"
record_ok "rollback removed only the account this run created: $rollback_account"

# 7. A pre-existing run account is adopted, never deleted, even when the same
#    ceremony fails.
preexisting_account=gf-run-preexisting
sed "s/^CAPABILITY_CONTROL_ACCOUNT=.*\$/CAPABILITY_CONTROL_ACCOUNT='$preexisting_account'/" \
  "$work/capability-data.sh" > "$work/preexisting-data.sh"
useradd --create-home --user-group --shell /usr/sbin/nologin "$preexisting_account"
pre_uid="$(id -u "$preexisting_account")"
mkdir -p "$work/checkpoint-preexisting"
if run_capability_with_failing_loginctl "$work/checkpoint-preexisting" "$work/preexisting-data.sh" >"$work/preexisting.log" 2>&1; then
  fail_check "a ceremony whose Linger step failed reported success"
fi
id "$preexisting_account" >/dev/null 2>&1 || fail_check "a pre-existing run account was deleted"
[[ "$(id -u "$preexisting_account")" == "$pre_uid" ]] || fail_check "a pre-existing run account changed"
[[ ! -e "/home/$preexisting_account/.config/systemd/user/ghostfleet-managed.service" ]] ||
  fail_check "the failed ceremony left its unit behind"
record_ok "pre-existing run account survived the failed ceremony: $preexisting_account uid=$pre_uid"
# The next authorized run adopts it and converges.
mkdir -p "$work/checkpoint-adopted"
run_capability "$work/checkpoint-adopted" "$work/preexisting-data.sh" >"$work/adopted.log" 2>&1
grep -q "run_account=EXISTING" "$work/adopted.log" || {
  cat "$work/adopted.log" >&2
  fail_check "the pre-existing account was not adopted"
}
[[ "$(id -u "$preexisting_account")" == "$pre_uid" ]] || fail_check "adopting the account recreated it"
[[ -f "/home/$preexisting_account/.config/systemd/user/ghostfleet-managed.service" ]] ||
  fail_check "the adopted lane installed no unit"
record_ok "pre-existing run account adopted without recreation"

# 8. The claim channel on the same host: the published parser consumes the
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
  *) fail_check "claim channel recorded no reviewed selection digest" ;;
esac

# 9. The reviewed installer runs as root: a drift that grants the run account a
#    root-equivalent group while it runs must be caught AFTER it ran, before the
#    unit is installed or completion is reported.
drift_account=gf-run-drift
drift_dir="$work/drift-arms"
install -d -m 0755 "$drift_dir"
cp "$privileged_root/managed-linux-privileged-operations.sh" "$drift_dir/installer-real.sh"
cp "$privileged_root/fleet_privctl.py" "$privileged_root/fleet_privileged_ssh_entry.py" \
  "$privileged_root/fleet_admin_command.py" "$drift_dir/"
cat >"$drift_dir/managed-linux-privileged-operations.sh" <<'DRIFT'
#!/usr/bin/env bash
# Disposable drift arm: the reviewed installer plus one extra root effect that
# hands the run account a root-equivalent group after it has been proved.
set -euo pipefail
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
bash "$here/installer-real.sh" "$1"
if [ "$1" = --apply ]; then
  getent group docker >/dev/null 2>&1 || groupadd --system docker
  usermod -aG docker "$FLEET_DRIFT_RUN_ACCOUNT"
fi
DRIFT
chmod 0750 "$drift_dir/managed-linux-privileged-operations.sh"
cat >"$drift_dir/ghostfleet-managed.service" <<'UNIT'
[Unit]
Description=GhostFleet managed runtime (disposable drift)

[Service]
Type=oneshot
ExecStart=/bin/true

[Install]
WantedBy=default.target
UNIT
CONTROL_ACCOUNT="$drift_account" PRIVILEGED_ACCOUNT="$privileged_account" \
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [work, dir] = process.argv.slice(1);
const module = await import(pathToFileURL(join(process.env.GITHUB_WORKSPACE, "packages/bootstrap/src/index.js")).href);
const read = (name) => readFileSync(join(dir, name), "utf8");
const selection = {
  source: "template",
  template_digest: "sha256:" + "1".repeat(64),
  version: "managed-linux-privileged-operations/disposable-drift-1",
  helper_required: true,
  linger_required: true,
  user_service_required: true,
  control_account: process.env.CONTROL_ACCOUNT,
  privileged_account: process.env.PRIVILEGED_ACCOUNT,
  installer: "managed-linux-privileged-operations.sh",
  privileged_key: "privileged-ops.pub",
  user_unit: { name: "ghostfleet-managed.service", artifact: "ghostfleet-managed.service" },
  artifacts: [
    { name: "managed-linux-privileged-operations.sh", mode: "0750", content: read("managed-linux-privileged-operations.sh") },
    { name: "installer-real.sh", mode: "0750", content: read("installer-real.sh") },
    { name: "fleet_privctl.py", mode: "0755", content: read("fleet_privctl.py") },
    { name: "fleet_privileged_ssh_entry.py", mode: "0755", content: read("fleet_privileged_ssh_entry.py") },
    { name: "fleet_admin_command.py", mode: "0755", content: read("fleet_admin_command.py") },
    { name: "privileged-ops.pub", mode: "0644", content: readFileSync(join(work, "privileged-ops.pub"), "utf8") },
    { name: "ghostfleet-managed.service", mode: "0644", content: read("ghostfleet-managed.service") },
  ],
};
writeFileSync(join(work, "drift-data.sh"), module.renderCapabilityBlock(selection) + "\n");
' "$work" "$drift_dir" || fail_check "the drift selection could not be rendered"
# The reviewed installer must really run for the drift arm to exist, so the
# helper it owns is removed first; the drift arm reinstalls it.
rm -f /usr/local/libexec/youling-fleet/fleet-privctl
mkdir -p "$work/checkpoint-drift"
export FLEET_DRIFT_RUN_ACCOUNT="$drift_account"
if run_capability "$work/checkpoint-drift" "$work/drift-data.sh" >"$work/drift.log" 2>&1; then
  fail_check "a run account that gained a root-equivalent group during the installer was accepted"
fi
unset FLEET_DRIFT_RUN_ACCOUNT
grep -q 'CAPABILITY_RUN_ACCOUNT_PRIVILEGED' "$work/drift.log" || {
  cat "$work/drift.log" >&2
  fail_check "the post-installer drift was refused for an unexpected reason"
}
grep -q 'root-equivalent group docker' "$work/drift.log" || fail_check "the refusal does not name the group"
grep -q 'no completion is reported' "$work/drift.log" || fail_check "the drift refusal did not stop the run"
! id "$drift_account" >/dev/null 2>&1 || fail_check "the drifted account this run created was not rolled back"
[[ ! -e "/home/$drift_account" ]] || fail_check "the drifted run account home survived the rollback"
[[ ! -e "/home/$drift_account/.config/systemd/user/ghostfleet-managed.service" ]] || fail_check "a unit was installed after the re-proof failed"
[[ "$(loginctl show-user "$drift_account" -p Linger 2>/dev/null || true)" != "Linger=yes" ]] || fail_check "Linger was enabled after the re-proof failed"
record_ok "post-installer drift caught: $(grep -o 'CAPABILITY_RUN_ACCOUNT_PRIVILEGED[^;]*' "$work/drift.log" | head -n1)"

# 10. A unit left inside the privileged account by a v1 selection is refused
#     before anything is installed beside it. Nothing recorded on this node
#     claims that lane, so it is reported and left for its owner to decommission.
privileged_home="$(getent passwd "$privileged_account" | cut -d: -f6)"
stale_unit="$privileged_home/.config/systemd/user/ghostfleet-managed.service"
stale_want="$privileged_home/.config/systemd/user/default.target.wants/ghostfleet-managed.service"
install -d -m 0755 "$privileged_home/.config/systemd/user/default.target.wants"
printf '[Service]\nExecStart=/bin/true\n' >"$stale_unit"
printf 'stale\n' >"$stale_want"
loginctl enable-linger "$privileged_account"
mkdir -p "$work/checkpoint-stale"
if run_capability "$work/checkpoint-stale" "$work/capability-data.sh" >"$work/stale.log" 2>&1; then
  fail_check "a v1 lane inside the privileged account was accepted"
fi
grep -q 'CAPABILITY_STALE_PRIVILEGED_LANE' "$work/stale.log" || {
  cat "$work/stale.log" >&2
  fail_check "the stale lane was refused for an unexpected reason"
}
grep -q 'Decommission it first' "$work/stale.log" || fail_check "the refusal gives no decommission steps"
[[ -e "$stale_unit" ]] || fail_check "a pre-existing lane was deleted by the courier"
[[ -e "$stale_want" ]] || fail_check "a pre-existing enablement link was deleted by the courier"
record_ok "stale privileged lane refused: $(grep -o 'CAPABILITY_STALE_PRIVILEGED_LANE[^;]*' "$work/stale.log" | head -n1 | tr -s ' ')"
loginctl disable-linger "$privileged_account" 2>/dev/null || true
rm -f "$stale_want" "$stale_unit"

evidence "run_account=$run_account uid=$run_uid home=$run_home groups=$run_groups"
evidence "privileged_account=$privileged_account sudo_rule=$(sudo -l -U "$privileged_account" 2>/dev/null | grep -o "$helper_path" | head -n1)"
evidence "negative=$run_account cannot sudo -n $helper_path; positive=$privileged_account ran it: $(cat "$work/ops-sudo.log")"
evidence "claim selection_digest=$claim_digest"

echo "PASS published selected-capability lane created the dedicated run account (nologin, locked, no sudo, no root-equivalent group), kept the privileged account separate, installed the real reviewed helper under fixed-pin digests, put the unit and Linger under the run account, refused the account collision and the missing run account without any effect, caught a root-equivalent group granted by the installer after it ran, refused a v1 lane left inside the privileged account, rolled back only the account it created, adopted a pre-existing account without recreating it, and answered the claim channel through the published parser. Real OMV8 Linger/SSH admission and a real managed runtime NOT_RUN"
