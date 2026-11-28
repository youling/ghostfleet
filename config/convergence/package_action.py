"""Use the existing Fleet Debian transaction guard without creating a package installer."""
import json
import re

HEX = re.compile(r'[a-f0-9]{64}')

REMOTE = r'''
from hashlib import sha256
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

pins, requested, action = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
base = ['/usr/bin/apt-get', '--no-upgrade', '--no-install-recommends', '--no-remove']
try:
    if os.geteuid() != 0 or importlib.metadata.version('youling-ai-hub-runner') != pins['runtime_version']:
        raise ValueError()
    for relative, key in (('system', 'system_sha256'), ('package_guard', 'guard_sha256')):
        origin = importlib.util.find_spec('youling_fleet.linux.' + relative).origin
        path = Path(origin)
        if path.resolve(strict=True) != path or any(
                parent.stat().st_uid != 0 or parent.stat().st_mode & 0o022 for parent in path.parents):
            raise ValueError()
        mode = path.stat()
        if (not stat.S_ISREG(mode.st_mode) or mode.st_uid != 0 or mode.st_mode & 0o022
                or sha256(path.read_bytes()).hexdigest() != pins[key]):
            raise ValueError()
    from youling_fleet.linux.system import CommandRunner, DebianFamily
    runner = CommandRunner()
    debian = DebianFamily(runner)
    code, audit = runner.run(['/usr/bin/dpkg', '--audit'])
    if code or audit.strip():
        raise ValueError()
    missing = {}
    for entry in requested:
        name, version = entry['name'], entry['version']
        current = debian.package(name)
        if current is None:
            missing[name] = version
        elif current != version:
            raise ValueError()
    if missing and action == 'apply':
        # This method checks the actual archives under APT's own transaction lock.
        debian.install(missing)
        # The original guard disables APT's global ConfigurePending operation.
        # Complete only the exact packages unpacked by this successful call.
        unpacked = []
        for name, version in sorted(missing.items()):
            code, status = runner.run(['/usr/bin/dpkg-query', '--show',
                                       '--showformat=${db:Status-Status} ${Version}', '--', name])
            if code or status not in {'installed ' + version, 'unpacked ' + version}:
                raise ValueError()
            if status == 'unpacked ' + version:
                unpacked.append(name)
        if unpacked:
            code, _ = runner.run(['/usr/bin/dpkg', '--configure', '--', *unpacked], timeout=300)
            if code:
                raise ValueError()
        code, audit = runner.run(['/usr/bin/dpkg', '--audit'])
        if code or audit.strip() or any(debian.package(name) != version for name, version in missing.items()):
            raise ValueError()
    elif missing:
        exact = [name + '=' + version for name, version in sorted(missing.items())]
        code, output = runner.run([*base, '--simulate', 'install', *exact])
        if code:
            raise ValueError()
        observed = {}
        for line in output.splitlines():
            if line.startswith('Remv ') or (line.startswith('Conf ') and line.split()[1] not in missing):
                raise ValueError()
            if line.startswith('Inst '):
                match = re.fullmatch(r'Inst ([a-z0-9+.-]+) \(([^ ]+) .+\)', line)
                if not match or match[1] in observed:
                    raise ValueError()
                observed[match[1]] = match[2]
        if observed != missing:
            raise ValueError()
    print(json.dumps({'changed': bool(missing)}, sort_keys=True))
except Exception:
    # Existing package tools can include private repository details in exceptions.
    print('{"status":"PACKAGE_TRANSACTION_REFUSED"}')
    raise SystemExit(1)
'''


def command(pins, packages, action, require):
    require(isinstance(pins, dict) and set(pins) == {'runtime_version', 'system_sha256', 'guard_sha256'},
            'EXISTING_PACKAGE_GUARD_REQUIRED')
    require(isinstance(pins['runtime_version'], str) and re.fullmatch(r'\d+\.\d+\.\d+', pins['runtime_version'])
            and all(isinstance(pins[key], str) and HEX.fullmatch(pins[key])
                    for key in ('system_sha256', 'guard_sha256')), 'EXISTING_PACKAGE_GUARD_PIN_INVALID')
    return ['/usr/bin/python3', '-IB', '-c', REMOTE, json.dumps(pins), json.dumps(packages), action]
