import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/heartbeat.py'
spec = importlib.util.spec_from_file_location('heartbeat', SOURCE)
hb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hb)
UID = 'node-' + '11111111-1111-4111-8111-111111111111'
TOKEN = 'gf_hb_' + 'a' * 43

def config(origin='https://node.example.invalid'):
    return {'origin': origin, 'node_uid': UID, 'reporting_token': TOKEN, 'units': dict(hb.DEFAULT_UNITS)}

class ClientTests(unittest.TestCase):
    def test_origin_no_public_plaintext_no_url_secrets(self):
        for value in ['http://example.invalid', 'https://' + 'u:p' + '@example.invalid', 'https://example.invalid/path',
                      'https://example.invalid?token=x', 'https://example.invalid#x', '', None]:
            with self.assertRaises(hb.ClientError): hb.check_origin(value, True)
        self.assertEqual(hb.check_origin('http://127.0.0.1:1234', True), 'http://127.0.0.1:1234')
        with self.assertRaises(hb.ClientError): hb.check_origin('http://127.0.0.1:1234')
    def test_fixed_unit_argv_no_shell(self):
        calls = []
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            return SimpleNamespace(returncode=0, stdout='LoadState=loaded\nActiveState=active\n')
        self.assertEqual(hb.service_state('ssh.service', run), 'active')
        self.assertNotIn('shell', calls[0][1])
        self.assertEqual(calls[0][0][-2:], ['--', 'ssh.service'])
        for unit in ['--version', 'ssh.service; id', '/tmp/x.service', 'x\ny.service']:
            with self.assertRaises(hb.ClientError): hb.service_state(unit, run)
        self.assertEqual(len(calls), 1)
    def test_missing_and_failed_not_healthy(self):
        for code, out, want in [(1, 'LoadState=not-found\nActiveState=inactive\n', 'not_found'),
                                (1, 'LoadState=loaded\nActiveState=active\n', 'unknown'),
                                (0, 'LoadState=loaded\nActiveState=failed\n', 'failed'),
                                (0, 'LoadState=loaded\nActiveState=activating\n', 'activating'),
                                (0, '', 'unknown')]:
            self.assertEqual(hb.service_state('ssh.service', lambda *a, **k: SimpleNamespace(returncode=code, stdout=out)), want)
    def test_timeout_maps_to_unknown(self):
        def timeout(*a, **k): raise subprocess.TimeoutExpired('systemctl', 5)
        self.assertEqual(hb.service_state('ssh.service', timeout), 'unknown')
    def test_config_rejects_permissions_and_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'c'; p.write_text(json.dumps(config())); p.chmod(0o600)
            self.assertEqual(hb.load_config(p)['node_uid'], UID)
            p.chmod(0o644)
            with self.assertRaises(hb.ClientError): hb.load_config(p)
            q = Path(d) / 'link'; q.symlink_to(p)
            with self.assertRaises(hb.ClientError): hb.load_config(q)
    def test_invalid_schema(self):
        for c in [{}, {**config(), 'command': 'not permitted'}, {**config(), 'units': {'ssh': 'ssh.service'}},
                  {**config(), 'node_uid': 'wrong'}, {**config(), 'reporting_token': 'bad'}]:
            with self.assertRaises(hb.ClientError): hb.validate_config(c)
    def test_report_has_no_credentials_or_command_vocabulary(self):
        with patch.object(hb, 'service_state', return_value='unknown'):
            report = hb.collect(config())
        self.assertEqual(set(report), {'protocol', 'boot_id', 'reporter_version', 'services'})
        self.assertNotIn(TOKEN, json.dumps(report))
    def test_install_is_bounded_idempotent_and_credential_private(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for _ in range(2): hb.install_files(config(), SOURCE.read_bytes(), root)
            p = root / hb.CONFIG.relative_to('/')
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            self.assertEqual(hb.load_config(p)['node_uid'], UID)
            self.assertFalse((root / 'etc/ssh').exists())
            manifest = json.loads((root / hb.MANIFEST.relative_to('/')).read_text())
            self.assertEqual(len(manifest['files']), 3)
            self.assertNotIn(TOKEN, json.dumps(manifest))
            self.assertIn('DynamicUser=yes', (root / hb.SERVICE.relative_to('/')).read_text())
    def test_installer_wont_overwrite_foreign_or_symlink_files(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); target = root / hb.SCRIPT.relative_to('/')
            target.parent.mkdir(parents=True); target.write_text('foreign file')
            with self.assertRaises(hb.ClientError): hb.install_files(config(), SOURCE.read_bytes(), root)
            self.assertEqual(target.read_text(), 'foreign file')
            target.unlink(); target.symlink_to(root / 'other')
            with self.assertRaises(hb.ClientError): hb.install_files(config(), SOURCE.read_bytes(), root)
    def test_parent_symlink_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); (root / 'etc').symlink_to(root / 'elsewhere')
            with self.assertRaises(hb.ClientError): hb.install_files(config(), SOURCE.read_bytes(), root)
    def test_dangling_config_symlink_refused_before_claim(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'presence.json'; p.symlink_to(Path(d) / 'absent')
            with patch.object(hb, 'CONFIG', p), patch.object(hb, 'MANIFEST', Path(d) / 'manifest'), \
                 patch.object(hb, 'check_owned_files'), patch.object(hb.os, 'geteuid', return_value=0), \
                 patch.object(hb.sys, 'platform', 'linux'), patch.object(hb.sys.stdin, 'isatty', return_value=True), \
                 patch.object(hb, 'post_json') as request:
                with self.assertRaisesRegex(hb.ClientError, 'TARGET_SYMLINK_REFUSED'):
                    hb.install(SimpleNamespace(origin='https://node.example.invalid'))
                request.assert_not_called()
    def test_production_unit_no_secret_in_env_or_argv(self):
        self.assertIn('LoadCredential=presence.json:', hb.SERVICE_TEXT)
        self.assertIn('Type=oneshot', hb.SERVICE_TEXT)
        self.assertIn('StandardOutput=file:/run/ghostfleet-heartbeat-services.json', hb.SERVICE_TEXT)
        self.assertIn('StandardError=journal', hb.SERVICE_TEXT)
        self.assertNotIn('Environment=', hb.SERVICE_TEXT)
        self.assertNotIn('Restart=', hb.SERVICE_TEXT)
        self.assertIn('OnUnitInactiveSec=60s', hb.TIMER_TEXT)

class RepairTests(unittest.TestCase):
    def test_repair_reuses_saved_identity_and_local_script_without_claim(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'presence.json'
            path.write_text(json.dumps(config()))
            path.chmod(0o600)
            installs = []; systemctl_calls = []; output = io.StringIO()

            def install(saved, source):
                installs.append((saved, source))

            def systemctl(*args):
                systemctl_calls.append(args)

            with patch.object(hb, 'CONFIG', path), patch.object(hb.os, 'geteuid', return_value=0), \
                 patch.object(hb, 'install_files', side_effect=install), \
                 patch.object(hb, 'systemctl', side_effect=systemctl), \
                 patch.object(hb, 'post_json') as request, contextlib.redirect_stdout(output):
                hb.repair()

            self.assertEqual(installs, [(config(), SOURCE.read_bytes())])
            request.assert_not_called()
            self.assertEqual(systemctl_calls, [
                ('daemon-reload',),
                ('enable', '--now', hb.TIMER.name),
                ('start', hb.SERVICE.name),
            ])
            self.assertEqual(output.getvalue().strip(), 'GF_REPAIRED; NO_NEW_TICKET_OR_NODE')


class NetworkTests(unittest.TestCase):
    def setUp(self):
        self.mode = 'ok'; self.hits = []; case = self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get('content-length', '0')))
                case.hits.append((self.path, self.headers.get('Authorization'), json.loads(body)))
                if case.mode == 'redirect':
                    self.send_response(307); self.send_header('Location', case.origin + '/redirect-target'); self.end_headers(); return
                if case.mode == 'denied':
                    self.send_response(401); self.end_headers(); self.wfile.write(TOKEN.encode()); return
                self.send_response(200); self.send_header('Content-Type', 'text/html' if case.mode == 'html' else 'application/json'); self.end_headers()
                data = {'ok': True, 'node_uid': UID, 'received_at': '2026-11-01T00:00:00Z'}
                self.wfile.write(b'x' * 5000 if case.mode == 'large' else json.dumps(data).encode())
            def log_message(self, *args): pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.origin = 'http://127.0.0.1:' + str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
    def test_actual_http_request_and_secret_free_stdout(self):
        output = io.StringIO()
        with patch.object(hb, 'service_state', return_value='active'), contextlib.redirect_stdout(output):
            hb.report(config(self.origin), True)
        self.assertEqual(output.getvalue().strip(), 'GF_HEARTBEAT_OK')
        self.assertEqual(self.hits[0][1], 'Bearer ' + TOKEN)
        self.assertNotIn(TOKEN, json.dumps(self.hits[0][2]))
    def test_redirect_is_not_followed_or_retried(self):
        self.mode = 'redirect'
        with self.assertRaisesRegex(hb.ClientError, 'REDIRECT_REFUSED'): hb.report(config(self.origin), True)
        self.assertEqual(len(self.hits), 1)
    def test_http_error_body_never_becomes_diagnostic(self):
        self.mode = 'denied'
        with self.assertRaises(hb.ClientError) as caught: hb.report(config(self.origin), True)
        self.assertEqual(str(caught.exception), 'HTTP_REJECT_401')
        self.assertNotIn(TOKEN, str(caught.exception)); self.assertEqual(len(self.hits), 1)
    def test_mime_and_size_guard(self):
        for mode, code in [('html', 'INVALID_RESPONSE_TYPE'), ('large', 'RESPONSE_TOO_LARGE')]:
            self.mode = mode
            with self.assertRaisesRegex(hb.ClientError, code): hb.report(config(self.origin), True)

class M3FixTests(unittest.TestCase):
    def test_credential_mode_boundary(self):
        # systemd 257 LoadCredential 0440 is accepted (group-read allowed);
        # group write/execute or any others bits are refused.
        for mode in [0o100440, 0o100400, 0o100600, 0o100640]:
            self.assertTrue(hb.credential_mode_ok(SimpleNamespace(st_mode=mode)), oct(mode))
        for mode in [0o100444, 0o100660, 0o100604, 0o100044]:
            self.assertFalse(hb.credential_mode_ok(SimpleNamespace(st_mode=mode)), oct(mode))
    def test_post_json_sends_user_agent(self):
        hits = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get('content-length', '0')))
                hits.append(self.headers.get('User-Agent'))
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(json.dumps({'ok': True}).encode())
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            hb.post_json('http://127.0.0.1:' + str(server.server_port), '/v1/heartbeat', {'ping': True}, allow_loopback=True)
        finally:
            server.shutdown(); server.server_close()
        self.assertEqual(hits, ['GhostFleet-Reporter/1'])
    def test_install_command_sends_user_agent(self):
        js = (Path(__file__).resolve().parents[1] / 'console' / 'app.js').read_text(encoding='utf-8')
        lines = [line for line in js.splitlines() if 'urllib.request.urlopen' in line]
        self.assertEqual(len(lines), 1)
        self.assertIn('GhostFleet-Reporter/1', lines[0])

class ServiceObservationTests(unittest.TestCase):
    def test_unit_keeps_dynamic_reporter_and_uses_bounded_root_probe(self):
        self.assertIn('DynamicUser=yes', hb.SERVICE_TEXT)
        self.assertIn('ExecStartPre=-!/usr/bin/python3 -I /usr/local/libexec/ghostfleet-heartbeat.py probe', hb.SERVICE_TEXT)
        self.assertIn('report --service-state-file /run/ghostfleet-heartbeat-services.json', hb.SERVICE_TEXT)
        self.assertIn('StandardOutput=file:/run/ghostfleet-heartbeat-services.json', hb.SERVICE_TEXT)
        self.assertIn('ReadWritePaths=/run/ghostfleet-heartbeat-services.json', hb.SERVICE_TEXT)
        self.assertIn('NoNewPrivileges=yes', hb.SERVICE_TEXT)
        self.assertRegex(hb.SERVICE_TEXT, r'(?m)^CapabilityBoundingSet=$')
        self.assertIn('ProtectSystem=strict', hb.SERVICE_TEXT)
        self.assertIn('ProtectHome=yes', hb.SERVICE_TEXT)

    def test_probe_requires_root_and_writes_only_service_states(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            config_path = root / 'presence.json'
            config_path.write_text(json.dumps(config()))
            config_path.chmod(0o600)
            snapshot = root / 'services.json'
            snapshot.touch()
            real_lstat = Path.lstat
            def fake_lstat(path):
                info = real_lstat(path)
                if path == snapshot:
                    return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_dev=info.st_dev, st_ino=info.st_ino)
                return info
            fd_info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0,
                                      st_dev=snapshot.stat().st_dev, st_ino=snapshot.stat().st_ino)
            calls = []
            def state(unit):
                calls.append(unit)
                return 'active' if unit == 'ssh.service' else 'not_found'
            with snapshot.open('wb') as output:
                with patch.object(hb, 'SERVICE_SNAPSHOT', snapshot), patch.object(hb.os, 'geteuid', return_value=0), patch.dict(os.environ, {'CREDENTIALS_DIRECTORY': str(root)}), patch.object(hb, 'service_state', side_effect=state), patch.object(hb.sys, 'stdout', output), patch.object(hb.os, 'fstat', return_value=fd_info), patch.object(Path, 'lstat', new=fake_lstat):
                    hb.probe()
                output.flush()
            self.assertEqual(calls, list(config()['units'].values()))
            self.assertEqual(snapshot.stat().st_mode & 0o777, 0o644)
            data = json.loads(snapshot.read_text())
            self.assertEqual(data['protocol'], hb.SERVICE_SNAPSHOT_PROTOCOL)
            self.assertGreaterEqual(hb.time.monotonic() - data['observed_at'], 0)
            self.assertLessEqual(hb.time.monotonic() - data['observed_at'], 30)
            self.assertEqual(data['services'], {'ssh': 'active', 'cloudflared': 'not_found', 'tailscaled': 'not_found'})
            self.assertNotIn(TOKEN, snapshot.read_text())
        with patch.object(hb.os, 'geteuid', return_value=1000):
            with self.assertRaisesRegex(hb.ClientError, 'SERVICE_PROBE_REQUIRES_ROOT'):
                hb.probe()

    def test_probe_rejects_untrusted_output_file_before_query(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            config_path = root / 'presence.json'
            config_path.write_text(json.dumps(config()))
            config_path.chmod(0o600)
            snapshot = root / 'services.json'
            snapshot.touch()
            with snapshot.open('wb') as output:
                with patch.object(hb, 'SERVICE_SNAPSHOT', snapshot), patch.object(hb.os, 'geteuid', return_value=0), patch.dict(os.environ, {'CREDENTIALS_DIRECTORY': str(root)}), patch.object(hb.sys, 'stdout', output), patch.object(hb.os, 'fstat', return_value=SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=1000)), patch.object(hb, 'service_state') as query:
                    with self.assertRaisesRegex(hb.ClientError, 'SERVICE_PROBE_OUTPUT_UNSAFE'):
                        hb.probe()
                    query.assert_not_called()

    def test_snapshot_reader_accepts_only_root_owned_private_service_map(self):
        good = SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_size=100)
        self.assertTrue(hb.service_snapshot_file_ok(good))
        for info in [
            SimpleNamespace(st_mode=stat.S_IFREG | 0o666, st_uid=0, st_size=100),
            SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=1000, st_size=100),
            SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_size=4097),
            SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0, st_size=100),
        ]:
            self.assertFalse(hb.service_snapshot_file_ok(info))

        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'services.json'
            path.write_text(json.dumps({
                'protocol': hb.SERVICE_SNAPSHOT_PROTOCOL,
                'observed_at': hb.time.monotonic(),
                'services': {'ssh': 'active', 'cloudflared': 'not_found', 'tailscaled': 'failed'},
            }))
            with patch.object(hb, 'service_snapshot_file_ok', return_value=True):
                self.assertEqual(hb.read_service_snapshot(path, config()['units']), {
                    'ssh': 'active', 'cloudflared': 'not_found', 'tailscaled': 'failed',
                })
                path.write_text(json.dumps({
                    'protocol': hb.SERVICE_SNAPSHOT_PROTOCOL,
                    'observed_at': hb.time.monotonic(),
                    'services': {'ssh': 'online', 'cloudflared': 'active', 'tailscaled': 'active'},
                }))
                self.assertEqual(hb.read_service_snapshot(path, config()['units']), {
                    'ssh': 'unknown', 'cloudflared': 'unknown', 'tailscaled': 'unknown',
                })
                path.unlink()
                path.symlink_to(Path(d) / 'missing')
                self.assertEqual(hb.read_service_snapshot(path, config()['units']), {
                    'ssh': 'unknown', 'cloudflared': 'unknown', 'tailscaled': 'unknown',
                })

    def test_snapshot_reader_rejects_stale_observation(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'services.json'
            path.write_text(json.dumps({
                'protocol': hb.SERVICE_SNAPSHOT_PROTOCOL,
                'observed_at': hb.time.monotonic() - 60,
                'services': {'ssh': 'active', 'cloudflared': 'active', 'tailscaled': 'active'},
            }))
            with patch.object(hb, 'service_snapshot_file_ok', return_value=True):
                self.assertEqual(hb.read_service_snapshot(path, config()['units']), {
                    'ssh': 'unknown', 'cloudflared': 'unknown', 'tailscaled': 'unknown',
                })

    def test_report_uses_precomputed_snapshot_without_unprivileged_systemctl(self):
        states = {'ssh': 'active', 'cloudflared': 'failed', 'tailscaled': 'not_found'}
        with patch.object(hb, 'read_service_snapshot', return_value=states), patch.object(hb, 'service_state', side_effect=AssertionError('report must not call systemctl')), patch.object(hb, 'post_json', return_value={'node_uid': UID, 'received_at': 'now'}) as post, contextlib.redirect_stdout(io.StringIO()):
            hb.report(config(), service_state_file=Path('/run/ghostfleet-heartbeat-services.json'))
        sent = post.call_args.args[2]
        self.assertEqual(sent['services'], states)
        self.assertNotIn(TOKEN, json.dumps(sent))

    def test_missing_snapshot_keeps_heartbeat_and_reports_unknown(self):
        with patch.object(hb, 'service_state', side_effect=AssertionError('must use snapshot path')), patch.object(hb, 'post_json', return_value={'node_uid': UID, 'received_at': 'now'}) as post, contextlib.redirect_stdout(io.StringIO()):
            hb.report(config(), service_state_file=Path('/nonexistent/ghostfleet/services.json'))
        self.assertEqual(post.call_args.args[2]['services'], {
            'ssh': 'unknown', 'cloudflared': 'unknown', 'tailscaled': 'unknown',
        })


if __name__ == '__main__': unittest.main()
