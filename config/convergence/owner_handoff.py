"""Build a locked call to an existing component owner entrypoint."""
import json
from pathlib import Path
import re

DIGEST = re.compile(r'[0-9a-f]{64}')
COMPONENTS = {
    'ghostfleet-installer': ('ghostfleet', 'ghostfleet:installer'),
    'linux-converger': ('converger', 'fleet:primary-converger'),
}
BOOTSTRAP = {
    'install.py', 'enroll.py', 'node.py', 'update.py', 'report.py', 'native.py',
    'ghostfleet-nextgen-report.service', 'ghostfleet-nextgen-report.timer',
    'ghostfleet-nextgen-update.service', 'ghostfleet-nextgen-update.timer',
    'ghostfleet-nextgen-k3s-agent.service', 'install-profile.schema.json', 'OPERATIONS.md',
}

REMOTE = r'''
from hashlib import sha256
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

request, action, uid = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3]
component = request['component']

def approved_file(value, expected, private=False):
    path = Path(value)
    if path.resolve(strict=True) != path:
        raise ValueError()
    if any(parent.stat().st_uid != 0 or parent.stat().st_mode & 0o022 for parent in path.parents):
        raise ValueError()
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_size > 1048576:
        raise ValueError()
    body = path.read_bytes()
    if info.st_mode & (0o077 if private else 0o022) or sha256(body).hexdigest() != expected:
        raise ValueError()
    return body

try:
    if os.geteuid() != 0:
        raise ValueError()
    config = request['profile']
    profile = json.loads(approved_file(config, request['profile_sha256'], True))
    if component == 'ghostfleet-installer':
        if profile.get('schema') != 'ghostfleet-install/v1' or profile.get('enrollment', {}).get('node_uid') != uid:
            raise ValueError()
        if profile.get('components', {}).get('k3s', {'role': 'none'}) != {'role': 'none'}:
            raise ValueError()
        directory = Path(request['bootstrap_directory'])
        if {item.name for item in directory.iterdir()} != set(request['bootstrap_files']):
            raise ValueError()
        for name, digest in request['bootstrap_files'].items():
            approved_file(directory / name, digest)
        original_action = {'plan': 'plan', 'verify': 'status', 'apply': 'apply'}[action]
        argv = ['/usr/bin/python3', '-IB', str(directory / 'install.py'), original_action, config]
    else:
        if profile.get('manifest', {}).get('node_uid') != uid:
            raise ValueError()
        if importlib.metadata.version('youling-ai-hub-runner') != request['runtime_version']:
            raise ValueError()
        spec = importlib.util.find_spec('youling_fleet.linux.cli')
        approved_file(spec.origin, request['module_sha256'])
        argv = ['/usr/bin/python3', '-I', '-m', 'youling_fleet.linux.cli', '--config', config]
        if action == 'apply':
            argv.append('--apply')
    clean = {'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
    final = subprocess.run(argv, env=clean, capture_output=True, timeout=135)
    if final.returncode != 0 or len(final.stdout) > 262144:
        raise ValueError()
    reply = json.loads(final.stdout)
    if component == 'ghostfleet-installer':
        accepted = {'plan': {'PLAN'}, 'apply': {'APPLIED','UNCHANGED'}, 'verify': {'STATUS'}}
        if reply.get('node_uid') != uid or reply.get('result') not in accepted[action]:
            raise ValueError()
        if action == 'verify':
            timers = ('ghostfleet-nextgen-update.timer', 'ghostfleet-nextgen-report.timer')
            expected = {'ActiveState': 'active', 'UnitFileState': 'enabled'}
            if (reply.get('identity') != 'present' or not reply.get('installed_release') or reply.get('files')
                    or reply.get('units') or any(reply.get('services', {}).get(unit) != expected for unit in timers)):
                raise ValueError()
        changed = reply['result'] == 'APPLIED' or (action == 'plan' and bool(reply['files'] or reply['units']))
    else:
        if action == 'plan':
            if reply.get('outcome') != 'PLAN_ONLY_NOT_VERIFIED':
                raise ValueError()
            changed = False
        else:
            if (reply.get('outcome') != 'PRIMARY_CONVERGED' or reply.get('node_uid') != uid or
                    not reply.get('postconditions_digest')):
                raise ValueError()
            changed = bool(reply.get('material_delta'))
    print(json.dumps({'owner': component, 'changed': changed}, sort_keys=True))
except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError, ImportError):
    print('{"status":"OWNER_HANDOFF_REFUSED"}')
    raise SystemExit(1)
'''


def command(spec, projection, target, action, require, absolute):
    component = spec.get('component') if isinstance(spec, dict) else None
    require(component in COMPONENTS and target['user'] == 'root', 'OWNER_HANDOFF_SCOPE_INVALID')
    required = {'component', 'resource_id', 'profile', 'profile_sha256'}
    if component == 'ghostfleet-installer':
        require(set(spec) == required | {'bootstrap_directory', 'bootstrap_files'}, 'OWNER_HANDOFF_FIELDS_INVALID')
        absolute(spec['bootstrap_directory'])
        files = spec['bootstrap_files']
        require(isinstance(files, dict) and set(files) == BOOTSTRAP and all(
            isinstance(value, str) and DIGEST.fullmatch(value) for value in files.values()), 'BOOTSTRAP_MANIFEST_INCOMPLETE')
    else:
        require(set(spec) == required | {'runtime_version', 'module_sha256'}, 'OWNER_HANDOFF_FIELDS_INVALID')
        require(action != 'verify' and isinstance(spec['runtime_version'], str)
                and re.fullmatch(r'\d+\.\d+\.\d+', spec['runtime_version'])
                and isinstance(spec['module_sha256'], str) and DIGEST.fullmatch(spec['module_sha256']),
                'CONVERGER_ACTION_OR_PIN_INVALID')
    absolute(spec['profile'])
    require(isinstance(spec['profile_sha256'], str) and DIGEST.fullmatch(spec['profile_sha256']),
            'OWNER_PROFILE_PIN_REQUIRED')
    claims = [resource for resource in projection['resources'] if resource.get('id') == spec['resource_id']]
    owner, key = COMPONENTS[component]
    require(projection['target']['platform'] == 'debian13-amd64' and len(claims) == 1
            and claims[0].get('owner') == owner and claims[0].get('scope') == 'host'
            and claims[0].get('kind') == 'lifecycle' and claims[0].get('mode') == 'manage'
            and claims[0].get('key') == key, 'OWNER_LIFECYCLE_CLAIM_REQUIRED')
    desired = claims[0].get('desired')
    expected = ({'state': 'present'} if component == 'ghostfleet-installer'
                else {'state': 'present', 'version': spec['runtime_version']})
    require(desired == expected, 'OWNER_LIFECYCLE_DESIRED_MISMATCH')
    return ['/usr/bin/python3', '-I', '-c', REMOTE, json.dumps(spec), action, projection['target']['node_uid']]
