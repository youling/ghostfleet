#!/usr/bin/env python3
"""Plan and apply the reviewed GhostFleet bootstrap on Debian 13 amd64."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

BOOTSTRAP = Path(__file__).resolve().parent
sys.path.insert(0, str(BOOTSTRAP))
sys.path.insert(1, str(BOOTSTRAP.parent))  # native.py is one level up in the source checkout.
import enroll
import native
import node
import update

LIB = Path('/usr/local/lib/ghostfleet-nextgen')
ETC = Path('/etc/ghostfleet-nextgen')
UNITS = Path('/etc/systemd/system')
STATE = node.STATE
SOFTWARE = update.ROOT
PRIVATE = STATE / 'private'
INSTALL = STATE / 'installer'
RECEIPT = INSTALL / 'receipt.json'
UNIT_BASE = 'ghostfleet-nextgen-'
TIMERS = (UNIT_BASE + 'report.timer', UNIT_BASE + 'update.timer')
UNIT_FILES = (*TIMERS, UNIT_BASE + 'report.service', UNIT_BASE + 'update.service', native.AGENT_UNIT)
SCRIPTS = ('enroll.py', 'node.py', 'update.py', 'report.py', 'native.py')
SCHEMA = 'ghostfleet-install/v1'
# These paths are hidden by ProtectHome, PrivateTmp, or InaccessiblePaths in
# the packaged update unit. The CLI and scheduled service must share trust.
UPDATE_UNIT_HIDDEN = tuple(map(Path, ('/root', '/home', '/run/user', '/tmp', '/var/tmp', '/etc/ssh'))) + (PRIVATE,)


def require(condition, code):
    if not condition:
        raise update.UpdateError(code)


def exists(path):
    return path.exists() or path.is_symlink()


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode() + b'\n'


def checksum(data):
    return hashlib.sha256(data).hexdigest()


def local_path(value):
    require(isinstance(value, str) and 0 < len(value) <= 4096 and not any(ord(c) < 32 for c in value),
            'INVALID_PROFILE_PATH')
    path = Path(value)
    require(path.is_absolute() and '..' not in path.parts, 'INVALID_PROFILE_PATH')
    return path


def fields(value, required, optional=()):
    require(isinstance(value, dict) and set(required) <= value.keys() <= set(required) | set(optional),
            'INVALID_INSTALL_PROFILE')


def service_keyring(path):
    require(not any(path.is_relative_to(hidden) for hidden in UPDATE_UNIT_HIDDEN), 'KEYRING_HIDDEN_FROM_UPDATE_SERVICE')


def profile(path, local):
    value = node.read_json(update.trusted_file(path.absolute()), private=True)
    fields(value, ('schema', 'update', 'enrollment'), ('components', 'previous_files'))
    require(value['schema'] == SCHEMA, 'INVALID_INSTALL_SCHEMA')
    update.validate_settings(value['update'], local)
    service_keyring(Path(value['update']['keyring']))
    entry = value['enrollment']
    fields(entry, ('mode', 'node_uid', 'origin', 'config_revision'), ('invitation_file', 'legacy_config'))
    require(entry['mode'] in ('enroll', 'adopt') and node.valid(node.UID, entry['node_uid']) and
            node.valid(enroll.SHA, entry['config_revision']), 'INVALID_IDENTITY_PROFILE')
    target = 'invitation_file' if entry['mode'] == 'enroll' else 'legacy_config'
    require(set(entry) == {'mode', 'node_uid', 'origin', 'config_revision', target}, 'INVALID_IDENTITY_PROFILE')
    local_path(entry[target])
    node.origin(entry['origin'], local)
    components = value.setdefault('components', {})
    fields(components, (), ('tailscale', 'cloudflare', 'k3s'))
    for provider in ('tailscale', 'cloudflare'):
        require(components.setdefault(provider, 'none') in ('none', 'observe'), 'INVALID_PROVIDER_MODE')
    k3s = components.setdefault('k3s', {'role': 'none'})
    fields(k3s, ('role',), ('mode', 'profile', 'artifact', 'token_file', 'approve_plan'))
    if k3s['role'] == 'none':
        fields(k3s, ('role',))
    elif k3s['role'] in ('server', 'agent') and k3s.get('mode') == 'external':
        fields(k3s, ('role', 'mode'))
    else:
        fields(k3s, ('role', 'mode', 'profile', 'artifact', 'token_file', 'approve_plan'))
        require(k3s['role'] == 'agent' and k3s['mode'] in ('prepare', 'start') and
                node.valid(enroll.SHA, k3s['approve_plan']), 'INVALID_K3S_MODE')
        for key in ('profile', 'artifact', 'token_file'):
            local_path(k3s[key])
    previous = value.setdefault('previous_files', {})
    fields(previous, (), (*SCRIPTS, *UNIT_FILES, 'enrollment.json', 'update.json'))
    require(all(node.valid(enroll.SHA, digest) for digest in previous.values()), 'INVALID_PREVIOUS_FILE_PIN')
    return value


def root_directory(path, mode):
    if not exists(path):
        update.trusted_parents(path)
        try:
            path.mkdir(mode=mode)
        except FileExistsError:  # A second invocation may create the lock directory first.
            pass
        else:
            path.chmod(mode)
    check_directory(path, mode)


def check_directory(path, mode):
    update.trusted_parents(path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & (0o777 ^ mode),
            'UNSAFE_INSTALL_DIRECTORY')


def file_snapshot(path):
    if not exists(path):
        return None
    update.trusted_file(path)
    info = path.stat()
    require(info.st_size <= update.MAX_SIZE, 'INSTALL_FILE_TOO_LARGE')
    return checksum(path.read_bytes()), stat.S_IMODE(info.st_mode)


def read_receipt():
    if not exists(RECEIPT):
        return None
    result = node.read_json(update.trusted_file(RECEIPT), private=True)
    fields(result, ('schema', 'node_uid', 'origin', 'trust', 'owned'))
    require(result['schema'] == SCHEMA and isinstance(result['owned'], list) and
            all(isinstance(name, str) for name in result['owned']), 'INVALID_INSTALL_RECEIPT')
    return result


def desired_files(value):
    desired = {}
    for name in (*SCRIPTS, *UNIT_FILES):
        source = BOOTSTRAP / name
        if name == 'native.py' and not exists(source):
            source = BOOTSTRAP.parent / name
        update.trusted_file(source)
        require(0 < source.stat().st_size <= update.MAX_SIZE, 'INVALID_BOOTSTRAP_FILE')
        desired[(LIB if name in SCRIPTS else UNITS) / name] = (source.read_bytes(), 0o644)
    enrollment = value['enrollment']
    desired[ETC / 'enrollment.json'] = (json_bytes({key: enrollment[key] for key in ('origin', 'config_revision')}), 0o600)
    desired[ETC / 'update.json'] = (json_bytes(value['update']), 0o600)
    return desired


def service_state(unit):
    result = subprocess.run(['systemctl', 'show', '--no-pager',
                             '-p', 'FragmentPath,DropInPaths,LoadState,ActiveState,UnitFileState,NeedDaemonReload', unit],
                            env=update.NATIVE_ENV, capture_output=True, text=True, timeout=10, check=False)
    state = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    require(state.get('LoadState') in ('loaded', 'not-found', 'masked'), 'SYSTEMD_STATE_UNKNOWN')
    return state


def identity_state(entry, local):
    path = PRIVATE / 'identity.json'
    target = node.origin(entry['origin'], local)
    if exists(path):
        current = node.identity(node.read_json(update.trusted_file(path), private=True))
        require(current['node_uid'] == entry['node_uid'] and current['origin'] == target, 'IDENTITY_CONFLICT')
        return 'present'
    if entry['mode'] == 'adopt':
        legacy = local_path(entry['legacy_config'])
        prior = node.identity(node.read_json(update.trusted_file(legacy), private=True))
        require(prior['node_uid'] == entry['node_uid'] and prior['origin'] == target, 'IDENTITY_CONFLICT')
    else:
        invitation = node.read_json(update.trusted_file(local_path(entry['invitation_file'])), private=True)
        fields(invitation, ('node_uid', 'invitation'))
        require(invitation['node_uid'] == entry['node_uid'] and node.valid(enroll.INVITATION, invitation['invitation']),
                'INVALID_INVITATION')
    return entry['mode']


def inspect(value, local):
    for path, mode in ((STATE, 0o755), (INSTALL, 0o700), (ETC, 0o755), (LIB, 0o755), (UNITS, 0o755)):
        if exists(path):
            check_directory(path, mode)
    release = update.active(SOFTWARE)
    desired = desired_files(value)
    existing = read_receipt()
    entry = value['enrollment']
    trust = {key: value['update'][key] for key in ('keyring', 'fingerprint')}
    trust['keyring_sha256'] = file_snapshot(Path(trust['keyring']))[0]
    if existing:
        require(existing['node_uid'] == entry['node_uid'] and existing['origin'] == entry['origin'], 'IDENTITY_CONFLICT')
        require(existing['trust'] == trust, 'TRUST_ROOT_CHANGED')
    current = ETC / 'update.json'
    if exists(current):
        # A separate, explicitly authorized trust rotation may have changed the
        # effective configuration after the installer wrote its ownership receipt.
        prior = update.settings(current, local)
        require(all(prior[key] == trust[key] for key in ('keyring', 'fingerprint')), 'TRUST_ROOT_CHANGED')
    owned = existing['owned'] if existing else ()
    identity_action = identity_state(entry, local)
    states = {unit: service_state(unit) for unit in UNIT_FILES}
    for unit, state in states.items():
        require(not state.get('DropInPaths') and state.get('LoadState') != 'masked' and
                state.get('FragmentPath', '') in ('', str(UNITS / unit)), 'UNMANAGED_UNIT_CONFLICT:' + unit)
    changed = []
    for path, (data, mode) in desired.items():
        previous = file_snapshot(path)
        digest = checksum(data)
        if previous and previous[0] != digest:
            require(str(path) in owned or previous[0] == value['previous_files'].get(path.name),
                    'UNMANAGED_FILE_CONFLICT:' + path.name)
        if previous != (digest, mode):
            changed.append(path)
    k3s = value['components']['k3s']
    prepared = False
    approved = None
    if k3s['role'] == 'agent' and k3s.get('mode') in ('prepare', 'start'):
        approved = node.read_json(update.trusted_file(local_path(k3s['profile'])), private=True)
        native.validate_agent_profile(approved)
        require(approved['node_uid'] == entry['node_uid'] and
                native.preparation_plan(approved)['plan_sha256'] == k3s['approve_plan'], 'K3S_PLAN_CHANGED')
        if exists(native.AGENT_HOME):
            require(native.trusted_attachment(approved) is not None, 'EXISTING_ATTACHMENT_CONFLICT')
            prepared = True
            token = local_path(k3s['token_file'])
            if exists(token) or k3s['mode'] == 'start' and states[native.AGENT_UNIT].get('ActiveState') != 'active':
                supplied = native.agent_token(native.read(update.trusted_file(token), secret=True, limit=1024),
                                               approved['ca_sha256'])
                require(native.read(native.AGENT_HOME / 'token', secret=True, limit=1024) == supplied.encode(),
                        'EXISTING_ATTACHMENT_CONFLICT')
        else:
            artifact = update.trusted_file(local_path(k3s['artifact']))
            token = update.trusted_file(local_path(k3s['token_file']))
            require(checksum(native.read(artifact, limit=128 * 1024 * 1024)) == approved['sha256'],
                    'K3S_ARTIFACT_MISMATCH')
            native.agent_token(native.read(token, secret=True, limit=1024), approved['ca_sha256'])
    actions = list(map(str, changed))
    if exists(LIB) and LIB.stat().st_mode & 0o055 != 0o055:
        require(str(LIB / 'report.py') in owned, 'UNMANAGED_LAUNCHER_DIRECTORY_MODE')
        actions.append(str(LIB))
    active_units = (*TIMERS, native.AGENT_UNIT) if k3s.get('mode') == 'start' else TIMERS
    operations = [unit for unit in active_units if states[unit].get('UnitFileState') != 'enabled' or
                  states[unit].get('ActiveState') != 'active']
    receipt = {'schema': SCHEMA, 'node_uid': entry['node_uid'], 'origin': entry['origin'], 'trust': trust,
               'owned': sorted(map(str, desired))}
    if receipt != existing:
        actions.append(str(RECEIPT))
    return release, desired, receipt, changed, states, operations, approved, prepared, identity_action, actions


def write_file(path, contents, mode):
    descriptor, scratch = tempfile.mkstemp(prefix='.ghostfleet-', dir=path.parent)
    link = Path(scratch)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(link, path)
        update.sync_dir(path.parent)
    finally:
        link.unlink(missing_ok=True)


def show_components(value):
    components = value['components']
    native_state = {}
    for name, service in (('tailscale', 'tailscaled.service'), ('cloudflare', 'cloudflared.service')):
        if components[name] == 'observe':
            native_state[name] = service_state(service).get('ActiveState', 'unknown')
    k3s = components['k3s']
    if k3s['role'] != 'none':
        unit = native.AGENT_UNIT if k3s['mode'] != 'external' else (
            'k3s.service' if k3s['role'] == 'server' else 'k3s-agent.service')
        native_state['k3s'] = {'role': k3s['role'], 'mode': k3s['mode'],
                               'activity': service_state(unit).get('ActiveState', 'unknown')}
    return native_state


def release_view(release):
    if release is None:
        return None
    return {key: release.get(key) for key in ('version', 'sha256', 'platform', 'source_revision')}


def unit_view(states):
    return {unit: {field: state.get(field, 'unknown') for field in ('ActiveState', 'UnitFileState')}
            for unit, state in states.items() if unit != native.AGENT_UNIT}


def enable_owned(unit, agent):
    if unit == native.AGENT_UNIT and service_state(unit).get('ActiveState') != 'active':
        # Another owner may have provisioned K3s after this Agent was prepared.
        require(native.agent_plan(agent, native.discover()) == native.preparation_plan(agent),
                'K3S_START_OWNERSHIP_REVIEW')
    update.command(['systemctl', 'enable', '--now', unit], error='SYSTEMD_ENABLE_FAILED:' + unit)


def activate_release(action, value, receipt, desired, changed, states, actions, local):
    config = ETC / 'update.json'
    updater = LIB / 'update.py'
    timer = UNIT_BASE + 'update.timer'
    service = UNIT_BASE + 'update.service'
    # RC2 loads its configuration before locking. Drain only that old timer
    # during a settings change. RC3 and later resolve settings under the lock.
    drain = config in changed and updater in changed and exists(config) and exists(updater)
    resume = drain and states[timer].get('ActiveState') == 'active'
    if resume:
        update.command(['systemctl', 'stop', timer], error='SYSTEMD_PAUSE_UPDATE_TIMER_FAILED')

    def before_activate():
        if exists(config):
            prior = update.settings(config, local)
            require(all(prior[key] == receipt['trust'][key] for key in ('keyring', 'fingerprint')),
                    'TRUST_ROOT_CHANGED')
        if str(RECEIPT) in actions:
            write_file(RECEIPT, json_bytes(receipt), 0o600)
        if updater in changed:
            root_directory(LIB, 0o755)
            write_file(updater, *desired[updater])
        if config in changed:
            root_directory(ETC, 0o755)
            write_file(config, *desired[config])

    try:
        if drain and service_state(service).get('ActiveState') not in ('inactive', 'failed'):
            update.command(['systemctl', 'stop', service], error='SYSTEMD_DRAIN_UPDATE_FAILED')
        return update.run_update(SOFTWARE, value['update'], 'amd64', repair=(action == 'repair'),
                                 before_activate=before_activate)
    finally:
        if resume:
            update.command(['systemctl', 'start', timer], error='SYSTEMD_RESUME_UPDATE_TIMER_FAILED')


def execute(action, value, local):
    release, desired, receipt, changed, states, units, agent, prepared, identity_action, actions = inspect(value, local)
    result = {'schema': SCHEMA, 'node_uid': receipt['node_uid'], 'platform': 'debian13-amd64',
              'installed_release': release_view(release), 'identity': identity_action, 'files': actions, 'units': units,
              'services': unit_view(states)}
    if action in ('plan', 'status'):
        result.update(result='PLAN' if action == 'plan' else 'STATUS', components=show_components(value))
        return result
    update_result = activate_release(action, value, receipt, desired, changed, states, actions, local)
    root_directory(ETC, 0o755)
    root_directory(LIB, 0o755)
    if str(LIB) in actions:
        LIB.chmod(stat.S_IMODE(LIB.stat().st_mode) | 0o055)
    for path in changed:
        if path not in (ETC / 'update.json', LIB / 'update.py'):
            write_file(path, *desired[path])
    entry = value['enrollment']
    if identity_action != 'present':
        # Reuse the enrollment entry point, including its own identity lock and
        # persistent pending credential after interrupted remote claims.
        key = 'invitation-file' if identity_action == 'enroll' else 'legacy-config'
        args = [sys.executable, '-I', str(LIB / 'enroll.py')]
        if local:
            args.append('--allow-local-fixture')
        args.extend((identity_action, '--' + key, entry[key.replace('-', '_')]))
        if identity_action == 'adopt':
            args.extend(('--expected-node-uid', entry['node_uid']))
        update.command(args, error='IDENTITY_APPLY_FAILED')
    reload_needed = any(path.parent == UNITS for path in changed) or any(
        state.get('NeedDaemonReload') == 'yes' or state['LoadState'] == 'not-found' for state in states.values())
    if reload_needed:
        update.command(['systemctl', 'daemon-reload'], error='SYSTEMD_RELOAD_FAILED')
    if agent is not None and not prepared:
        k3s = value['components']['k3s']
        native.apply_agent(agent, k3s['approve_plan'], local_path(k3s['artifact']), local_path(k3s['token_file']))
    for unit in units:
        enable_owned(unit, agent)
    if action == 'repair':
        reporter = UNIT_BASE + 'report.service'
        if states[reporter].get('ActiveState') == 'failed':
            update.command(['systemctl', 'start', reporter], error='SYSTEMD_REPAIR_FAILED:' + reporter)
            units.append(reporter)
    observed = {unit: service_state(unit) for unit in UNIT_FILES}
    require(all(observed[unit].get('UnitFileState') == 'enabled' and observed[unit].get('ActiveState') == 'active'
                for unit in TIMERS), 'SYSTEMD_TIMER_NOT_ACTIVE')
    require(identity_state(entry, local) == 'present', 'IDENTITY_APPLY_UNVERIFIED')
    result.update(result='UNCHANGED' if update_result == 'UNCHANGED' and not (actions or units or reload_needed or
                  identity_action != 'present' or agent is not None and not prepared) else 'APPLIED',
                  identity='present', update=update_result, installed_release=release_view(update.active(SOFTWARE)),
                  services=unit_view(observed), components=show_components(value))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan', 'apply', 'status', 'repair'))
    parser.add_argument('profile', type=Path)
    parser.add_argument('--allow-local-fixture', action='store_true', help='disposable signed lab archives only')
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0, 'ROOT_REQUIRED')
        require(update.release_platform() == 'amd64' and Path('/run/systemd/system').is_dir(),
                'INSTALL_PLATFORM_NOT_SUPPORTED')
        value = profile(args.profile, args.allow_local_fixture)
        if args.action in ('plan', 'status'):
            result = execute(args.action, value, args.allow_local_fixture)
        else:
            # Preflight conflicts before creating even the installer state/lock.
            inspect(value, args.allow_local_fixture)
            root_directory(STATE, 0o755)
            root_directory(INSTALL, 0o700)
            fd = os.open(INSTALL / 'install.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                result = execute(args.action, value, args.allow_local_fixture)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (update.UpdateError, node.NodeError, native.NativeError) as error:
        print(json.dumps({'schema': SCHEMA, 'result': 'BLOCKED', 'error': str(error)}))
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        print(json.dumps({'schema': SCHEMA, 'result': 'BLOCKED', 'error': 'INSTALL_IO_OR_VALIDATION_FAILED'}))
    return 1


if __name__ == '__main__':
    sys.exit(main())
