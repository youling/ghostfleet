#!/usr/bin/python3
# GhostFleet presence v1 — standard-library client; no remote command protocol.
"""One-shot reporting and one-time installation. Never configures SSH/providers."""
from __future__ import annotations
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = '1'
UID = re.compile(r'node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
TICKET = re.compile(r'ticket-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
TOKEN = re.compile(r'gf_hb_[A-Za-z0-9_-]{43}')
UNIT = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.@:-]{0,120}\.service')
DEFAULT_UNITS = {'ssh': 'ssh.service', 'cloudflared': 'cloudflared-ssh.service', 'tailscaled': 'tailscaled.service'}
ACTIVE_STATES = {'active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading'}
CONFIG = Path('/etc/ghostfleet/presence.json')
MANIFEST = Path('/etc/ghostfleet/presence-install.json')
SCRIPT = Path('/usr/local/libexec/ghostfleet-heartbeat.py')
SERVICE_SNAPSHOT = Path('/run/ghostfleet-heartbeat-services.json')
SERVICE_SNAPSHOT_PROTOCOL = 'ghostfleet-service-observation/v1'
SERVICE = Path('/etc/systemd/system/ghostfleet-heartbeat.service')
TIMER = Path('/etc/systemd/system/ghostfleet-heartbeat.timer')
MARKER = '# GhostFleet presence v1'
SERVICE_TEXT = '''# GhostFleet presence v1
[Unit]
Description=GhostFleet one-shot presence report
After=network.target

[Service]
Type=oneshot
DynamicUser=yes
LoadCredential=presence.json:/etc/ghostfleet/presence.json
# systemd opens this root-owned snapshot before applying the service sandbox.
# The pre-probe writes only to this file; the DynamicUser reporter reads it.
# "-" keeps heartbeat reporting alive if the local read-only probe fails.
ExecStartPre=-!/usr/bin/python3 -I /usr/local/libexec/ghostfleet-heartbeat.py probe
ExecStart=/usr/bin/python3 -I /usr/local/libexec/ghostfleet-heartbeat.py report --service-state-file /run/ghostfleet-heartbeat-services.json
TimeoutStartSec=40
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/run/ghostfleet-heartbeat-services.json
UMask=0077
StandardOutput=file:/run/ghostfleet-heartbeat-services.json
StandardError=journal
SyslogIdentifier=ghostfleet-heartbeat
'''
TIMER_TEXT = '''# GhostFleet presence v1
[Unit]
Description=GhostFleet presence timer

[Timer]
OnBootSec=30s
OnUnitInactiveSec=60s
RandomizedDelaySec=5s
AccuracySec=1s
Unit=ghostfleet-heartbeat.service

[Install]
WantedBy=timers.target
'''

class ClientError(Exception):
    """Messages are fixed diagnostic codes, never server bodies or credentials."""

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ClientError('REDIRECT_REFUSED')

def check_origin(value: str, allow_loopback: bool = False) -> str:
    try:
        u = urllib.parse.urlsplit(value)
        loopback = allow_loopback and u.scheme == 'http' and u.hostname in ('127.0.0.1', '::1')
        if (u.scheme != 'https' and not loopback) or not u.hostname or u.username or u.password or u.query or u.fragment or u.path:
            raise ValueError()
        _ = u.port
    except (ValueError, TypeError):
        raise ClientError('INVALID_ORIGIN') from None
    return value

def post_json(origin: str, path: str, body: dict, token: str | None = None,
              allow_loopback: bool = False) -> dict:
    check_origin(origin, allow_loopback)
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'GhostFleet-Reporter/1'}
    if token:
        if not TOKEN.fullmatch(token): raise ClientError('INVALID_REPORTING_TOKEN')
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(origin + path, json.dumps(body, separators=(',', ':')).encode(), headers, method='POST')
    # Do not forward Authorization through any redirect or silently use a proxy
    # inherited from the calling shell. The deployed HTTPS origin is explicit.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(req, timeout=12) as response:
            if response.status != 200: raise ClientError('UNEXPECTED_HTTP_STATUS')
            if response.headers.get_content_type() != 'application/json': raise ClientError('INVALID_RESPONSE_TYPE')
            raw = response.read(4097)
        if len(raw) > 4096: raise ClientError('RESPONSE_TOO_LARGE')
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get('ok') is not True: raise ClientError('INVALID_RESPONSE')
        return data
    except urllib.error.HTTPError as error:
        raise ClientError('HTTP_REJECT_' + str(error.code)) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ClientError('NETWORK_OR_TLS_FAILURE') from None
    except (ValueError, UnicodeError):
        raise ClientError('INVALID_RESPONSE') from None

def validate_config(config: dict, allow_loopback: bool = False) -> dict:
    if not isinstance(config, dict) or set(config) != {'origin', 'node_uid', 'reporting_token', 'units'}:
        raise ClientError('INVALID_CONFIG')
    check_origin(config['origin'], allow_loopback)
    if not isinstance(config['node_uid'], str) or not UID.fullmatch(config['node_uid']): raise ClientError('INVALID_NODE_UID')
    if not isinstance(config['reporting_token'], str) or not TOKEN.fullmatch(config['reporting_token']): raise ClientError('INVALID_REPORTING_TOKEN')
    units = config['units']
    if not isinstance(units, dict) or set(units) != set(DEFAULT_UNITS) or any(not isinstance(v, str) or not UNIT.fullmatch(v) for v in units.values()):
        raise ClientError('INVALID_UNIT_MAP')
    return config

def credential_mode_ok(info: os.stat_result) -> bool:
    # systemd 257 delivers LoadCredential files as 0440 under system-level
    # DynamicUser: allow group-read, still refuse group write/execute and any
    # access by others.
    return stat.S_ISREG(info.st_mode) and not info.st_mode & 0o037

def load_config(path: Path, allow_loopback: bool = False) -> dict:
    if path.is_symlink(): raise ClientError('CONFIG_SYMLINK_REFUSED')
    info = path.stat()
    if not credential_mode_ok(info) or info.st_size > 16384:
        raise ClientError('CONFIG_PERMISSIONS_OR_SIZE')
    try: return validate_config(json.loads(path.read_text()), allow_loopback)
    except (ValueError, UnicodeError): raise ClientError('INVALID_CONFIG') from None

def service_state(unit: str, runner=subprocess.run) -> str:
    if not UNIT.fullmatch(unit): raise ClientError('INVALID_UNIT')
    try:
        p = runner(['/usr/bin/systemctl', '--system', 'show', '--property=LoadState', '--property=ActiveState', '--', unit],
                   capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired): return 'unknown'
    fields = dict(line.split('=', 1) for line in p.stdout.splitlines() if '=' in line)
    if fields.get('LoadState') == 'not-found': return 'not_found'
    if p.returncode or fields.get('LoadState') != 'loaded': return 'unknown'
    active = fields.get('ActiveState')
    return active if active in ACTIVE_STATES else 'unknown'

def service_snapshot_file_ok(info: os.stat_result) -> bool:
    return (stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
            stat.S_IMODE(info.st_mode) == 0o644 and info.st_size <= 4096)

def read_service_snapshot(path: Path, units: dict) -> dict:
    unknown = {role: 'unknown' for role in units}
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0))
        with os.fdopen(fd, 'rb') as stream:
            fd = None
            if not service_snapshot_file_ok(os.fstat(stream.fileno())):
                return unknown
            raw = stream.read(4097)
        if len(raw) > 4096:
            return unknown
        data = json.loads(raw)
        if not isinstance(data, dict) or set(data) != {'protocol', 'observed_at', 'services'} or data['protocol'] != SERVICE_SNAPSHOT_PROTOCOL:
            return unknown
        observed_at = data['observed_at']
        if (isinstance(observed_at, bool) or not isinstance(observed_at, (int, float)) or
                not 0 <= time.monotonic() - observed_at <= 30):
            return unknown
        services = data['services']
        if not isinstance(services, dict) or set(services) != set(units):
            return unknown
        if any(not isinstance(value, str) or value not in ACTIVE_STATES | {'not_found', 'unknown'}
               for value in services.values()):
            return unknown
        return dict(services)
    except (OSError, ValueError, TypeError, UnicodeError):
        return unknown
    finally:
        if fd is not None:
            os.close(fd)

def probe() -> None:
    # ExecStartPre=! runs this fixed, read-only probe with UID 0 so systemctl
    # uses systemd's private local API instead of the DynamicUser D-Bus identity
    # path. The process still has CapabilityBoundingSet= empty and the unit's
    # filesystem/network sandbox; it never accepts a command or unit from a peer.
    if os.geteuid() != 0:
        raise ClientError('SERVICE_PROBE_REQUIRES_ROOT')
    try:
        fd = sys.stdout.fileno()
        info = os.fstat(fd)
        path_info = SERVICE_SNAPSHOT.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                not stat.S_ISREG(path_info.st_mode) or path_info.st_uid != 0 or
                (info.st_dev, info.st_ino) != (path_info.st_dev, path_info.st_ino)):
            raise ClientError('SERVICE_PROBE_OUTPUT_UNSAFE')
        # systemd opens StandardOutput=file: as the manager (root) before the
        # service sandbox. Keep the file root-owned, but readable by DynamicUser.
        os.fchmod(fd, 0o644)
        os.ftruncate(fd, 0)
        os.lseek(fd, 0, os.SEEK_SET)
    except (OSError, ValueError):
        raise ClientError('SERVICE_PROBE_OUTPUT_UNAVAILABLE') from None
    config_path = Path(os.getenv('CREDENTIALS_DIRECTORY', str(CONFIG.parent))) / 'presence.json'
    config = load_config(config_path)
    services = {role: service_state(unit) for role, unit in config['units'].items()}
    payload = json.dumps({'protocol': SERVICE_SNAPSHOT_PROTOCOL, 'observed_at': time.monotonic(), 'services': services},
                         separators=(',', ':')).encode()
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(fd, payload[offset:])
        os.fsync(fd)
    except OSError:
        raise ClientError('SERVICE_PROBE_OUTPUT_WRITE_FAILED') from None

def collect(config: dict, service_states: dict | None = None) -> dict:
    try:
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        if not re.fullmatch(r'[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}', boot): boot = None
    except OSError: boot = None
    services = service_states if service_states is not None else {
        role: service_state(unit) for role, unit in config['units'].items()
    }
    return {'protocol': 'ghostfleet-heartbeat/v1', 'boot_id': boot, 'reporter_version': VERSION,
            'services': services}

def report(config: dict, allow_loopback: bool = False, service_state_file: Path | None = None) -> None:
    if service_state_file:
        # Replace fd 1 itself before reading the root-owned snapshot. CPython's
        # standard stream has closefd=False: closing its wrapper is not enough.
        # fd 2 is the unit's existing journal stream, not the snapshot file.
        try: os.dup2(2, 1)
        except OSError:
            raise ClientError('SERVICE_SNAPSHOT_STDOUT_REDIRECT_FAILED') from None
        service_states = read_service_snapshot(service_state_file, config['units'])
    else:
        service_states = None
    result = post_json(config['origin'], '/v1/nodes/' + config['node_uid'] + '/heartbeat',
                       collect(config, service_states), config['reporting_token'], allow_loopback)
    if result.get('node_uid') != config['node_uid'] or not isinstance(result.get('received_at'), str):
        raise ClientError('RESPONSE_IDENTITY_MISMATCH')
    print('GF_HEARTBEAT_OK', file=sys.stderr if service_state_file else sys.stdout, flush=True)

def atomic_write(path: Path, data: bytes, mode: int) -> None:
    if path.is_symlink(): raise ClientError('TARGET_SYMLINK_REFUSED')
    fd, tmp = tempfile.mkstemp(prefix='.gf-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def safe_parent(path: Path, mode: int = 0o755) -> None:
    # Root effects use only fixed paths, never pathnames returned by the server.
    for parent in [path, *path.parents]:
        if parent.is_symlink(): raise ClientError('PARENT_SYMLINK_REFUSED')
    path.mkdir(parents=True, exist_ok=True, mode=mode)
    if path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o022:
        raise ClientError('UNSAFE_PARENT_OWNER_OR_MODE')

def check_owned_files(root: Path = Path('/')) -> None:
    for p in [SCRIPT, SERVICE, TIMER]:
        target = root / p.relative_to('/')
        if target.exists() and (target.is_symlink() or MARKER.encode() not in target.read_bytes()[:160]):
            raise ClientError('UNOWNED_INSTALL_TARGET')

def install_files(config: dict, source: bytes, root: Path = Path('/')) -> None:
    check_owned_files(root)
    for p, mode in [(CONFIG.parent, 0o700), (SCRIPT.parent, 0o755), (SERVICE.parent, 0o755)]:
        safe_parent(root / p.relative_to('/'), mode)
    if MARKER.encode() not in source[:160]: raise ClientError('INVALID_INSTALLER_SOURCE')
    files = {str(SCRIPT): source, str(SERVICE): SERVICE_TEXT.encode(), str(TIMER): TIMER_TEXT.encode()}
    # Persist credential first. If a later local step fails, repair uses this same
    # identity/credential rather than consuming another ticket.
    atomic_write(root / CONFIG.relative_to('/'), json.dumps(config).encode(), 0o600)
    for p, data in files.items(): atomic_write(root / Path(p).relative_to('/'), data, 0o755 if p == str(SCRIPT) else 0o644)
    manifest = {'protocol': 'ghostfleet-presence-install/v1', 'files': {p: hashlib.sha256(data).hexdigest() for p, data in files.items()}}
    atomic_write(root / MANIFEST.relative_to('/'), json.dumps(manifest).encode(), 0o600)

def systemctl(*args: str) -> None:
    p = subprocess.run(['/usr/bin/systemctl', *args], timeout=50, capture_output=True, check=False)
    if p.returncode: raise ClientError('SYSTEMD_ACTION_FAILED_SEE_LOCAL_JOURNAL')

def install(args) -> None:
    if os.geteuid() != 0: raise ClientError('INSTALL_REQUIRES_OWNER_ROOT_CEREMONY')
    if sys.platform != 'linux' or not sys.stdin.isatty():
        raise ClientError('LINUX_INTERACTIVE_TERMINAL_REQUIRED')
    origin = check_origin(args.origin)
    check_owned_files()
    if CONFIG.is_symlink() or MANIFEST.is_symlink(): raise ClientError('TARGET_SYMLINK_REFUSED')
    existing = load_config(CONFIG) if CONFIG.exists() else None
    if existing and not args.replace: raise ClientError('ALREADY_INSTALLED_USE_REPAIR_OR_EXPLICIT_REPLACE')
    units = {'ssh': args.ssh_unit, 'cloudflared': args.cloudflared_unit, 'tailscaled': args.tailscaled_unit}
    if any(not UNIT.fullmatch(v) for v in units.values()): raise ClientError('INVALID_UNIT_MAP')
    for parent, mode in [(CONFIG.parent, 0o700), (SCRIPT.parent, 0o755), (SERVICE.parent, 0o755)]:
        safe_parent(parent, mode)
    ticket = args.ticket or input('Ticket ID: ').strip()
    if not TICKET.fullmatch(ticket): raise ClientError('INVALID_TICKET')
    code = getpass.getpass('One-time 8-digit code: ').strip()
    if not re.fullmatch(r'\d{8}', code, flags=re.ASCII): raise ClientError('INVALID_CODE')
    claim = {'short_code': code}
    if existing: claim['expected_node_uid'] = existing['node_uid']
    try: received = post_json(origin, '/v1/enrollment-tickets/' + ticket + '/claim', claim)
    except ClientError as error:
        # Network outcome can be ambiguous. Never automatically claim again.
        raise ClientError(str(error) + '; CLAIM_NOT_RETRIED_REISSUE_SAME_NODE_IF_NEEDED') from None
    config = validate_config({'origin': origin, 'node_uid': received.get('node_uid'),
                              'reporting_token': received.get('reporting_token'), 'units': units})
    if existing and config['node_uid'] != existing['node_uid']: raise ClientError('NODE_IDENTITY_CONFLICT')
    if existing: systemctl('stop', TIMER.name, SERVICE.name)
    install_files(config, Path(__file__).read_bytes())
    systemctl('daemon-reload')
    systemctl('enable', '--now', TIMER.name)
    systemctl('start', SERVICE.name)
    print('GF_INSTALLED; SSH_AND_PROVIDER_CONFIG_UNCHANGED')

def repair() -> None:
    if os.geteuid() != 0: raise ClientError('REPAIR_REQUIRES_ROOT')
    config = load_config(CONFIG)
    install_files(config, Path(__file__).read_bytes())
    systemctl('daemon-reload'); systemctl('enable', '--now', TIMER.name); systemctl('start', SERVICE.name)
    print('GF_REPAIRED; NO_NEW_TICKET_OR_NODE')

def remove() -> None:
    if os.geteuid() != 0: raise ClientError('REMOVE_REQUIRES_ROOT')
    check_owned_files()
    if not MANIFEST.is_file() or MANIFEST.is_symlink(): raise ClientError('INSTALL_MANIFEST_REQUIRED')
    data = json.loads(MANIFEST.read_text())
    if data.get('protocol') != 'ghostfleet-presence-install/v1' or set(data.get('files', {})) != {str(SCRIPT), str(SERVICE), str(TIMER)}:
        raise ClientError('INVALID_INSTALL_MANIFEST')
    for p in [SCRIPT, SERVICE, TIMER]:
        if p.exists() and hashlib.sha256(p.read_bytes()).hexdigest() != data['files'][str(p)]:
            raise ClientError('LOCAL_DRIFT_REVIEW_BEFORE_REMOVE')
    systemctl('disable', '--now', TIMER.name); systemctl('stop', SERVICE.name)
    for p in [SCRIPT, SERVICE, TIMER, CONFIG, MANIFEST]:
        if p.is_symlink(): raise ClientError('TARGET_SYMLINK_REFUSED')
        p.unlink(missing_ok=True)
    systemctl('daemon-reload')
    print('GF_REMOVED; REVOKE_REPORTING_IN_PANEL_SEPARATELY; SSH_UNCHANGED')

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    p = commands.add_parser('report')
    p.add_argument('--config', type=Path, default=Path(os.getenv('CREDENTIALS_DIRECTORY', str(CONFIG.parent))) / 'presence.json')
    p.add_argument('--service-state-file', type=Path)
    p.add_argument('--allow-loopback-http', action='store_true', help='isolated local tests only; never permits public HTTP')
    commands.add_parser('probe')
    p = commands.add_parser('install')
    p.add_argument('--origin', required=True); p.add_argument('--ticket'); p.add_argument('--replace', action='store_true')
    for role, unit in DEFAULT_UNITS.items(): p.add_argument('--' + role + '-unit', default=unit)
    commands.add_parser('repair'); commands.add_parser('remove')
    args = parser.parse_args()
    try:
        if args.action == 'report':
            report(load_config(args.config, args.allow_loopback_http), args.allow_loopback_http, args.service_state_file)
        elif args.action == 'probe': probe()
        elif args.action == 'install': install(args)
        elif args.action == 'repair': repair()
        else: remove()
        return 0
    except ClientError as error:
        print('GF_ERROR ' + str(error), file=sys.stderr); return 1
    except (OSError, ValueError, subprocess.TimeoutExpired):
        print('GF_ERROR LOCAL_OPERATION_FAILED; CHECK_CONFIG_THEN_REPAIR_OR_REISSUE_SAME_NODE', file=sys.stderr); return 1
    except KeyboardInterrupt:
        print('GF_ERROR INTERRUPTED; DO_NOT_BLINDLY_REPEAT_CLAIM', file=sys.stderr); return 130

if __name__ == '__main__':
    sys.exit(main())
