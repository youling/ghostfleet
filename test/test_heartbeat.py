import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
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
UID = 'node-11111111-1111-4111-8111-111111111111'
TOKEN = 'gf_hb_' + 'a' * 43

def config(origin='https://node.example.invalid'):
    return {'origin': origin, 'node_uid': UID, 'reporting_token': TOKEN, 'units': dict(hb.DEFAULT_UNITS)}

class ClientTests(unittest.TestCase):
    def test_origin_no_public_plaintext_no_url_secrets(self):
        for value in ['http://example.invalid', 'https://u:p@example.invalid', 'https://example.invalid/path',
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
    def test_production_unit_no_secret_in_env_or_argv(self):
        self.assertIn('LoadCredential=presence.json:', hb.SERVICE_TEXT)
        self.assertIn('Type=oneshot', hb.SERVICE_TEXT)
        self.assertIn('StandardOutput=journal', hb.SERVICE_TEXT)
        self.assertNotIn('Environment=', hb.SERVICE_TEXT)
        self.assertNotIn('Restart=', hb.SERVICE_TEXT)
        self.assertIn('OnUnitInactiveSec=60s', hb.TIMER_TEXT)

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

if __name__ == '__main__': unittest.main()
