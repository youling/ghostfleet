"""Host and reporter stage of the owner-authorized managed bootstrap."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

import heartbeat


PAIR = re.compile(r'[0-9a-f]{64}')
CODE = re.compile(r'[0-9A-HJKMNP-TV-Z]{6}', re.ASCII | re.IGNORECASE)
PROOF_FIELDS = {'request_id', 'request_secret', 'short_code'}
MANAGED_PROFILE = 'FULL_MANAGED_LOWER_NODE'


def check_local_host():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise heartbeat.ClientError('OWNER_ROOT_TERMINAL_REQUIRED')
    if sys.version_info < (3, 10):
        raise heartbeat.ClientError('PYTHON_3_10_REQUIRED')
    omv = Path('/etc/openmediavault')
    if omv.exists() or omv.is_symlink():
        raise heartbeat.ClientError('OMV_PROFILE_REQUIRES_OWNER_PREFLIGHT')
    if Path('/proc/1/comm').read_text().strip() != 'systemd' or not Path('/run/systemd/system').is_dir():
        raise heartbeat.ClientError('SYSTEMD_MANAGER_REQUIRED')


def check_install_paths():
    paths = (heartbeat.CONFIG, heartbeat.MANIFEST, heartbeat.SCRIPT, heartbeat.SERVICE, heartbeat.TIMER)
    for pathname in paths:
        for location in [pathname, *pathname.parents]:
            try:
                info = location.lstat()
            except FileNotFoundError:
                continue
            matches_type = stat.S_ISREG(info.st_mode) if location == pathname else stat.S_ISDIR(info.st_mode)
            if not matches_type or info.st_uid != 0 or info.st_mode & 0o022:
                raise heartbeat.ClientError('UNSAFE_REPORTER_INSTALL_PATH')
    heartbeat.check_owned_files()


def read_proof(raw):
    if len(raw) > 1024:
        raise heartbeat.ClientError('INVALID_MANAGED_PAIRING_PROOF')
    try:
        proof = json.loads(raw)
    except (UnicodeError, ValueError):
        raise heartbeat.ClientError('INVALID_MANAGED_PAIRING_PROOF') from None
    if not isinstance(proof, dict) or set(proof) != PROOF_FIELDS or any(not isinstance(v, str) for v in proof.values()):
        raise heartbeat.ClientError('INVALID_MANAGED_PAIRING_PROOF')
    if not PAIR.fullmatch(proof['request_id']) or not PAIR.fullmatch(proof['request_secret']) or not CODE.fullmatch(proof['short_code']):
        raise heartbeat.ClientError('INVALID_MANAGED_PAIRING_PROOF')
    proof['short_code'] = proof['short_code'].upper()
    return proof


def install(origin, raw, reporter_source):
    check_local_host()
    check_install_paths()
    approved_origin = heartbeat.check_origin(origin)
    proof = read_proof(raw)
    existing = heartbeat.load_config(heartbeat.CONFIG) if heartbeat.CONFIG.exists() else None
    if existing:
        if existing['origin'] != approved_origin:
            raise heartbeat.ClientError('EXISTING_REPORTER_ORIGIN_MISMATCH')
        proof['expected_node_uid'] = existing['node_uid']
    try:
        receipt = heartbeat.post_json(approved_origin, '/v1/managed-enrollment/claim', proof)
    except heartbeat.ClientError as error:
        raise heartbeat.ClientError(str(error) + ' MANAGED_CLAIM_NOT_RETRIED') from None
    if receipt.get('profile') != MANAGED_PROFILE or set(receipt) != {'ok', 'node_uid', 'profile', 'reporting_token'}:
        raise heartbeat.ClientError('INVALID_MANAGED_REPORTER_RECEIPT')
    config = heartbeat.validate_config({'origin': approved_origin, 'node_uid': receipt['node_uid'],
        'reporting_token': receipt['reporting_token'], 'units': heartbeat.DEFAULT_UNITS})
    heartbeat.install_claimed_reporter(config, reporter_source, existing)


def main(reporter_source):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True)
    args = parser.parse_args()
    try:
        install(args.origin, sys.stdin.buffer.read(1025), reporter_source)
        print('GF_MANAGED_HOST_STAGE_OK REPORTER_STARTED')
        return 0
    except heartbeat.ClientError as error:
        print('GF_MANAGED_HOST_ERROR ' + str(error), file=sys.stderr)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        print('GF_MANAGED_HOST_ERROR LOCAL_OPERATION_FAILED', file=sys.stderr)
    return 1
