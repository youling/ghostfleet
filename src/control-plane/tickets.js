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
// It carries exactly three pinned coordinates: the public immutable asset origin,
// the expected SHA-256 of the bootstrap courier, and the enrollment origin that
// must own the one-time ticket URL. The bootstrap is downloaded from
// <assets_origin>/sha256/<digest>, verified against the pinned digest, and only
// then executed. Root elevation happens before that download; the Human pastes
// the one-time URL into the protected root terminal, with terminal echo disabled,
// and the script then asks for the separate eight-digit short code.
//
// The two origins are never interchangeable. The asset origin serves public,
// content-addressed, read-only material and needs no Access login; the enrollment
// origin exposes only the claim/complete bridge. A ticket URL minted on the asset
// origin (or any other host) is refused before the bootstrap runs, so a
// compromised or mistyped delivery cannot redirect the one-time material.
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
const TRUSTED_SHA256SUM = "/usr/bin/sha256sum";
const TRUSTED_RM = "/bin/rm";
const BROWSER_PREFIX = "/v1/enrollment-tickets/";
const TICKET_ID_PATTERN = /^ticket-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOOTSTRAP_DIGEST = /^[0-9a-f]{64}$/;

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
  'CALLER_UID="$("$TRUSTED_ID" -u 2>/dev/null)"',
'case "$CALLER_UID" in',
"  ''|*[!0-9]*) printf '%s\\n' 'GhostFleet cannot determine the invoking account id from /usr/bin/id' >&2; exit 1 ;;",
'esac',
'if [ "$CALLER_UID" -ne 0 ]; then',
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


function portableBootstrapCommand({ assets_origin, enroll_origin, bootstrap_sha256 }) {
  const downloadUrl = assets_origin + "/sha256/" + bootstrap_sha256;
  // The download scheme is pinned by the validated origin. A redirect or a
  // scheme downgrade is a hard failure, never a silent second source.
  const proto = assets_origin.startsWith("https://") ? "=https" : "=http";
  const ticket_prefix = enroll_origin + BROWSER_PREFIX;
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
    // No redirect following, and an explicit status check: without -L a 3xx is
    // a final response, so curl's exit code alone cannot tell a redirect from
    // the pinned object. Only a direct 2xx body is ever considered.
    '  if ! HTTP_CODE="$(' + TRUSTED_CURL + " --fail --silent --show-error --no-location --max-redirs 0 --proto " + quoteShell(proto) + ' --connect-timeout 15 --max-time 120 --write-out \'%{http_code}\' --output "$BOOTSTRAP" ' + quoteShell(downloadUrl) + ')"; then',
    "    printf '%s\\n' 'GhostFleet bootstrap download failed: the pinned content address must answer with a direct 2xx; redirects, 4xx and 5xx are refused and nothing was executed' >&2",
    "    exit 1",
    "  fi",
    '  case "$HTTP_CODE" in',
    '    2[0-9][0-9]) ;;',
    "    *) printf '%s\\n' \"GhostFleet bootstrap download was refused: HTTP $HTTP_CODE from the pinned content address; redirects are not followed and nothing was executed\" >&2; exit 1 ;;",
    "  esac",
    "elif [ -x " + TRUSTED_WGET + " ]; then",
    "  if ! " + TRUSTED_WGET + ' --quiet --max-redirect=0 --timeout=120 --output-document="$BOOTSTRAP" ' + quoteShell(downloadUrl) + "; then",
    "    printf '%s\\n' 'GhostFleet bootstrap download failed: the pinned content address must answer with a direct 2xx; redirects, 4xx and 5xx are refused and nothing was executed' >&2",
    "    exit 1",
    "  fi",
    "else",
    "  printf '%s\\n' 'GhostFleet requires curl or wget' >&2",
    "  exit 1",
    "fi",
    'if [ ! -s "$BOOTSTRAP" ]; then',
    "  printf '%s\\n' 'GhostFleet bootstrap download is empty' >&2",
    "  exit 1",
    "fi",
    // Unknown bytes are never executed as root: the pinned digest is checked
    // before the terminal prompt, before the enrollment URL is known, and before
    // any byte of the download can run.
    "EXPECTED_SHA256=" + quoteShell(bootstrap_sha256),
    'if ! ACTUAL_SHA256="$(' + TRUSTED_SHA256SUM + ' "$BOOTSTRAP")"; then',
    "  printf '%s\\n' 'GhostFleet bootstrap integrity check could not run: " + TRUSTED_SHA256SUM + " is required' >&2",
    "  exit 1",
    "fi",
    'ACTUAL_SHA256="${ACTUAL_SHA256%% *}"',
    'if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then',
    "  printf 'GhostFleet bootstrap integrity check failed: expected sha256 %s, got %s; nothing was executed\\n' \"$EXPECTED_SHA256\" \"${ACTUAL_SHA256:-missing}\" >&2",
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
    "ENROLL_PREFIX=" + quoteShell(ticket_prefix),
    'case "$GHOSTFLEET_ENROLLMENT_URL" in',
    '  ' + quoteShell(ticket_prefix) + '*) TICKET_ID="${GHOSTFLEET_ENROLLMENT_URL#"$ENROLL_PREFIX"}" ;;',
    "  *) printf '%s\\n' 'Invalid enrollment URL for this enrollment origin' >&2; exit 1 ;;",
    "esac",
    // The origin is not enough: the remainder must be exactly one ticket id and
    // nothing else, so a path, query or extra segment cannot reach the bridge.
    'printf "%s" "$TICKET_ID" | grep -Eq ' + quoteShell(TICKET_ID_PATTERN.source) + " || { printf '%s\\n' 'Invalid enrollment URL for this enrollment origin' >&2; exit 1; }",
    "export GHOSTFLEET_ENROLLMENT_URL",
    // The asset origin is a fixed assignment in the delivered command. It is
    // never derived from the ticket URL or from the claim response.
    "GHOSTFLEET_ASSETS_ORIGIN=" + quoteShell(assets_origin),
    "export GHOSTFLEET_ASSETS_ORIGIN",
    // The bootstrap validates this name again before anything becomes its owner.
    'GHOSTFLEET_OPERATING_USER="${1-}"',
    "export GHOSTFLEET_OPERATING_USER",
    TRUSTED_SHELL + ' "$BOOTSTRAP"',
  ].join("\n");
  const elevated = cleanRootShell(rootScript);
  return [
    "(",
    OPERATING_USER_CAPTURE,
    'if [ "$CALLER_UID" -eq 0 ]; then',
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

export function validateBootstrapDigest(value) {
  const raw = String(value ?? "").trim().replace(/^sha256:/, "");
  if (!BOOTSTRAP_DIGEST.test(raw)) throw new EnrollmentTicketError("BOOTSTRAP_DIGEST_INVALID");
  return raw;
}

function validateDeliveryOrigin(value, code) {
  try {
    return validatePublicOrigin(value);
  } catch {
    throw new EnrollmentTicketError(code);
  }
}

/**
 * The immutable-material origin and the enrollment bridge are two different
 * public surfaces. They are validated independently and must not collapse into
 * one origin: otherwise the digest-checked bootstrap would be served by the
 * Access-protected console, or the one-time ticket would be minted on the
 * unauthenticated asset host.
 */
export function validateDeliveryCoordinates({ assets_origin, enroll_origin, bootstrap_sha256 } = {}) {
  const assets = validateDeliveryOrigin(assets_origin, "ASSETS_ORIGIN_INVALID");
  const enroll = validateDeliveryOrigin(enroll_origin, "ENROLL_ORIGIN_INVALID");
  if (assets === enroll) throw new EnrollmentTicketError("DELIVERY_ORIGINS_NOT_SEPARATED");
  return Object.freeze({
    assets_origin: assets,
    enroll_origin: enroll,
    bootstrap_sha256: validateBootstrapDigest(bootstrap_sha256),
  });
}

/**
 * Build the single authoritative one-click delivery.
 *
 * The caller supplies the deployment coordinates and the ticket identity:
 *   { assets_origin, enroll_origin, bootstrap_sha256, ticket_id | record }
 *
 * `public_origin` is accepted only as a legacy alias for `enroll_origin` (the
 * bridge that owns the ticket URL). It is never the Console/Access origin: a
 * ticket URL minted on the Access-protected console could not be claimed by a
 * node that has not enrolled yet.
 *
 * The result exposes every input back (assets_origin, enroll_origin,
 * bootstrap_sha256) so a deployment can compare byte-for-byte in CI instead of
 * maintaining a second, hand-written command.
 */
export function createTicketDelivery({
  record = null, ticket_id = null, short_code, assets_origin,
  enroll_origin = null, public_origin = null, bootstrap_sha256,
}) {
  const id = ticket_id ?? record?.ticket_id;
  if (!TICKET_ID_PATTERN.test(String(id ?? ""))) throw new EnrollmentTicketError("TICKET_ID_INVALID");
  const coordinates = validateDeliveryCoordinates({
    assets_origin,
    enroll_origin: enroll_origin ?? public_origin,
    bootstrap_sha256,
  });
  const one_time_url = coordinates.enroll_origin + BROWSER_PREFIX + encodeURIComponent(id);
  return Object.freeze({
    protocol: "ghostfleet-enrollment-delivery/v1",
    one_time_url,
    short_code,
    expires_at: record?.expires_at ?? null,
    assets_origin: coordinates.assets_origin,
    enroll_origin: coordinates.enroll_origin,
    bootstrap_sha256: coordinates.bootstrap_sha256,
    command: portableBootstrapCommand(coordinates),
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
