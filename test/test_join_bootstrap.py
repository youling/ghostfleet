"""Execute the real POSIX shim and Panel command against a local HTTPS fixture.

Only OS identity, filesystem locations and package-manager effects are replaced.
The TTY guard, shell validation, generated command, curl/wget, TLS verification,
redirect handling, byte checks and digest checks execute normally. No sudo,
package manager, remote service or installed GhostFleet files are touched.
"""
from __future__ import annotations
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest

REPO = Path(__file__).resolve().parents[1]
TICKET = 'ticket-11111111-1111-4111-8111-111111111111'
PAYLOAD = b"import json,sys\nprint('SYNTHETIC_INSTALLER_ENTERED '+json.dumps(sys.argv[1:]))\n"
DIGEST = hashlib.sha256(PAYLOAD).hexdigest()
INSTALLER_PATH = '/bootstrap/' + DIGEST + '.py'

class HTTPSFixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.requests.append((self.path, self.headers.get('User-Agent')))
        status, body, headers = self.server.routes.get(self.path, (404, b'', {}))
        self.send_response(status)
        self.send_header('Content-Length', str(len(body)))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

class LocalHTTPSServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # TLS refusal / download-size negative controls may close mid-response.
        # Preserve unexpected fixture failures instead of hiding all errors.
        if not isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            super().handle_error(request, client_address)

class JoinBootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tools = {}
        for name in ['curl', 'wget', 'openssl', 'node', 'awk', 'chmod', 'mktemp',
                     'rm', 'sha256sum', 'tr', 'uname', 'wc']:
            binary = shutil.which(name)
            if not binary:
                raise RuntimeError('Regression prerequisite missing: ' + name)
            cls.tools[name] = binary
        cls.workspace = tempfile.TemporaryDirectory(prefix='.join-regression-', dir=REPO)
        cls.root = Path(cls.workspace.name)
        cls.cert, cls.key = cls.root / 'ca.pem', cls.root / 'key.pem'
        subprocess.run([cls.tools['openssl'], 'req', '-x509', '-newkey', 'rsa:2048',
                        '-nodes', '-keyout', str(cls.key), '-out', str(cls.cert),
                        '-days', '1', '-subj', '/CN=127.0.0.1',
                        '-addext', 'subjectAltName=IP:127.0.0.1'],
                       check=True, capture_output=True)
        cls.server = LocalHTTPSServer(('127.0.0.1', 0), HTTPSFixture)
        cls.server.routes, cls.server.requests = {}, []
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.cert, cls.key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = 'https://127.0.0.1:' + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.workspace.cleanup()

    def setUp(self):
        self.case = tempfile.TemporaryDirectory(prefix='case-', dir=self.root)
        self.addCleanup(self.case.cleanup)
        self.path = Path(self.case.name)
        self.bin = self.path / 'bin'
        self.bin.mkdir()
        self.temp = self.path / 'tmp'
        self.temp.mkdir()
        self.ca = self.path / 'trusted-ca.pem'
        self.ca.write_bytes(self.cert.read_bytes())
        self.os_release = self.path / 'os-release'
        self.os_release.write_text('ID=debian\n')
        self.python = self.path / 'python3'
        self.log = self.path / 'calls.jsonl'
        self.log.write_text('')
        self.env = os.environ.copy()
        for key in list(self.env):
            if key.lower().endswith('_proxy') or key in ('CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'WGETRC', 'CURL_HOME'):
                self.env.pop(key, None)
        self.env.update(PATH=str(self.bin), TMPDIR=str(self.temp),
                        NO_PROXY='127.0.0.1,localhost', GF_TEST_LOG=str(self.log),
                        GF_TEST_PYTHON=str(self.python), GF_TEST_VERSION='3.12.0',
                        GF_TEST_UID='0', LC_ALL='C')
        for name, binary in self.tools.items():
            if name not in ('openssl', 'node', 'wget'):
                (self.bin / name).symlink_to(binary)
        self.mock = self.path / 'mock-tool'
        self.mock.write_text('#!' + sys.executable + '\n' + r'''
import json,os,pathlib,sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['GF_TEST_LOG'], 'a') as log:
    log.write(json.dumps({'name': name, 'args': args}) + '\n')
if name == 'id':
    print(os.environ.get('GF_TEST_UID', '0')); raise SystemExit(0)
if name == 'sudo':
    os.environ['GF_TEST_UID'] = '0'
    os.execv(args[0], args)
if name in ('apt-get', 'dnf', 'yum'):
    expected = {
      'apt-get': [['update', '-qq'], ['install', '-y', '-qq', '--no-install-recommends', '--no-upgrade', 'python3']],
      'dnf': [['-y', '-q', '--setopt=install_weak_deps=False', 'install', 'python3']],
      'yum': [['-y', '-q', 'install', 'python3']],
    }
    if args not in expected[name]:
        raise SystemExit('Unexpected package effect: ' + repr(args))
    operation = 'update' if args[0] == 'update' else 'install'
    if os.environ.get('GF_TEST_FAIL') == name + ':' + operation:
        raise SystemExit(20)
    if operation == 'install' and not os.environ.get('GF_TEST_NO_INSTALL'):
        target = pathlib.Path(os.environ['GF_TEST_PYTHON'])
        target.write_bytes(pathlib.Path(__file__).read_bytes()); target.chmod(0o700)
    raise SystemExit(0)
if name == 'python3':
    if args[:2] == ['-I', '-c']:
        sys.version_info = tuple(map(int, os.environ['GF_TEST_VERSION'].split('.')))
        exec(compile(args[2], '<actual-version-check>', 'exec'))
    if len(args) > 2 and args[0] == '-I':
        os.execv(sys.executable, [sys.executable] + args)
raise SystemExit('Unexpected mock command: ' + name)
''')
        self.mock.chmod(0o700)
        for name in ['id', 'sudo', 'apt-get']:
            (self.bin / name).symlink_to(self.mock)
        self.make_python()
        template = (REPO / 'scripts/join.sh').read_text()
        self.shim_text = (template.replace('@INSTALLER_SHA256@', DIGEST)
                          .replace('@INSTALLER_BYTES@', str(len(PAYLOAD)))
                          .replace("PYTHON3='/usr/bin/python3'", "PYTHON3='" + str(self.python) + "'")
                          .replace("OS_RELEASE='/etc/os-release'", "OS_RELEASE='" + str(self.os_release) + "'")
                          .replace("DEBIAN_CA='/etc/ssl/certs/ca-certificates.crt'", "DEBIAN_CA='" + str(self.ca) + "'")
                          .replace("REDHAT_CA='/etc/pki/tls/certs/ca-bundle.crt'", "REDHAT_CA='" + str(self.ca) + "'")
                          .replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'PATH=' + str(self.bin))
                          .replace('/usr/bin/id -u', str(self.bin / 'id') + ' -u')
                          .replace('/tmp/ghostfleet-join.XXXXXX', str(self.temp / 'ghostfleet-join.XXXXXX')))
        self.shim = self.path / 'join.sh'
        self.shim.write_text(self.shim_text)
        self.server.routes = {INSTALLER_PATH: (200, PAYLOAD, {})}
        self.server.requests.clear()

    def make_python(self):
        if self.python.exists():
            self.python.unlink()
        self.python.symlink_to(self.mock)

    def calls(self, *names):
        return [row for row in map(json.loads, self.log.read_text().splitlines())
                if not names or row['name'] in names]

    def installer_calls(self):
        return [c for c in self.calls('python3') if c['args'][:2] != ['-I', '-c']]

    def use_wget(self):
        (self.bin / 'curl').unlink()
        (self.bin / 'wget').symlink_to(self.tools['wget'])

    def redhat(self, manager):
        self.os_release.write_text('ID=rhel\n')
        (self.bin / 'apt-get').unlink()
        (self.bin / manager).symlink_to(self.mock)

    def run_shell(self, command=None, *, tty=True, ticket=TICKET, extra=()):
        argv = ['/bin/sh', '-c', command] if command is not None else [
            '/bin/sh', str(self.shim), '--origin', self.origin, '--ticket', ticket, *extra]
        if tty:
            master, slave = pty.openpty()
            try:
                result = subprocess.run(argv, stdin=slave, capture_output=True, text=True,
                                        env=self.env, timeout=15)
            finally:
                os.close(slave); os.close(master)
        else:
            result = subprocess.run(argv, input='', capture_output=True, text=True,
                                    env=self.env, timeout=15)
        return result

    def good(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('SYNTHETIC_INSTALLER_ENTERED', result.stdout)
        self.assertEqual(len(self.installer_calls()), 1)
        self.assertEqual(list(self.temp.iterdir()), [], 'temporary download directories were not cleaned')

    def bad(self, result, diagnostic=None):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        if diagnostic:
            self.assertIn('GF_BOOTSTRAP_ERROR ' + diagnostic, result.stderr)
        self.assertFalse(self.installer_calls(), 'failure reached installer/claim handoff')
        self.assertEqual(list(self.temp.iterdir()), [])

    def generated_command(self):
        shell = self.shim_text.encode()
        digest = hashlib.sha256(shell).hexdigest()
        path = '/bootstrap/' + digest + '.sh'
        self.server.routes[path] = (200, shell, {})
        # Execute the actual generator body from app.js; do not reconstruct its
        # command in the test. The DOM is outside this pure generator's boundary.
        script = r'''
const fs=require('node:fs'), vm=require('node:vm');
const source=fs.readFileSync(process.argv[1],'utf8');
const start=source.indexOf('const quote ='), end=source.indexOf('async function makeTicket',start);
if(start<0||end<0)throw Error('Panel command generator not found');
const context={installer:{bootstrap:{url:process.argv[2],sha256:process.argv[3]}},nodeOrigin:process.argv[4]};
vm.createContext(context);
vm.runInContext(source.slice(start,end),context);
process.stdout.write(vm.runInContext('installCommand('+JSON.stringify(process.argv[5])+', true)',context));
'''
        generated = subprocess.run([self.tools['node'], '-e', script, str(REPO / 'console/app.js'),
                                    self.origin + path, digest, self.origin, TICKET],
                                   check=True, capture_output=True, text=True).stdout
        generated = generated.replace('/etc/ssl/certs/ca-certificates.crt', str(self.ca))
        generated = generated.replace('/etc/pki/tls/certs/ca-bundle.crt', str(self.ca))
        return generated, path

    def test_python_present_fast_path_and_valid_uuid(self):
        result = self.run_shell(extra=['--replace'])
        self.good(result)
        self.assertFalse(self.calls('apt-get', 'dnf', 'yum'))
        self.assertIn('--replace', self.installer_calls()[0]['args'])
        self.assertEqual(self.server.requests, [(INSTALLER_PATH, 'GhostFleet-Bootstrap/1')])

    def test_apt_installs_only_missing_python(self):
        self.python.unlink()
        self.good(self.run_shell())
        self.assertEqual([c['args'] for c in self.calls('apt-get')], [
            ['update', '-qq'], ['install', '-y', '-qq', '--no-install-recommends', '--no-upgrade', 'python3']])

    def test_dnf_installs_only_missing_python(self):
        self.python.unlink(); self.redhat('dnf')
        self.good(self.run_shell())
        self.assertEqual(len(self.calls('dnf')), 1)

    def test_yum_fallback_installs_only_missing_python(self):
        self.python.unlink(); self.redhat('yum')
        self.good(self.run_shell())
        self.assertEqual(len(self.calls('yum')), 1)

    def test_installed_python_too_old_never_calls_package_manager(self):
        self.env['GF_TEST_VERSION'] = '3.9.9'
        self.bad(self.run_shell(), 'PYTHON3_VERSION_UNSUPPORTED')
        self.assertFalse(self.calls('apt-get', 'dnf', 'yum'))
        self.assertFalse(self.server.requests)

    def test_minimum_python_version_is_accepted(self):
        self.env['GF_TEST_VERSION'] = '3.10.0'
        self.good(self.run_shell())
        self.assertFalse(self.calls('apt-get', 'dnf', 'yum'))

    def test_installed_package_still_too_old_stops_before_download(self):
        self.python.unlink(); self.env['GF_TEST_VERSION'] = '3.9.9'
        self.bad(self.run_shell(), 'PYTHON3_VERSION_UNSUPPORTED')
        self.assertFalse(self.server.requests)

    def test_successful_package_exit_without_python_is_refused(self):
        self.python.unlink(); self.env['GF_TEST_NO_INSTALL'] = '1'
        self.bad(self.run_shell(), 'PYTHON3_STILL_MISSING')
        self.assertFalse(self.server.requests)

    def test_apt_index_failure_preserves_ticket(self):
        self.python.unlink(); self.env['GF_TEST_FAIL'] = 'apt-get:update'
        self.bad(self.run_shell(), 'APT_INDEX_UPDATE_FAILED')
        self.assertEqual(len(self.calls('apt-get')), 1)
        self.assertFalse(self.server.requests)

    def test_apt_install_failure_preserves_ticket(self):
        self.python.unlink(); self.env['GF_TEST_FAIL'] = 'apt-get:install'
        self.bad(self.run_shell(), 'APT_DEPENDENCY_INSTALL_FAILED')
        self.assertFalse(self.server.requests)

    def test_dnf_install_failure_preserves_ticket(self):
        self.python.unlink(); self.redhat('dnf'); self.env['GF_TEST_FAIL'] = 'dnf:install'
        self.bad(self.run_shell(), 'DNF_DEPENDENCY_INSTALL_FAILED')
        self.assertFalse(self.server.requests)

    def test_yum_install_failure_preserves_ticket(self):
        self.python.unlink(); self.redhat('yum'); self.env['GF_TEST_FAIL'] = 'yum:install'
        self.bad(self.run_shell(), 'YUM_DEPENDENCY_INSTALL_FAILED')
        self.assertFalse(self.server.requests)

    def test_unknown_distro_refused_on_fast_path(self):
        self.os_release.write_text('ID=alpine\n')
        self.bad(self.run_shell(), 'UNSUPPORTED_DISTRIBUTION')
        self.assertFalse(self.calls('apt-get', 'dnf', 'yum'))

    def test_missing_package_manager_is_not_substituted(self):
        self.python.unlink(); (self.bin / 'apt-get').unlink()
        self.bad(self.run_shell(), 'PACKAGE_MANAGER_UNAVAILABLE')
        self.assertFalse(self.server.requests)

    def test_missing_ca_is_a_prerequisite_not_a_package_effect(self):
        self.python.unlink(); self.ca.unlink()
        self.bad(self.run_shell(), 'CA_BUNDLE_REQUIRED')
        self.assertFalse(self.calls('apt-get', 'dnf', 'yum'))
        self.assertFalse(self.server.requests)

    def test_missing_downloader_stops_before_packages(self):
        self.python.unlink(); (self.bin / 'curl').unlink()
        self.bad(self.run_shell(), 'CURL_OR_WGET_REQUIRED')
        self.assertFalse(self.calls('apt-get', 'dnf', 'yum'))

    def test_missing_hash_tool_stops_before_packages(self):
        self.python.unlink(); (self.bin / 'sha256sum').unlink()
        self.bad(self.run_shell(), 'SHA256SUM_REQUIRED')
        self.assertFalse(self.calls('apt-get', 'dnf', 'yum'))

    def test_noninteractive_input_is_refused(self):
        self.bad(self.run_shell(tty=False), 'INTERACTIVE_TERMINAL_REQUIRED')
        self.assertFalse(self.server.requests)

    def test_malformed_or_non_v4_tickets_fail_before_effects(self):
        for ticket in [TICKET.replace('ticket-', 'wrong-'), TICKET.replace('4111', '3111'),
                       TICKET.replace('8111', '7111'), TICKET.replace('11111111-', 'g1111111-', 1),
                       TICKET.replace('11111111-', '1111-111-', 1), TICKET + '-extra']:
            with self.subTest(ticket=ticket):
                self.bad(self.run_shell(ticket=ticket), 'INVALID_TICKET')
        self.assertFalse(self.calls())
        self.assertFalse(self.server.requests)

    def test_curl_installer_redirect_refused_even_with_matching_body(self):
        self.server.routes[INSTALLER_PATH] = (302, PAYLOAD, {'Location': '/redirected.py'})
        self.server.routes['/redirected.py'] = (200, PAYLOAD, {})
        self.bad(self.run_shell(), 'INSTALLER_DOWNLOAD_FAILED')
        self.assertEqual([x[0] for x in self.server.requests], [INSTALLER_PATH])

    def test_wget_installer_redirect_refused(self):
        self.use_wget()
        self.server.routes[INSTALLER_PATH] = (302, PAYLOAD, {'Location': '/redirected.py'})
        self.server.routes['/redirected.py'] = (200, PAYLOAD, {})
        self.bad(self.run_shell(), 'INSTALLER_DOWNLOAD_FAILED')
        self.assertEqual([x[0] for x in self.server.requests], [INSTALLER_PATH])

    def test_installer_wrong_hash_never_runs(self):
        changed = b'X' + PAYLOAD[1:]
        self.server.routes[INSTALLER_PATH] = (200, changed, {})
        self.bad(self.run_shell(), 'INSTALLER_HASH_MISMATCH')

    def test_installer_wrong_size_never_runs(self):
        self.server.routes[INSTALLER_PATH] = (200, PAYLOAD[:-1], {})
        self.bad(self.run_shell(), 'INSTALLER_SIZE_MISMATCH')

    def test_generated_curl_command_runs_both_pinned_stages(self):
        command, path = self.generated_command()
        self.good(self.run_shell(command))
        self.assertEqual(self.server.requests, [(path, 'GhostFleet-Bootstrap/1'), (INSTALLER_PATH, 'GhostFleet-Bootstrap/1')])
        self.assertIn('--replace', self.installer_calls()[0]['args'])
        self.assertNotIn('short_code', command)

    def test_generated_wget_command_runs_both_pinned_stages(self):
        self.use_wget()
        command, path = self.generated_command()
        self.good(self.run_shell(command))
        self.assertEqual(self.server.requests, [(path, 'GhostFleet-Bootstrap/1'), (INSTALLER_PATH, 'GhostFleet-Bootstrap/1')])

    def test_generated_curl_command_rejects_bootstrap_redirect(self):
        command, path = self.generated_command()
        _status, body, _headers = self.server.routes[path]
        self.server.routes[path] = (302, body, {'Location': '/redirected.sh'})
        self.server.routes['/redirected.sh'] = (200, body, {})
        self.bad(self.run_shell(command), 'BOOTSTRAP_HTTP_STATUS')
        self.assertEqual([x[0] for x in self.server.requests], [path])
        self.assertFalse(self.calls())

    def test_generated_wget_command_rejects_bootstrap_redirect(self):
        self.use_wget(); command, path = self.generated_command()
        _status, body, _headers = self.server.routes[path]
        self.server.routes[path] = (302, body, {'Location': '/redirected.sh'})
        self.server.routes['/redirected.sh'] = (200, body, {})
        self.bad(self.run_shell(command))
        self.assertEqual([x[0] for x in self.server.requests], [path])
        self.assertFalse(self.calls())

    def test_generated_command_rejects_bootstrap_wrong_hash(self):
        command, path = self.generated_command()
        self.server.routes[path] = (200, b'exit 0\n', {})
        self.bad(self.run_shell(command))
        self.assertFalse(self.calls())

    def test_generated_command_missing_ca_fails_before_download(self):
        command, _path = self.generated_command(); self.ca.unlink()
        self.bad(self.run_shell(command), 'CA_BUNDLE_REQUIRED')
        self.assertFalse(self.server.requests)
        self.assertFalse(self.calls())

    def test_existing_user_configs_cannot_enable_redirects(self):
        self.env['CURL_HOME'] = str(self.path)
        (self.path / '.curlrc').write_text('location\nmax-redirs=5\n')
        self.server.routes[INSTALLER_PATH] = (302, PAYLOAD, {'Location': '/redirected.py'})
        self.server.routes['/redirected.py'] = (200, PAYLOAD, {})
        self.bad(self.run_shell(), 'INSTALLER_DOWNLOAD_FAILED')
        self.assertEqual([x[0] for x in self.server.requests], [INSTALLER_PATH])

    def test_installer_tls_hostname_mismatch_is_refused(self):
        self.origin = self.origin.replace('127.0.0.1', 'localhost')
        self.bad(self.run_shell(), 'INSTALLER_DOWNLOAD_FAILED')
        self.use_wget()
        self.bad(self.run_shell(), 'INSTALLER_DOWNLOAD_FAILED')
        self.assertFalse(self.server.requests)

    def test_generated_command_tls_hostname_mismatch_is_refused(self):
        self.origin = self.origin.replace('127.0.0.1', 'localhost')
        command, _path = self.generated_command()
        self.bad(self.run_shell(command))
        self.use_wget()
        self.bad(self.run_shell(command))
        self.assertFalse(self.server.requests)
        self.assertFalse(self.calls())

    def test_sudo_reexecutes_same_verified_file_once(self):
        self.env['GF_TEST_UID'] = '1000'
        self.good(self.run_shell(extra=['--replace']))
        sudo = self.calls('sudo')
        self.assertEqual(len(sudo), 1)
        self.assertEqual(sudo[0]['args'][:2], ['/bin/sh', str(self.shim)])
        self.assertIn('--replace', sudo[0]['args'])

if __name__ == '__main__':
    unittest.main(verbosity=2)
