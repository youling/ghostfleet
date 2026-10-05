#!/usr/bin/env bash
#
# Youling Fleet — Canonical Public Bootstrap
# version: 0.2.1
#
# Provenance: adapted from public v0.1 candidate
# Source: packaged GhostFleet runtime resource; select an exact published revision.
#   SHA256: 3b5c62645d22f1a74459a0bedb7ca92498f6c3633f6b118d94986b561f8a084f
#
# Supported:
#   Debian / Ubuntu
#   CentOS / RHEL / Rocky / AlmaLinux / Oracle Linux / Fedora
#
# This script intentionally DOES NOT:
#   - authenticate or join a tailnet (Tailscale enrollment)
#   - create a Cloudflare Tunnel service
#   - authenticate GitHub CLI
#   - change SSH daemon configuration
#   - close public SSH
#   - modify firewall rules
#   - set/reset passwords
#   - embed GitHub/Tailscale/Cloudflare secrets
#   - create DSH / node-observer / Agent Host state
#

set -Eeuo pipefail
IFS=$'\n\t'
umask 027

BOOTSTRAP_VERSION="0.2.1"

# ---------------------------------------------------------------------------
# Mode
# ---------------------------------------------------------------------------

MODE=""

usage() {
    cat <<'EOF'
Usage: bootstrap.sh [OPTIONS]

Options:
  --check          Read-only preflight; perform no host mutation.
  --apply          Apply bootstrap changes. Required for any host mutation.
  --print-repo-plan
                   Read-only diagnostic: print the deterministic distro repo
                   selection plan for the detected OS, then exit. No mutation,
                   no root, and no network required.
  --help           Show this help and exit.

A mode flag is required. Invoking with no arguments prints usage and exits non-zero.

Environment variables:
  FLEET_NODE_ID        Override detected node identifier (optional).
  FLEET_ROLE           Assign a role label written to node.conf (default: unassigned).
  FLEET_OS_RELEASE     Override path of the os-release file (default: /etc/os-release).
                       Deterministic test/verification hook only.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check)
            MODE="check"
            shift
            ;;
        --apply)
            MODE="apply"
            shift
            ;;
        --print-repo-plan)
            MODE="print-repo-plan"
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            printf '[fleet][ERROR] Unknown option: %s\n' "$1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [[ -z "${MODE}" ]]; then
    printf '[fleet][ERROR] No mode specified. Use --check or --apply.\n' >&2
    usage >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

LOG_FILE="/var/log/youling-fleet-bootstrap.log"
FLEET_ETC="/etc/youling-fleet"
FLEET_STATE="/var/lib/youling-fleet"

log() {
    printf '[fleet] %s\n' "$*"
}

warn() {
    printf '[fleet][WARN] %s\n' "$*" >&2
}

die() {
    printf '[fleet][ERROR] %s\n' "$*" >&2
    exit 1
}

# ---------------------------------------------------------------------------
# OS detection (deterministic; feeds --check, --apply and --print-repo-plan)
# ---------------------------------------------------------------------------

OS_RELEASE_FILE="${FLEET_OS_RELEASE:-/etc/os-release}"
[[ -r "${OS_RELEASE_FILE}" ]] || die "Cannot read ${OS_RELEASE_FILE}"

# shellcheck disable=SC1090
source "${OS_RELEASE_FILE}"

OS_ID="${ID,,}"
OS_VERSION="${VERSION_ID:-unknown}"

case "${OS_ID}" in
    debian|ubuntu)
        OS_FAMILY="deb"
        ;;
    centos|rhel|rocky|almalinux|ol|fedora)
        OS_FAMILY="rpm"
        ;;
    *)
        die "Unsupported OS: ${OS_ID} ${OS_VERSION}"
        ;;
esac

ARCH="$(uname -m)"

case "${ARCH}" in
    x86_64|amd64|aarch64|arm64)
        ;;
    *)
        die "Unsupported architecture: ${ARCH}"
        ;;
esac

# ---------------------------------------------------------------------------
# Tailscale repo selection — deterministic per /etc/os-release ID/version.
# Mirrors Tailscale's official supported vendor paths:
#   debian -> stable/debian/<codename>        ubuntu -> stable/ubuntu/<codename>
#   centos -> stable/centos/<major>           rhel   -> stable/rhel/<major>
#   ol     -> stable/oracle/<major>           fedora -> stable/fedora
#   rocky / almalinux -> stable/fedora  (Tailscale publishes these under fedora)
# Unsupported or indeterminate combinations fail closed.
# ---------------------------------------------------------------------------

TS_REPO_FAMILY=""
TS_REPO_VERSION=""

select_tailscale_repo() {
    local id="$1"
    local codename="${2:-}"
    local version="${3:-}"
    local major=""

    case "${id}" in
        debian)
            [[ -n "${codename}" ]] \
                || die "Cannot determine VERSION_CODENAME for Debian Tailscale repo (os-release: ${OS_RELEASE_FILE})"
            TS_REPO_FAMILY="debian"
            TS_REPO_VERSION="${codename}"
            ;;
        ubuntu)
            [[ -n "${codename}" ]] \
                || die "Cannot determine VERSION_CODENAME for Ubuntu Tailscale repo (os-release: ${OS_RELEASE_FILE})"
            TS_REPO_FAMILY="ubuntu"
            TS_REPO_VERSION="${codename}"
            ;;
        centos|rhel|ol)
            major="${version%%.*}"
            [[ "${major}" =~ ^[0-9]+$ ]] \
                || die "Cannot determine numeric major VERSION_ID for ${id} Tailscale repo (VERSION_ID=${version:-unset})"
            case "${id}" in
                centos) TS_REPO_FAMILY="centos" ;;
                rhel)   TS_REPO_FAMILY="rhel" ;;
                ol)     TS_REPO_FAMILY="oracle" ;;
            esac
            TS_REPO_VERSION="${major}"
            ;;
        fedora|rocky|almalinux)
            # Tailscale publishes Rocky and AlmaLinux under the fedora repo path.
            TS_REPO_FAMILY="fedora"
            TS_REPO_VERSION=""
            ;;
        *)
            die "Unsupported OS for Tailscale repo selection: ${id}"
            ;;
    esac
}

select_tailscale_repo "${OS_ID}" "${VERSION_CODENAME:-}" "${VERSION_ID:-}"

if [[ "${OS_FAMILY}" == "deb" ]]; then
    TS_KEY_URL="https://pkgs.tailscale.com/stable/${TS_REPO_FAMILY}/${TS_REPO_VERSION}.noarmor.gpg"
    TS_LIST_URL="https://pkgs.tailscale.com/stable/${TS_REPO_FAMILY}/${TS_REPO_VERSION}.tailscale-keyring.list"
    TS_RPM_REPO_URL=""
else
    TS_KEY_URL=""
    TS_LIST_URL=""
    if [[ -n "${TS_REPO_VERSION}" ]]; then
        TS_RPM_REPO_URL="https://pkgs.tailscale.com/stable/${TS_REPO_FAMILY}/${TS_REPO_VERSION}/tailscale.repo"
    else
        TS_RPM_REPO_URL="https://pkgs.tailscale.com/stable/${TS_REPO_FAMILY}/tailscale.repo"
    fi
fi

# ---------------------------------------------------------------------------
# Read-only diagnostic: repo selection plan
# ---------------------------------------------------------------------------

if [[ "${MODE}" == "print-repo-plan" ]]; then
    printf 'repo_plan os_id=%s\n' "${OS_ID}"
    printf 'repo_plan os_version=%s\n' "${OS_VERSION}"
    printf 'repo_plan os_family=%s\n' "${OS_FAMILY}"
    printf 'repo_plan tailscale_repo_family=%s\n' "${TS_REPO_FAMILY}"
    printf 'repo_plan tailscale_repo_version=%s\n' "${TS_REPO_VERSION}"
    printf 'repo_plan tailscale_key_url=%s\n' "${TS_KEY_URL}"
    printf 'repo_plan tailscale_list_url=%s\n' "${TS_LIST_URL}"
    printf 'repo_plan tailscale_rpm_repo_url=%s\n' "${TS_RPM_REPO_URL}"
    exit 0
fi

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

if [[ "${EUID}" -ne 0 ]]; then
    die "Must be run as root or via sudo."
fi

command -v systemctl >/dev/null 2>&1 \
    || die "systemd/systemctl required; this bootstrap does not support non-systemd systems."

# ---------------------------------------------------------------------------
# Mode gate: setup logging only in apply mode
# ---------------------------------------------------------------------------

if [[ "${MODE}" == "apply" ]]; then
    mkdir -p "${FLEET_ETC}" "${FLEET_STATE}"
    touch "${LOG_FILE}"
    chmod 0640 "${LOG_FILE}"
    exec > >(tee -a "${LOG_FILE}") 2>&1
fi

log "Youling Fleet Bootstrap v${BOOTSTRAP_VERSION} (mode=${MODE})"

# ---------------------------------------------------------------------------
# Node identity (detection only; enrollment assigns final identity)
# ---------------------------------------------------------------------------

FLEET_NODE_ID="${FLEET_NODE_ID:-}"
FLEET_ROLE="${FLEET_ROLE:-unassigned}"

if [[ -z "${FLEET_NODE_ID}" ]]; then
    FLEET_NODE_ID="$(hostname -s 2>/dev/null || hostname)"
fi

FLEET_NODE_ID="$(
    printf '%s' "${FLEET_NODE_ID}" |
        tr '[:upper:]' '[:lower:]' |
        sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//'
)"

[[ -n "${FLEET_NODE_ID}" ]] || die "Cannot derive a valid node_id"

log "node_id=${FLEET_NODE_ID}"
log "role=${FLEET_ROLE}"
log "os=${OS_ID} ${OS_VERSION}"
log "arch=${ARCH}"
log "os_family=${OS_FAMILY}"
log "tailscale_repo_family=${TS_REPO_FAMILY}"
log "tailscale_repo_version=${TS_REPO_VERSION}"

# ---------------------------------------------------------------------------
# Preflight summary (--check only)
# ---------------------------------------------------------------------------

if [[ "${MODE}" == "check" ]]; then
    log "Preflight (--check): reporting system state without mutation."
    log "  OS: ${OS_ID} ${OS_VERSION} (${OS_FAMILY})"
    log "  Arch: ${ARCH}"
    log "  node_id: ${FLEET_NODE_ID}"
    log "  tailscale_repo_family: ${TS_REPO_FAMILY}"
    log "  tailscale_repo_version: ${TS_REPO_VERSION}"

    for cmd in curl git sudo systemctl; do
        if command -v "${cmd}" >/dev/null 2>&1; then
            log "  ${cmd}: available"
        else
            warn "  ${cmd}: NOT found (would be installed in --apply)"
        fi
    done

    for cmd in tailscale cloudflared gh; do
        if command -v "${cmd}" >/dev/null 2>&1; then
            log "  ${cmd}: available"
        else
            log "  ${cmd}: not installed (optional; would be installed in --apply)"
        fi
    done

    log "Preflight complete. No changes made."
    exit 0
fi

# ---------------------------------------------------------------------------
# Package helpers (apply mode)
# ---------------------------------------------------------------------------

if [[ "${OS_FAMILY}" == "deb" ]]; then

    export DEBIAN_FRONTEND=noninteractive

    apt-get update -y
    apt-get install -y \
        curl \
        ca-certificates \
        git \
        sudo \
        gnupg

else

    if command -v dnf >/dev/null 2>&1; then
        RPM_PM="dnf"
    elif command -v yum >/dev/null 2>&1; then
        RPM_PM="yum"
    else
        die "No dnf/yum found"
    fi

    "${RPM_PM}" -y install \
        curl \
        ca-certificates \
        git \
        sudo
fi

# ---------------------------------------------------------------------------
# Tailscale — binary installation only (no enrollment)
# Repo selection is deterministic per OS_ID/version (see select_tailscale_repo).
# ---------------------------------------------------------------------------

log "Tailscale — checking installation..."

if ! command -v tailscale >/dev/null 2>&1; then

    if [[ "${OS_FAMILY}" == "deb" ]]; then

        install -d -m 0755 /usr/share/keyrings

        curl -fsSL "${TS_KEY_URL}" \
            -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
            || die "Failed to fetch Tailscale GPG key for ${TS_REPO_FAMILY}/${TS_REPO_VERSION}"

        chmod 0644 /usr/share/keyrings/tailscale-archive-keyring.gpg

        curl -fsSL "${TS_LIST_URL}" \
            -o /etc/apt/sources.list.d/tailscale.list \
            || die "Failed to fetch Tailscale apt source list for ${TS_REPO_FAMILY}/${TS_REPO_VERSION}"

        apt-get update -y
        apt-get install -y tailscale \
            || die "Failed to install tailscale from apt"

    else

        curl -fsSL "${TS_RPM_REPO_URL}" \
            -o /etc/yum.repos.d/tailscale.repo \
            || die "Failed to fetch Tailscale repo for ${TS_REPO_FAMILY}/${TS_REPO_VERSION}"

        "${RPM_PM}" -y install tailscale \
            || die "Failed to install tailscale from ${RPM_PM}"

    fi

    log "Tailscale binary installed."
else
    log "Tailscale already installed, skipping."
fi

systemctl enable --now tailscaled \
    || die "Failed to enable tailscaled"

log "Tailscale binary ready. Enrollment is handled separately (see enrollment.md)."

# ---------------------------------------------------------------------------
# Cloudflared — binary installation only (no tunnel enrollment)
# ---------------------------------------------------------------------------

INSTALL_CLOUDFLARED="${INSTALL_CLOUDFLARED:-1}"

if [[ "${INSTALL_CLOUDFLARED}" == "1" ]]; then

    log "cloudflared — checking installation..."

    if ! command -v cloudflared >/dev/null 2>&1; then

        if [[ "${OS_FAMILY}" == "deb" ]]; then

            install -d -m 0755 /usr/share/keyrings

            curl -fsSL \
                https://pkg.cloudflare.com/cloudflare-main.gpg \
                -o /usr/share/keyrings/cloudflare-main.gpg \
                || die "Failed to fetch Cloudflare GPG key"

            chmod 0644 /usr/share/keyrings/cloudflare-main.gpg

            cat > /etc/apt/sources.list.d/cloudflared.list <<'CFEOF'
deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main
CFEOF

            apt-get update -y
            apt-get install -y cloudflared \
                || die "Failed to install cloudflared from apt"

        else

            curl -fsSL \
                https://pkg.cloudflare.com/cloudflared.repo \
                -o /etc/yum.repos.d/cloudflared.repo \
                || die "Failed to fetch Cloudflare repo definition"

            "${RPM_PM}" -y install cloudflared \
                || die "Failed to install cloudflared from ${RPM_PM}"

        fi

        log "cloudflared binary installed."
    else
        log "cloudflared already installed, skipping."
    fi

    log "cloudflared binary ready. Tunnel enrollment is handled separately (see enrollment.md)."
fi

# ---------------------------------------------------------------------------
# GitHub CLI — binary installation only (no authentication)
# ---------------------------------------------------------------------------

INSTALL_GH="${INSTALL_GH:-1}"

if [[ "${INSTALL_GH}" == "1" ]]; then

    log "GitHub CLI — checking installation..."

    if ! command -v gh >/dev/null 2>&1; then

        if [[ "${OS_FAMILY}" == "deb" ]]; then

            install -d -m 0755 /etc/apt/keyrings

            curl -fsSL \
                https://cli.github.com/packages/githubcli-archive-keyring.gpg \
                -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
                || die "Failed to fetch GitHub CLI GPG key"

            chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg

            GH_ARCH="$(dpkg --print-architecture)"

            cat > /etc/apt/sources.list.d/github-cli.list <<GHEOF
deb [arch=${GH_ARCH} signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main
GHEOF

            apt-get update -y
            apt-get install -y gh \
                || die "Failed to install gh from apt"

        else

            curl -fsSL \
                https://cli.github.com/packages/rpm/gh-cli.repo \
                -o /etc/yum.repos.d/gh-cli.repo \
                || die "Failed to fetch GitHub CLI repo definition"

            "${RPM_PM}" -y install gh \
                || die "Failed to install gh from ${RPM_PM}"

        fi

        log "GitHub CLI installed."
    else
        log "GitHub CLI already installed, skipping."
    fi

    log "GitHub CLI ready. Authentication is handled separately (see enrollment.md)."
fi

# ---------------------------------------------------------------------------
# Durable local node descriptor (NO SECRETS)
# ---------------------------------------------------------------------------

log "Writing local node descriptor..."

cat > "${FLEET_ETC}/node.conf" <<EOF
node_id=${FLEET_NODE_ID}
role=${FLEET_ROLE}
os_id=${OS_ID}
os_version=${OS_VERSION}
os_family=${OS_FAMILY}
arch=${ARCH}
bootstrap_version=${BOOTSTRAP_VERSION}
EOF

chmod 0644 "${FLEET_ETC}/node.conf"

# ---------------------------------------------------------------------------
# Local report
# ---------------------------------------------------------------------------

{
    echo "YOULING_FLEET_BOOTSTRAP_REPORT"
    echo "node_id=${FLEET_NODE_ID}"
    echo "role=${FLEET_ROLE}"
    echo "os=${OS_ID}"
    echo "os_version=${OS_VERSION}"
    echo "os_family=${OS_FAMILY}"
    echo "arch=${ARCH}"
    echo "bootstrap_version=${BOOTSTRAP_VERSION}"
    echo "mode=${MODE}"

    if command -v tailscale >/dev/null 2>&1; then
        echo "tailscale_version=$(tailscale version | head -n1)"
        echo "tailscaled_active=$(systemctl is-active tailscaled 2>/dev/null || true)"
    fi

    if command -v cloudflared >/dev/null 2>&1; then
        echo "cloudflared_version=$(cloudflared --version 2>/dev/null | head -n1 || true)"
    fi

    if command -v gh >/dev/null 2>&1; then
        echo "gh_version=$(gh --version | head -n1)"
    fi

    echo "git_version=$(git --version)"
} > "${FLEET_STATE}/bootstrap-report.txt"

chmod 0644 "${FLEET_STATE}/bootstrap-report.txt"

# ---------------------------------------------------------------------------
# Final
# ---------------------------------------------------------------------------

echo
echo "============================================================"
echo " Youling Fleet Bootstrap v${BOOTSTRAP_VERSION} complete"
echo "============================================================"
echo
echo "Node:     ${FLEET_NODE_ID}"
echo "Role:     ${FLEET_ROLE}"
echo "OS:       ${OS_ID} ${OS_VERSION} (${OS_FAMILY})"
echo "Arch:     ${ARCH}"
echo
echo "Config:   ${FLEET_ETC}/node.conf"
echo "Report:   ${FLEET_STATE}/bootstrap-report.txt"
echo "Log:      ${LOG_FILE}"
echo
echo "Next: enrollment (Tailscale join, tunnel, identity) is a"
echo "      separate private step — see enrollment.md."
echo