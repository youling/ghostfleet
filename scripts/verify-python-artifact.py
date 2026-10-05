"""Build and verify a wheel outside the checkout; never execute device helpers."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import venv
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / 'packages' / 'runtime-python'
CHECK = '''
import importlib.resources
import json
import pathlib
import ghostfleet_runtime
import ghostfleet_runtime.core.node_identity
import ghostfleet_runtime.core.registry_validator
from ghostfleet_runtime.core.profile_loader import load_profiles
from ghostfleet_runtime.resource_paths import resource_root, resource_path
import ghostfleet_runtime.linux.converger
import ghostfleet_runtime.windows.windows_enrollment
import ghostfleet_runtime.android.runtime
root = importlib.resources.files('ghostfleet_runtime')
paths = [
 'resources/fleet/00_shared/profiles/managed-linux.yaml',
 'resources/fleet/00_shared/schemas/enrollment-attempt.schema.json',
 'resources/fleet/10_platforms/linux/common/operations/jobs/fleet-jobctl.py',
 'resources/fleet/10_platforms/linux/common/operations/sessions/fleet-sessionctl.py',
 'resources/fleet/10_platforms/linux/common/operations/privileged/fleet_privctl.py',
 'resources/fleet/10_platforms/windows/common/onboarding/preflight/managed-windows-preflight.ps1',
 'resources/fleet/10_platforms/windows/common/onboarding/control/managed-windows-control.ps1',
]
for path in paths:
 assert len(root.joinpath(path).read_bytes()) > 0, 'RESOURCE_MISSING'
assert resource_root().is_relative_to(pathlib.Path.cwd()), 'RESOURCE_RESOLVER_ESCAPED_INSTALL'
assert resource_path('fleet/00_shared/schemas/enrollment-attempt.schema.json').is_file(), 'SCHEMA_RESOLVER_FAILED'
assert load_profiles(), 'DEFAULT_PACKAGED_PROFILES_NOT_LOADED'
assert pathlib.Path(ghostfleet_runtime.__file__).resolve().is_relative_to(pathlib.Path.cwd()), 'SOURCE_CHECKOUT_IMPORTED'
print(json.dumps({'installed_modules_imported': True, 'packaged_resources_read': len(paths), 'device_helpers_executed': False}))
'''


def run(stage, args, cwd, environment):
    print(json.dumps({'status': 'RUNNING', 'stage': stage}), flush=True)
    result = subprocess.run(args, cwd=cwd, env=environment, capture_output=True, text=True, timeout=180)
    if result.returncode:
        print(json.dumps({'status': 'FAILED', 'stage': stage, 'exit_code': result.returncode,
                          'diagnostic_sha256': hashlib.sha256((result.stdout + result.stderr).encode()).hexdigest()}))
        raise SystemExit(1)
    return result.stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--scratch', type=Path)
    args = parser.parse_args()
    scratch = args.scratch.resolve() if args.scratch else None
    if scratch:
        scratch.mkdir(parents=True, exist_ok=True)
        if scratch.is_relative_to(ROOT):
            raise SystemExit('ARTIFACT_SCRATCH_MUST_BE_OUTSIDE_CHECKOUT')
    environment = dict(os.environ)
    for name in tuple(environment):
        if name.upper() in ('PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONUSERBASE') or name.upper().startswith(('GHOSTFLEET_', 'FLEET_', 'OPENAI_', 'CHATGPT_')):
            environment.pop(name, None)
    with tempfile.TemporaryDirectory(prefix='ghostfleet-wheel-', dir=scratch) as temporary:
        owned = Path(temporary).resolve()
        if owned.is_relative_to(ROOT):
            raise SystemExit('ARTIFACT_TEST_MUST_BE_OUTSIDE_CHECKOUT')
        wheels = owned / 'wheels'
        wheels.mkdir()
        clean_package = owned / 'package'
        clean_package.mkdir()
        listed = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages/runtime-python'], cwd=ROOT)
        expected_payload = {}
        expected_licenses = {}
        source_digest = hashlib.sha256()
        for relative in sorted(set(listed.decode('utf-8').split('\0')) - {''}):
            source = ROOT / relative
            if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(PACKAGE):
                raise SystemExit('PACKAGE_SOURCE_PATH_UNSAFE')
            member = source.relative_to(PACKAGE)
            if '__pycache__' in member.parts or source.suffix in ('.pyc', '.pyo', '.pyd'):
                raise SystemExit('CACHE_IS_NOT_PACKAGE_SOURCE')
            raw = source.read_bytes()
            target = clean_package / member
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            source_digest.update(member.as_posix().encode() + b'\0' + raw + b'\0')
            if member.parts[0] == 'src':
                expected_payload[Path(*member.parts[1:]).as_posix()] = hashlib.sha256(raw).hexdigest()
            elif member.as_posix() in ('LICENSE', 'THIRD_PARTY_NOTICES.md'):
                expected_licenses[member.name] = hashlib.sha256(raw).hexdigest()
        run('build-wheel', [sys.executable, '-m', 'pip', '--isolated', 'wheel', '--no-deps',
                           '--index-url', 'https://pypi.org/simple', str(clean_package), '--wheel-dir', str(wheels)],
            owned, environment)
        candidates = list(wheels.glob('ghostfleet_runtime-*.whl'))
        if len(candidates) != 1:
            raise SystemExit('ONE_WHEEL_REQUIRED')
        actual_payload = {}
        actual_licenses = {}
        with zipfile.ZipFile(candidates[0]) as archive:
            names = archive.namelist()
            if len(set(names)) != len(names):
                raise SystemExit('WHEEL_DUPLICATE_ENTRY')
            for info in archive.infolist():
                member = Path(info.filename)
                if member.is_absolute() or '..' in member.parts or '__pycache__' in member.parts or member.suffix in ('.pyc', '.pyo', '.pyd'):
                    raise SystemExit('WHEEL_UNSAFE_PAYLOAD')
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise SystemExit('WHEEL_SYMLINK_PAYLOAD')
                if any(part.endswith('.dist-info') for part in member.parts):
                    if 'licenses' in member.parts:
                        actual_licenses[member.name] = hashlib.sha256(archive.read(info)).hexdigest()
                    continue
                actual_payload[member.as_posix()] = hashlib.sha256(archive.read(info)).hexdigest()
        if actual_payload != expected_payload or actual_licenses != expected_licenses:
            raise SystemExit('WHEEL_PAYLOAD_DIFFERS_FROM_CURRENT_SOURCE')
        venv.EnvBuilder(with_pip=True).create(owned / 'venv')
        executable = owned / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        run('install-wheel', [str(executable), '-m', 'pip', '--isolated', 'install',
                              '--index-url', 'https://pypi.org/simple', str(candidates[0])], owned, environment)
        proof = json.loads(run('installed-resource-readback', [str(executable), '-I', '-c', CHECK], owned, environment))
        if proof != {'installed_modules_imported': True, 'packaged_resources_read': 7,
                     'device_helpers_executed': False}:
            raise SystemExit('ARTIFACT_PROOF_INVALID')
        print(json.dumps({'status': 'PASS', 'wheel_sha256': hashlib.sha256(candidates[0].read_bytes()).hexdigest(),
                          'source_sha256': source_digest.hexdigest(), 'payload_files': len(actual_payload),
                          'license_files': len(actual_licenses), 'clean_package_build': True,
                          'no_extra_or_cached_payload': True, 'outside_checkout': True,
                          'pythonpath_cleared': True, **proof}), flush=True)


if __name__ == '__main__':
    main()
