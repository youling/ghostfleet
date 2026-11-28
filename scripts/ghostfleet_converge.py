#!/usr/bin/env python3
"""Apply one authorized GhostFleet configuration projection through ansible-core."""
import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import runpy
import selectors
import shlex
import signal
import stat
import subprocess
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]
PLAY = ROOT / 'config/convergence'
ANSIBLE_CORE = '2.19.11'
DIGEST = re.compile(r'[0-9a-f]{64}')
NODE = re.compile(r'node-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
LOGIN = re.compile(r'[a-z_][a-z0-9_-]{0,31}')
ALIAS = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}')
RECAP = re.compile(r'^target\s+:\s+(ok=\d+\s+changed=\d+\s+unreachable=\d+\s+failed=\d+\s+skipped=\d+\s+rescued=\d+\s+ignored=\d+)\s*$', re.M)
PLATFORMS = {'debian13-amd64', 'wsl-debian13-amd64'}

TARGET_GATE = PLAY / 'target_lock.py'


class Refused(Exception):
    pass


class AttemptUnknown(Exception):
    def __init__(self, attempt_id, reason):
        self.attempt_id = attempt_id
        self.reason = reason


def require(ok, code):
    if not ok:
        raise Refused(code)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def fields(data, expected):
    require(isinstance(data, dict) and set(data) == set(expected.split()), 'CONFIG_FIELDS_INVALID')


def no_duplicates(pairs):
    data = dict(pairs)
    require(len(data) == len(pairs), 'DUPLICATE_JSON_FIELD')
    return data


def object_bytes(body):
    return json.loads(body, object_pairs_hook=no_duplicates)


def absolute(value):
    require(isinstance(value, str) and 0 < len(value) <= 1024 and value.startswith('/')
            and str(Path(value)) == value and '..' not in Path(value).parts
            and not re.search(r'[\x00-\x1f\x7f{}]', value), 'PATH_INVALID')
    return Path(value)


def trusted_read(path, *, digest=None, private=False):
    path = absolute(path)
    require(path.resolve(strict=True) == path, 'UNTRUSTED_INPUT_PATH')
    if private:
        parent = path.parent.stat()
        require(parent.st_uid in {0, os.getuid()} and not parent.st_mode & 0o022, 'UNTRUSTED_INPUT_DIRECTORY')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        meta = os.fstat(stream.fileno())
        require(stat.S_ISREG(meta.st_mode) and meta.st_uid in {0, os.getuid()} and meta.st_nlink == 1
                and not meta.st_mode & (0o077 if private else 0o022) and meta.st_size <= 1_048_576,
                'UNTRUSTED_INPUT_FILE')
        body = stream.read(1_048_577)
    require(len(body) <= 1_048_576 and (digest is None or digest == sha(body)), 'INPUT_DIGEST_MISMATCH')
    return body


def owner_scope(scope, projection, action):
    fields({key: value for key, value in scope.items() if key != 'owner_handoff'},
           'schema node_uid platform projection_sha256 operations expires_at controller target identity tools')
    fields(projection.get('target'), 'node_uid platform')
    require(scope['schema'] == 'ghostfleet-config-authority/v1'
            and projection.get('schema') == 'ghostfleet-target/v1', 'UNSUPPORTED_CONTRACT')
    uid = scope['node_uid']
    require(isinstance(uid, str) and NODE.fullmatch(uid) and uid == projection['target']['node_uid']
            and scope['platform'] in PLATFORMS and scope['platform'] == projection['target']['platform'],
            'TARGET_SCOPE_MISMATCH')
    require(projection.get('controller') == {'policy': 'exclusive', 'lock_key': 'ghostfleet-config:' + uid},
            'CONTROLLER_LOCK_SCOPE_MISSING')
    body = {key: value for key, value in projection.items() if key != 'projection_sha256'}
    encoded = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    require(projection.get('projection_sha256') == scope['projection_sha256'] == sha(encoded),
            'PROJECTION_DIGEST_MISMATCH')
    require(isinstance(scope['operations'], list) and set(scope['operations']) <= {'plan', 'apply', 'verify'}
            and action in scope['operations'], 'OPERATION_OUTSIDE_SCOPE')
    fields(scope['controller'], 'uid machine_id_sha256')
    require(scope['controller'] == {'uid': os.getuid(),
            'machine_id_sha256': sha(Path('/etc/machine-id').read_bytes().strip())}, 'WRONG_CONTROLLER')
    check_window(scope['expires_at'])


def check_window(expires_at):
    require(isinstance(expires_at, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', expires_at),
            'AUTHORITY_EXPIRY_INVALID')
    require(datetime.fromisoformat(expires_at) > datetime.now(timezone.utc), 'AUTHORITY_EXPIRED')


def desired_resources(projection, target, assets):
    resources = projection.get('resources')
    require(isinstance(resources, list) and len(resources) <= 256, 'RESOURCE_LIST_INVALID')
    paths, packages = [], []
    for claim in resources:
        require(isinstance(claim, dict), 'RESOURCE_INVALID')
        if claim.get('owner') != 'ansible' or claim.get('mode') != 'manage':
            continue
        rule = claim.get('desired')
        require(isinstance(rule, dict) and claim.get('scope') == 'host', 'ANSIBLE_RESOURCE_SCOPE_INVALID')
        if claim.get('kind') == 'path':
            path = absolute(claim.get('key'))
            if rule.get('state') == 'directory':
                fields(rule, 'state mode')
            elif rule.get('state') == 'file':
                fields(rule, 'state mode sha256')
                pin = rule['sha256']
                require(assets is not None and isinstance(pin, str) and DIGEST.fullmatch(pin), 'FILE_ARTIFACT_PIN_REQUIRED')
                content = trusted_read(str(assets / pin), digest=pin)
                require(len(content) <= 65536, 'FILE_PAYLOAD_TOO_LARGE')
                rule = {**rule, 'content': content}
            else:
                raise Refused('ANSIBLE_PATH_STATE_UNSUPPORTED')
            lock = absolute(target['lock_path'])
            pending = lock.with_name(lock.name + '.pending')
            require(path != Path('/') and not any(item.is_relative_to(path) or path.is_relative_to(item)
                                               for item in (lock, pending))
                    and isinstance(rule['mode'], str) and re.fullmatch(r'0[0-7]{3}', rule['mode']),
                    'ANSIBLE_PATH_MODE_INVALID')
            paths.append({'path': str(path), **rule})
        elif claim.get('kind') == 'package':
            fields(rule, 'state version')
            name, version = claim.get('key'), rule.get('version')
            require(target['user'] == 'root' and rule['state'] == 'present' and isinstance(name, str)
                    and re.fullmatch(r'[a-z0-9][a-z0-9+.-]{0,95}', name) and isinstance(version, str)
                    and re.fullmatch(r'[0-9][0-9A-Za-z.+:~_-]{0,127}', version), 'PINNED_PACKAGE_SCOPE_INVALID')
            packages.append({'name': name, 'version': version})
        elif claim.get('kind') == 'package-db':
            # A writer claim is evaluated by the compiler. Ansible's native apt
            # operation, if selected, uses the system dpkg lock for effects.
            continue
        else:
            raise Refused('UNSUPPORTED_ANSIBLE_RESOURCE')
    require(len({item['path'] for item in paths}) == len(paths)
            and len({item['name'] for item in packages}) == len(packages), 'DUPLICATE_ANSIBLE_WRITER')
    return paths, packages


def check_host(host):
    require(isinstance(host, str) and 0 < len(host) <= 253, 'TARGET_HOST_INVALID')
    try:
        ipaddress.ip_address(host)
    except ValueError:
        require(re.fullmatch(r'(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*'
                             r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', host), 'TARGET_HOST_INVALID')


def known_host(target):
    fields(target, 'host port user alias known_hosts known_hosts_sha256 host_key_fingerprint identity_file machine_id_sha256 lock_path')
    check_host(target['host'])
    require(type(target['port']) is int and 1 <= target['port'] <= 65535
            and isinstance(target['user'], str) and LOGIN.fullmatch(target['user'])
            and isinstance(target['alias'], str) and ALIAS.fullmatch(target['alias'])
            and isinstance(target['machine_id_sha256'], str) and DIGEST.fullmatch(target['machine_id_sha256']),
            'TARGET_TRANSPORT_INVALID')
    absolute(target['lock_path'])
    identity_file = absolute(target['identity_file'])
    meta = identity_file.lstat()
    require(identity_file.resolve(strict=True) == identity_file and stat.S_ISREG(meta.st_mode)
            and meta.st_uid == os.getuid() and not meta.st_mode & 0o077, 'UNTRUSTED_SSH_IDENTITY_REFERENCE')
    data = trusted_read(target['known_hosts'], digest=target['known_hosts_sha256'])
    entries = data.decode('ascii').strip().split()
    require(len(entries) == 3 and entries[0] == target['alias']
            and entries[1] in {'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'rsa-sha2-512', 'ssh-rsa'},
            'EXACT_HOST_PIN_REQUIRED')
    blob = base64.b64decode(entries[2], validate=True)
    pin = 'SHA256:' + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip('=')
    require(pin == target['host_key_fingerprint'], 'HOST_KEY_FINGERPRINT_MISMATCH')
    return data


def owner_identity(identity, alias, scratch, env):
    fields(identity, 'gate gate_sha256 input input_sha256 node_id')
    node_id = identity['node_id']
    require(isinstance(node_id, str) and ALIAS.fullmatch(node_id), 'FLEET_NODE_ID_INVALID')
    private = trusted_read(identity['input'], digest=identity['input_sha256'], private=True)
    mapping = object_bytes(private)
    require(isinstance(mapping, dict) and mapping.get(node_id) == 'known-hosts:' + alias, 'FLEET_IDENTITY_MISMATCH')
    gate = scratch / 'identity_gate.py'
    gate.write_bytes(trusted_read(identity['gate'], digest=identity['gate_sha256']))
    identity_input = scratch / 'verified.json'
    identity_input.write_bytes(private)
    completed = subprocess.run(['/usr/bin/python3', '-I', str(gate), '--targets', node_id,
                                '--identity-input', str(identity_input)], env=env, capture_output=True, timeout=15)
    require(completed.returncode == 0, 'FLEET_IDENTITY_REJECTED')


def ssh_options(target, pins):
    return ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'UserKnownHostsFile=' + str(pins), '-o', 'GlobalKnownHostsFile=/dev/null',
            '-o', 'HostKeyAlias=' + target['alias'], '-o', 'IdentitiesOnly=yes', '-o', 'UpdateHostKeys=no',
            '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=6',
            '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-i', target['identity_file']]


def lock_reply(stream, timeout):
    marker = bytearray()
    deadline = time.monotonic() + timeout
    with selectors.DefaultSelector() as watcher:
        watcher.register(stream, selectors.EVENT_READ)
        while not marker.endswith(b'\n'):
            remaining = deadline - time.monotonic()
            require(remaining > 0 and watcher.select(timeout=remaining), 'TARGET_LOCK_TIMEOUT')
            chunk = os.read(stream.fileno(), 16)
            if not chunk:
                break
            marker.extend(chunk)
            require(len(marker) <= 16, 'TARGET_LOCK_RESPONSE_INVALID')
    return marker


@contextmanager
def node_lock(target, platform, paths, options, env, *, action, projection, expires):
    attempt = uuid.uuid4().hex
    command = shlex.join(['/usr/bin/python3', '-I', '-c', TARGET_GATE.read_text(encoding='utf-8'),
                          target['machine_id_sha256'], platform, target['lock_path'],
                          json.dumps([(p['path'], p['state']) for p in paths]), action, attempt, projection, expires])
    argv = ['/usr/bin/ssh', *options, '-T', '-p', str(target['port']), '-l', target['user'], target['host'], command]
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               env=env, start_new_session=True)
    refusals = {40: 'TARGET_MACHINE_MISMATCH', 41: 'TARGET_PATH_OWNERSHIP_INVALID', 42: 'TARGET_WRITER_BUSY',
                43: 'TARGET_RECOVERY_REQUIRED', 44: 'AUTHORITY_EXPIRED', 45: 'TARGET_LOCK_STORAGE_UNSUPPORTED'}
    rejected = False
    try:
        if lock_reply(process.stdout, 12) != b'LOCKED\n':
            code = process.wait(timeout=2)
            rejected = code in refusals
            raise Refused(refusals.get(code, 'PINNED_SSH_REFUSED'))
        yield process
        if action == 'apply':
            check_window(expires)
            require(process.poll() is None, 'TARGET_LOCK_LOST')
            process.stdin.write(('COMMIT ' + attempt + '\n').encode('ascii'))
            process.stdin.flush()
            require(lock_reply(process.stdout, 6) == b'COMMITTED\n', 'TARGET_COMMIT_UNCONFIRMED')
    except (Refused, OSError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        if action == 'apply' and not rejected:
            reason = str(error) if isinstance(error, Refused) else 'TARGET_COMMIT_UNCONFIRMED'
            raise AttemptUnknown(attempt, reason) from None
        raise
    finally:
        try:
            process.stdin.close()
        except BrokenPipeError:
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdout.close()


def engine(tools, env):
    fields({key: value for key, value in tools.items() if key != 'package_runtime'}, 'ansible ansible_sha256 pythonpath')
    binary = absolute(tools['ansible'])
    trusted_read(str(binary), digest=tools['ansible_sha256'])
    if tools['pythonpath'] is not None:
        modules = absolute(tools['pythonpath'])
        require(modules.resolve(strict=True) == modules and modules.is_dir()
                and modules.stat().st_uid in {0, os.getuid()} and not modules.stat().st_mode & 0o022,
                'UNTRUSTED_ANSIBLE_DEPENDENCIES')
        env['PYTHONPATH'] = str(modules)
    version = subprocess.run([str(binary), '--version'], env=env, capture_output=True, timeout=15)
    require(version.returncode == 0 and version.stdout.startswith(
        f'ansible-playbook [core {ANSIBLE_CORE}]\n'.encode()), 'ANSIBLE_VERSION_MISMATCH')
    return str(binary)


def run_playbook(binary, scratch, action, target, options, paths, packages, owner, package_action, env, lock, expires):
    inventory = {'all': {'hosts': {'target': {
        'ansible_host': target['host'], 'ansible_port': target['port'], 'ansible_user': target['user'],
        'ansible_connection': 'ssh', 'ansible_ssh_common_args': shlex.join(options),
        'ansible_python_interpreter': '/usr/bin/python3',
    }}}}
    inventory_path = scratch / 'inventory.json'
    inventory_path.write_text(json.dumps(inventory))
    rendered = []
    for rank, resource in enumerate(paths):
        entry = {key: value for key, value in resource.items() if key != 'content'}
        if resource['state'] == 'file':
            body = resource['content']
            source = scratch / f'file-{rank}'
            source.write_bytes(body)
            entry.update(source=str(source), sha256=sha(body))
        rendered.append(entry)
    rendered.sort(key=lambda item: len(Path(item['path']).parts))
    variables = scratch / 'projection.json'
    variables.write_text(json.dumps({'ghostfleet_phase': action, 'ghostfleet_paths': rendered,
                                     'ghostfleet_packages': packages, 'ghostfleet_owner_argv': owner,
                                     'ghostfleet_package_argv': package_action}))
    args = [binary, '-i', str(inventory_path), '--limit', 'target', '--extra-vars', '@' + str(variables),
            str(PLAY / 'converge.yml')]
    if action == 'plan':
        args.append('--check')
    check_window(expires)
    process = subprocess.Popen(args, cwd=PLAY, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True)
    deadline = time.monotonic() + 180
    try:
        while True:
            require(lock.poll() is None, 'TARGET_LOCK_LOST')
            require(time.monotonic() < deadline, 'ANSIBLE_TIMEOUT')
            check_window(expires)
            try:
                output, _ = process.communicate(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                pass
    except BaseException:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
        raise
    require(lock.poll() is None, 'TARGET_LOCK_LOST')
    result = RECAP.findall(output.decode('utf-8', errors='replace'))
    require(process.returncode == 0 and len(result) == 1, 'ANSIBLE_FAILED')
    stats = {key: int(value) for key, value in (token.split('=') for token in result[0].split())}
    require(not any(stats[key] for key in ('failed', 'unreachable', 'ignored', 'rescued')), 'ANSIBLE_RESULT_FAILED')
    return stats


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan', 'apply', 'verify'))
    parser.add_argument('--authority', required=True)
    parser.add_argument('--lock', required=True, help='pinned project lock compiled for this attempt')
    parser.add_argument('--asset-directory', help='approved private directory with a file for each declared SHA-256')
    args = parser.parse_args()
    try:
        authority = object_bytes(trusted_read(args.authority, private=True))
        require(isinstance(authority, dict) and isinstance(authority.get('node_uid'), str)
                and NODE.fullmatch(authority['node_uid']) and authority.get('platform') in PLATFORMS,
                'TARGET_SCOPE_MISMATCH')
        lock_path = absolute(args.lock)
        require(lock_path.resolve(strict=True) == lock_path and lock_path.is_file(), 'UNTRUSTED_PROJECT_LOCK')
        compile_run = subprocess.run(['/usr/bin/python3', '-I', str(ROOT / 'config/management/compile_profiles.py'),
                                      '--lock', str(lock_path), '--node-uid', authority['node_uid'],
                                      '--platform', authority['platform']], capture_output=True, timeout=15,
                                     env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
        require(compile_run.returncode == 0, 'CONFIGURATION_COMPILE_REFUSED')
        projection = object_bytes(compile_run.stdout)
        owner_scope(authority, projection, args.action)
        target = authority['target']
        pin = known_host(target)
        assets = absolute(args.asset_directory) if args.asset_directory else None
        if assets is not None:
            require(assets.resolve(strict=True) == assets and assets.is_dir(), 'UNTRUSTED_ASSET_DIRECTORY')
        paths, packages = desired_resources(projection, target, assets)
        owner = []
        if 'owner_handoff' in authority:
            require(not paths and not packages, 'OWNER_HANDOFF_REQUIRES_SEPARATE_ATTEMPT')
            handoff = runpy.run_path(str(PLAY / 'owner_handoff.py'))['command']
            owner = handoff(authority['owner_handoff'], projection, target, args.action, require, absolute)
        package_action = []
        if packages and args.action != 'verify':
            guarded = runpy.run_path(str(PLAY / 'package_action.py'))['command']
            package_action = guarded(authority['tools'].get('package_runtime'), packages, args.action, require)
        selected = {claim['id'] for claim in projection['resources'] if claim['owner'] == 'ansible'
                    and claim['mode'] == 'manage' and claim['kind'] in {'path', 'package'}}
        if owner:
            selected.add(authority['owner_handoff']['resource_id'])
        require(selected, 'NO_AUTHORIZED_RESOURCE_ACTION')
        requested = {claim['id'] for claim in projection['resources'] if claim['mode'] == 'manage'
                     and claim['kind'] != 'package-db'}
        not_run = sorted(requested - selected)
        previous = os.umask(0o077)
        try:
            with tempfile.TemporaryDirectory(prefix='ghostfleet-config-') as temporary:
                scratch = Path(temporary)
                pins = scratch / 'known_hosts'
                pins.write_bytes(pin)
                env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': temporary,
                       'ANSIBLE_HOME': str(scratch / 'ansible'), 'ANSIBLE_CONFIG': str(PLAY / 'ansible.cfg')}
                owner_identity(authority['identity'], target['alias'], scratch, env)
                binary = engine(authority['tools'], env)
                options = ssh_options(target, pins)
                with node_lock(target, authority['platform'], paths, options, env, action=args.action,
                               projection=authority['projection_sha256'], expires=authority['expires_at']) as held:
                    stats = run_playbook(binary, scratch, args.action, target, options, paths, packages, owner, package_action,
                                         env, held, authority['expires_at'])
        finally:
            os.umask(previous)
        print(json.dumps({'schema': 'ghostfleet-config-result/v1', 'action': args.action, 'status': 'SUCCESS',
                          'node_uid': authority['node_uid'], 'projection_sha256': authority['projection_sha256'],
                          'simulation': args.action == 'plan', 'readback': args.action != 'plan' and not not_run,
                          'selected_resources': sorted(selected), 'managed_resources_not_run': not_run, 'recap': stats},
                         sort_keys=True))
        return 0
    except AttemptUnknown as error:
        print(json.dumps({'schema': 'ghostfleet-config-result/v1', 'action': args.action, 'status': 'UNKNOWN',
                          'reason': error.reason, 'attempt_id': error.attempt_id, 'readback': False}))
        return 3
    except (Refused, OSError, KeyError, TypeError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({'schema': 'ghostfleet-config-result/v1', 'action': args.action, 'status': 'BLOCKED',
                          'reason': str(error) if isinstance(error, Refused) else 'INVALID_INPUT_OR_EXECUTION_FAILURE'}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
