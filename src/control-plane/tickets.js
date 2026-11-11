import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const CODE_RE = /^[0-9]{8}$/;

export class EnrollmentTicketError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "EnrollmentTicketError";
    this.code = code;
    this.status = status;
  }
}

export function sha256Text(value) {
  return "sha256:" + createHash("sha256").update(String(value)).digest("hex");
}

function safeDigestEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createTicketFactors({
  codeFactory = () => String(randomBytes(4).readUInt32BE(0) % 100000000).padStart(8, "0"),
} = {}) {
  const short_code = String(codeFactory());
  if (!CODE_RE.test(short_code)) throw new EnrollmentTicketError("TICKET_SHORT_CODE_INVALID");
  return Object.freeze({ short_code });
}

export function createTicketRecord({ ticket_id, attempt, short_code, issued_at, expires_at }) {
  if (!ticket_id || !attempt?.attempt_id || !attempt?.template_binding?.template_digest) throw new EnrollmentTicketError("TICKET_BINDING_REQUIRED");
  return Object.freeze({
    ticket_id,
    attempt_id: attempt.attempt_id,
    template_id: attempt.template_binding.template_id,
    template_generation: attempt.template_binding.template_generation,
    template_digest: attempt.template_binding.template_digest,
    state: "ISSUED",
    short_code_digest: sha256Text(short_code),
    failed_claims: 0,
    issued_at,
    expires_at,
    preflight_digest: null,
    consumed_at: null,
    resume_capability_digest: null,
    identity_kind: null,
    enrollment_id: null,
    node_id: null,
    node_uid: null,
    completed_at: null,
    completion_digest: null,
    reason_code: null,
  });
}

export function publicTicketMetadata(record) {
  if (!record) throw new EnrollmentTicketError("TICKET_NOT_FOUND", 404);
  const claim_material_state = record.state === "ISSUED" ? "SHORT_CODE_PRESENT_ONCE_IN_DELIVERY" :
    ["CONSUMED", "COMPLETED"].includes(record.state) ? "CONSUMED" : "DESTROYED_OR_INVALID";
  return Object.freeze({
    ticket_id: record.ticket_id,
    attempt_id: record.attempt_id,
    template_id: record.template_id,
    template_generation: record.template_generation,
    template_digest: record.template_digest,
    state: record.state,
    issued_at: record.issued_at,
    expires_at: record.expires_at,
    failed_claims: record.failed_claims,
    preflight_digest: record.preflight_digest,
    claim_material_state,
    secret_value_included: false,
  });
}

export function validatePublicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new EnrollmentTicketError("PUBLIC_ORIGIN_INVALID"); }
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (!(url.protocol === "https:" || local) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new EnrollmentTicketError("PUBLIC_ORIGIN_INVALID");
  }
  return url.origin;
}

// The delivered command carries no ticket URL, short code, or provider credential.
// Root elevation happens before the downloaded bootstrap is executed. The Human
// pastes the one-time URL into the protected root terminal, with terminal echo
// disabled; the script then asks for the separate eight-digit short code.
//
// The elevated script is environment-proof (review F-62-1) and interruption-safe
// (review F-62-2):
// - su --login clears the inherited caller environment (util-linux: it "clears
//   all the environment variables except TERM"; non-login su keeps the caller
//   environment), and the elevated command line itself starts env -i with a
//   fixed root-owned PATH. Caller PATH, TMPDIR, HOME, ENV, BASH_ENV and shell
//   startup files cannot steer root execution.
// - Every executable is addressed by an absolute root-owned path.
// - The download lives in a 0700 directory that root creates after elevation
//   under /run. A caller-owned TMPDIR (or its directory entries) is never a root
//   execution point, even while the Human is typing the hidden URL.
// - HUP, INT, QUIT, TERM and EXIT all remove that directory, restore the terminal
//   echo state and exit with 128+signal (or the original status). Cleanup restores
//   the terminal first and resets the traps last, and HUP/INT/QUIT/TERM are
//   ignored for the whole cleanup, so a second Ctrl-C or Ctrl-\ (normal Human
//   actions) cannot leave the terminal unechoed or the private workspace behind.
//
// Known trade-offs, recorded for review:
// - su --login runs root's login profile (/etc/profile and root-owned dotfiles)
//   before the elevated script starts. env -i is the actual execution boundary
//   for the privileged script; login mode is what guarantees the caller
//   environment is dropped before that profile runs.
// - The elevation entry point itself (id, command -v sudo/su, sudo, su) still
//   resolves through the caller PATH for portability and never crosses the root
//   boundary. A caller whose PATH is already compromised can intercept its own
//   password prompt; that is outside this launcher's boundary.
// - Because cleanup ignores HUP/INT/QUIT/TERM while it runs, a workspace removal
//   that stalls cannot be interrupted by a Human; the signals are discarded
//   until cleanup finishes. The removal is one rm -rf of a directory this script
//   created, and leaving the terminal unechoed or the workspace behind is the
//   worse outcome, so the trade is accepted.
const TRUSTED_ENV = "/usr/bin/env";
const TRUSTED_SHELL = "/bin/sh";
const TRUSTED_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const TRUSTED_STTY = "/usr/bin/stty";
const TRUSTED_MKTEMP = "/usr/bin/mktemp";
const TRUSTED_CURL = "/usr/bin/curl";
const TRUSTED_WGET = "/usr/bin/wget";
const TRUSTED_RM = "/bin/rm";

function quoteShell(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

// env -i also drops ENV/BASH_ENV/LD_* and TMPDIR that the elevation tool may
// have preserved (non-login su does), so the privileged script starts from an
// environment that only this control plane chose.
// The caller's user name is the only value that crosses the elevation boundary,
// and it crosses as the shell's first positional parameter ($1), never as an
// environment variable: env -i keeps dropping everything the caller chose, and
// the privileged script re-validates the name before it owns anything.
function cleanRootShell(script) {
  return [TRUSTED_ENV, "-i", "PATH=" + TRUSTED_PATH, "HOME=/root", TRUSTED_SHELL, "-c", quoteShell(script), "ghostfleet-enroll"].join(" ");
}

// The one identity GhostFleet may hand to the privileged script. It is captured
// before elevation from the kernel (`id -un`), validated here so it can never
// inject shell syntax, and re-validated by the bootstrap (name, existence, uid).
const OPERATING_USER_CAPTURE = [
  "OPERATING_USER=",
  "TRUSTED_ID=/usr/bin/id",
  'if [ ! -x "$TRUSTED_ID" ]; then',
  "  printf '%s\\n' 'GhostFleet requires /usr/bin/id to identify the Human account; install coreutils at the trusted path' >&2",
  "  exit 1",
  "fi",
  'if [ "$("$TRUSTED_ID" -u)" -ne 0 ]; then',
  '  OPERATING_USER="$("$TRUSTED_ID" -un)"',
  '  case "$OPERATING_USER" in',
  "    ''|[!a-z_]*|*[!a-z0-9_-]*) OPERATING_USER_INVALID=1 ;;",
  "  esac",
  '  if [ "$(printf "%s" "$OPERATING_USER" | wc -c)" -gt 32 ]; then OPERATING_USER_INVALID=1; fi',
  '  if [ "$OPERATING_USER_INVALID" = 1 ]; then',
  "    printf '%s\\n' 'GhostFleet cannot use this account name as the Human owner: it must start with a lowercase letter or underscore, contain only [a-z0-9_-], and be at most 32 characters' >&2",
  "    exit 1",
  "  fi",
  "fi",
].join("\n");




function portableBootstrapCommand(origin) {
  const downloadUrl = origin + "/v1/bootstrap.sh";
  const rootScript = [
    "set -eu",
    "umask 077",
    "TTY_STATE=",
    "WORK_DIR=",
    "cleanup() {",
    "  status=$?",
    // Ignore signals for the whole cleanup. A second Ctrl-C or Ctrl-\ is a
    // normal Human action and must not kill the shell before the terminal echo
    // is back and the private workspace is gone. The trap set is reset only at
    // the end.
    "  trap '' HUP INT QUIT TERM",
    '  if [ -n "$TTY_STATE" ]; then',
    "    " + TRUSTED_STTY + ' "$TTY_STATE" < /dev/tty 2>/dev/null || :',
    "  fi",
    "  TTY_STATE=",
    '  if [ -n "$WORK_DIR" ]; then',
    "    " + TRUSTED_RM + ' -rf "$WORK_DIR" 2>/dev/null || :',
    "  fi",
    "  WORK_DIR=",
    "  trap - EXIT HUP INT QUIT TERM",
    '  exit "$status"',
    "}",
    // The first statement of the signal path ignores HUP/INT/QUIT/TERM, so a
    // burst of signals cannot re-enter cleanup or abort it half way.
    "stop() {",
    "  trap '' HUP INT QUIT TERM",
    '  exit "$1"',
    "}",
    "trap cleanup EXIT",
    "trap 'stop 129' HUP",
    "trap 'stop 130' INT",
    "trap 'stop 131' QUIT",
    "trap 'stop 143' TERM",
    "TMPROOT=/run/",
    'if [ ! -d "$TMPROOT" ]; then TMPROOT=/var/tmp/; fi',
    'WORK_DIR="$(' + TRUSTED_MKTEMP + ' -d "$TMPROOT"ghostfleet-enroll.XXXXXXXX)"',
    'BOOTSTRAP="$WORK_DIR/bootstrap.sh"',
    "if [ -x " + TRUSTED_CURL + " ]; then",
    "  " + TRUSTED_CURL + " -fsSL " + quoteShell(downloadUrl) + ' -o "$BOOTSTRAP"',
    "elif [ -x " + TRUSTED_WGET + " ]; then",
    "  " + TRUSTED_WGET + " -qO " + quoteShell(downloadUrl) + ' "$BOOTSTRAP"',
    "else",
    "  printf '%s\\n' 'GhostFleet requires curl or wget' >&2",
    "  exit 1",
    "fi",
    'if [ ! -s "$BOOTSTRAP" ]; then',
    "  printf '%s\\n' 'GhostFleet bootstrap download is empty' >&2",
    "  exit 1",
    "fi",
    'if ! TTY_STATE="$(' + TRUSTED_STTY + ' -g 2>/dev/null < /dev/tty)"; then',
    "  printf '%s\\n' 'GhostFleet needs an interactive terminal: run the command in a terminal session and paste the one-time URL at the prompt' >&2",
    "  exit 1",
    "fi",
    TRUSTED_STTY + " -echo < /dev/tty",
    "printf 'One-time enrollment URL from protected Console: ' > /dev/tty",
    "if ! IFS= read -r GHOSTFLEET_ENROLLMENT_URL < /dev/tty; then",
    "  printf '\\n%s\\n' 'GhostFleet requires the one-time enrollment URL' >&2",
    "  exit 1",
    "fi",
    TRUSTED_STTY + ' "$TTY_STATE" < /dev/tty',
    "TTY_STATE=",
    "printf '\\n' > /dev/tty",
    'case "$GHOSTFLEET_ENROLLMENT_URL" in ' + quoteShell(origin) + "/v1/enrollment-tickets/ticket-*) ;;",
    "  *) printf '%s\\n' 'Invalid enrollment URL for this control plane' >&2; exit 1 ;;",
    "esac",
    "export GHOSTFLEET_ENROLLMENT_URL",
    // The bootstrap validates this name again before anything becomes its owner.
    'GHOSTFLEET_OPERATING_USER="${1-}"',
    "export GHOSTFLEET_OPERATING_USER",
    TRUSTED_SHELL + ' "$BOOTSTRAP"',
  ].join("\n");
  const elevated = cleanRootShell(rootScript);
  return [
    "(",
    OPERATING_USER_CAPTURE,
    'if [ "$(id -u)" -eq 0 ]; then',
    "  " + elevated + ' "$OPERATING_USER"',
    "elif command -v sudo >/dev/null 2>&1; then",
    "  sudo " + elevated + ' "$OPERATING_USER"',
    "elif command -v su >/dev/null 2>&1; then",
    "  ELEVATED=" + quoteShell(elevated),
    "  su --login root -c \"$ELEVATED '$OPERATING_USER'\"",
    "else",
    "  printf '%s\\n' 'GhostFleet requires one root confirmation using sudo or su' >&2",
    "  exit 1",
    "fi",
    ")",
  ].join("\n");
}

export function createTicketDelivery({ record, short_code, public_origin }) {
  const origin = validatePublicOrigin(public_origin);
  const one_time_url = origin + "/v1/enrollment-tickets/" + encodeURIComponent(record.ticket_id);
  return Object.freeze({
    one_time_url,
    short_code,
    expires_at: record.expires_at,
    command: portableBootstrapCommand(origin),
    warning: "ONE_TIME_ENROLLMENT_MATERIAL_EXECUTE_PROMPTLY",
  });
}

export function verifyTicketClaim(record, { short_code, preflight_digest, now_ms, max_failed_claims = 5 }) {
  if (!record) throw new EnrollmentTicketError("TICKET_NOT_FOUND", 404);
  if (record.state !== "ISSUED") throw new EnrollmentTicketError("TICKET_NOT_CLAIMABLE", 409);
  if (Number(now_ms) >= Date.parse(record.expires_at)) throw new EnrollmentTicketError("TICKET_EXPIRED", 410);
  if (!DIGEST_RE.test(String(preflight_digest ?? ""))) throw new EnrollmentTicketError("PREFLIGHT_DIGEST_REQUIRED", 409);
  if (!CODE_RE.test(String(short_code ?? "")) || !safeDigestEqual(record.short_code_digest, sha256Text(short_code))) {
    const failed_claims = Number(record.failed_claims ?? 0) + 1;
    const terminal = failed_claims >= max_failed_claims;
    return Object.freeze({
      ok: false,
      code: terminal ? "TICKET_LOCKED" : "TICKET_SHORT_CODE_INVALID",
      status: 403,
      record: Object.freeze({ ...record, failed_claims, state: terminal ? "REVOKED" : record.state, reason_code: terminal ? "TOO_MANY_FAILED_CLAIMS" : record.reason_code }),
    });
  }
  return Object.freeze({ ok: true });
}

export function validateClaimMaterial(material) {
  if (!material || material.outcome !== "READY") return material;
  const delivery = material.delivery;
  if (!delivery || typeof delivery !== "object") throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  if (typeof delivery.resume_session !== "string" || delivery.resume_session.length < 32 || delivery.resume_session.length > 256) throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  if (typeof delivery.auth_key !== "string" || delivery.auth_key.length < 8 || delivery.auth_key.length > 512) throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  if (!["provisional", "canonical"].includes(delivery.identity_kind)) throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  if (typeof delivery.node_id !== "string" || !delivery.node_id || delivery.node_id.length > 128) throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  if (delivery.identity_kind === "provisional") {
    if (typeof delivery.enrollment_id !== "string" || !/^enroll-[0-9a-f-]{36}$/.test(delivery.enrollment_id)) throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
    if (delivery.node_uid) throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  } else if (typeof delivery.node_uid !== "string" || !delivery.node_uid) {
    throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  }
  return material;
}

export function completionDigest(report) {
  return sha256Text(JSON.stringify(report));
}
