#!/usr/bin/env python3
"""Real local Worker/DO + reporter tests; optional temporary user-systemd units.
Requires npm ci and npm run build. Never deploys or changes SSH/providers.
"""
import argparse
import concurrent.futures
import json
import os
import re
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid


def assert_reporter_ok(result):
    # Emit only fixed reporter diagnostic codes, never raw output or credentials.
    codes = re.findall(r'^GF_ERROR ([A-Z0-9_]+)', result.stderr, re.MULTILINE)
    stdout_ok = result.stdout.strip() == 'GF_HEARTBEAT_OK'
    assert result.returncode == 0 and stdout_ok, (
        'REPORTER_FAILED exit=' + str(result.returncode) +
        ' stdout_match=' + str(stdout_ok) + ' codes=' + ','.join(codes))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--with-user-systemd', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    node = shutil.which('node')
    if not node or not (root / 'dist/wrangler.json').is_file():
        raise RuntimeError('Run npm ci and npm run build first with Node 22+')
    if args.with_user_systemd:
        check = subprocess.run(['systemctl', '--user', 'show-environment'], capture_output=True)
        if check.returncode: raise RuntimeError('User systemd manager required; test was not run')
    with tempfile.TemporaryDirectory(prefix='ghostfleet-presence-test-') as temporary:
        run = Path(temporary)
        (run / 'home').mkdir()
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
        origin = 'http://127.0.0.1:' + str(port)
        operator = 'synthetic-operator-' + uuid.uuid4().hex
        reader = 'synthetic-reader-' + uuid.uuid4().hex
        config = json.loads((root / 'dist/wrangler.json').read_text())
        config['main'] = str(root / 'src/adapters/cloudflare/worker.js')
        config['assets']['directory'] = str(root / 'dist/console')
        config['vars'].update(GHOSTFLEET_PANEL_ORIGIN=origin, GHOSTFLEET_NODE_ORIGIN=origin,
                              GHOSTFLEET_OPERATOR_TOKEN=operator, GHOSTFLEET_READ_TOKEN=reader)
        config_path = run / 'wrangler.json'
        config_path.write_text(json.dumps(config)); config_path.chmod(0o600)
        # No provider/account credential environment or native owner config.
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(run / 'home'),
               'XDG_CONFIG_HOME': str(run / 'home/config'), 'CI': 'true', 'WRANGLER_SEND_METRICS': 'false'}
        log = (run / 'runtime.log').open('w')
        process = None
        timer = service = None
        passed = []

        def api(path, body=None, token=operator):
            request = urllib.request.Request(origin + path,
                data=None if body is None else json.dumps(body).encode(),
                headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(request, timeout=12) as response:
                    return response.status, json.loads(response.read())
            except urllib.error.HTTPError as error:
                return error.code, json.loads(error.read())

        def start():
            nonlocal process
            process = subprocess.Popen([node, str(root / 'node_modules/wrangler/bin/wrangler.js'),
                'dev', '--local', '--config', str(config_path), '--ip', '127.0.0.1',
                '--port', str(port), '--inspector-port', '0', '--persist-to', str(run / 'state')],
                cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            for _ in range(120):
                if process.poll() is not None: raise RuntimeError('LOCAL_WORKER_EXITED')
                try:
                    if api('/v0/access')[0] == 200: return
                except Exception: pass
                time.sleep(.5)
            raise RuntimeError('LOCAL_WORKER_START_TIMEOUT')

        def stop():
            nonlocal process
            if process is None: return
            group = process.pid
            try: os.killpg(group, signal.SIGTERM)
            except ProcessLookupError: pass
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(group, signal.SIGKILL); process.wait(timeout=5)
            try: os.killpg(group, signal.SIGKILL)
            except ProcessLookupError: pass
            process = None
            for _ in range(20):
                with socket.socket() as s:
                    s.settimeout(.2)
                    if s.connect_ex(('127.0.0.1', port)) != 0: return
                time.sleep(.1)
            raise RuntimeError('OWNED_TEST_PORT_DID_NOT_CLOSE')

        def check(name):
            passed.append(name); print('PASS ' + name, flush=True)

        def ctl(*values):
            return subprocess.run(['systemctl', '--user', *values], capture_output=True, text=True, timeout=10)

        def journal():
            return subprocess.run(['journalctl', '--user', '-u', service, '--no-pager', '-o', 'cat'],
                capture_output=True, text=True, timeout=10).stdout

        def current(uid):
            status, data = api('/v0/nodes', token=reader)
            assert status == 200
            return next(n for n in data['nodes'] if n['node_uid'] == uid)

        try:
            start(); check('real_workerd_DO_started')
            status, delivery = api('/v0/enrollment-tickets', {'label': 'synthetic-live-fixture'})
            assert status == 201
            path = '/v1/enrollment-tickets/' + delivery['ticket']['ticket_id'] + '/claim'
            with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
                claims = list(pool.map(lambda _: api(path, {'short_code': delivery['short_code']}, token=''), range(12)))
            assert sum(s == 200 for s, _ in claims) == 1
            assert sum(s == 409 for s, _ in claims) == 11
            claimed = next(p for s, p in claims if s == 200)
            uid, token = claimed['node_uid'], claimed['reporting_token']
            check('real_DO_12_concurrent_claims_exactly_one')
            assert api('/v0/enrollment-tickets', {'label': 'denied'}, token=reader)[0] == 403
            check('read_role_mutation_denied')
            credential = run / 'presence.json'
            credential.write_text(json.dumps({'origin': origin, 'node_uid': uid, 'reporting_token': token,
                'units': {'ssh': 'ssh.service', 'cloudflared': 'ghostfleet-synthetic-absent.service', 'tailscaled': 'tailscaled.service'}}))
            credential.chmod(0o600)
            python = shutil.which('python3')
            command = [python, '-I', str(root / 'scripts/heartbeat.py'), 'report', '--config', str(credential), '--allow-loopback-http']
            result = subprocess.run(command, capture_output=True, text=True, timeout=35)
            assert_reporter_ok(result)
            assert token not in result.stdout + result.stderr
            n = current(uid)
            assert n['presence'] == 'ONLINE' and n['lifecycle'] == 'PROVISIONAL'
            assert n['report']['services']['cloudflared'] == 'not_found'
            check('actual_Python_reporter_HTTP_and_truthful_missing_unit')
            stop(); start()
            assert current(uid)['presence'] == 'ONLINE'
            assert_reporter_ok(subprocess.run(command, capture_output=True, text=True, timeout=35))
            check('real_DO_persistence_after_runtime_restart')
            if args.with_user_systemd:
                name = 'ghostfleet-presence-test-' + uuid.uuid4().hex[:10]
                timer, service = name + '.timer', name + '.service'
                launch = ['systemd-run', '--user', '--unit=' + name, '--on-active=1s', '--on-unit-inactive=2s',
                    '--timer-property=AccuracySec=100ms', '--property=Type=oneshot',
                    '--property=LoadCredential=presence.json:' + str(credential),
                    '--property=StandardOutput=journal', '--property=StandardError=journal',
                    python, '-I', str(root / 'scripts/heartbeat.py'), 'report', '--allow-loopback-http']
                assert subprocess.run(launch, capture_output=True, timeout=15).returncode == 0
                first = current(uid)['last_seen_at']; time.sleep(5)
                second = current(uid)['last_seen_at']; assert second != first
                check('real_user_systemd_timer_oneshot_LoadCredential')
                stop(); time.sleep(5)
                # Result can temporarily reset to success while the next invocation
                # is starting. Assert the actual journal event, not that race.
                assert 'GF_ERROR NETWORK_OR_TLS_FAILURE' in journal()
                check('network_outage_report_failure')
                start()
                for _ in range(30):
                    if current(uid)['last_seen_at'] != second: break
                    time.sleep(.5)
                assert current(uid)['last_seen_at'] != second
                check('timer_recovers_after_network_return')
            assert api('/v0/nodes/' + uid + '/revoke', {})[0] == 200
            frozen = current(uid)['last_seen_at']
            result = subprocess.run(command, capture_output=True, text=True, timeout=35)
            assert result.returncode == 1 and 'HTTP_REJECT_401' in result.stderr
            if args.with_user_systemd: time.sleep(4)
            n = current(uid)
            assert n['presence'] == 'REVOKED' and n['last_seen_at'] == frozen
            check('revocation_rejects_report_no_last_seen_update')
            if args.with_user_systemd:
                ctl('stop', timer, service)
                records = journal()
                assert 'GF_HEARTBEAT_OK' in records and 'HTTP_REJECT_401' in records
                assert token not in records and operator not in records
                check('journald_success_failure_no_secret')
            stop(); log.flush()
            assert 'Uncaught' not in (run / 'runtime.log').read_text()
            print('LIVE_PRESENCE_OK cases=' + str(len(passed)) + ' user_systemd=' + str(args.with_user_systemd).lower())
            print('NOT_PRODUCTION: no real domains, credentials, system-unit install, SSH or provider changes')
        finally:
            if timer: ctl('stop', timer)
            if service: ctl('stop', service); ctl('reset-failed', service)
            stop(); log.close()


if __name__ == '__main__':
    main()
