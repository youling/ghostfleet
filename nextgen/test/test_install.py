"""Regressions for installer preflight. Real activation uses Debian guest tests."""
import contextlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'host'))
import install


class InstallPreflightTest(unittest.TestCase):
    def setUp(self):
        self.context = contextlib.ExitStack()
        self.addCleanup(self.context.close)
        root = Path(self.context.enter_context(tempfile.TemporaryDirectory()))
        self.state = root / 'state'
        self.private = self.state / 'private'
        self.install_state = self.state / 'installer'
        lib = root / 'lib'
        etc = root / 'etc'
        units = root / 'systemd'
        self.file = lib / 'report.py'
        keyring = root / 'archive.gpg'
        self.config = {'schema': install.SCHEMA,
                       'enrollment': {'node_uid': 'node-' + str(UUID('11111111-1111-4111-8111-111111111111')),
                                      'origin': 'https://node.example.invalid'},
                       'components': {'k3s': {'role': 'none'}},
                       'update': {'keyring': str(keyring), 'fingerprint': 'A' * 40}, 'previous_files': {}}
        self.files = {keyring: ('c' * 64, 0o644), self.file: ('a' * 64, 0o644)}
        self.context.enter_context(patch.multiple(install, STATE=self.state, INSTALL=self.install_state,
                                                  PRIVATE=self.private, RECEIPT=self.install_state / 'receipt.json',
                                                  LIB=lib, ETC=etc, UNITS=units, SOFTWARE=self.state / 'software'))
        self.context.enter_context(patch.object(install.update, 'active', return_value=None))
        self.context.enter_context(patch.object(install, 'identity_state', return_value='present'))
        self.context.enter_context(patch.object(install, 'file_snapshot', side_effect=self.files.get))
        self.context.enter_context(patch.object(install, 'desired_files', return_value={self.file: (b'reviewed reporter', 0o644)}))
        self.context.enter_context(patch.object(install, 'service_state', return_value={
            'LoadState': 'loaded', 'ActiveState': 'active', 'UnitFileState': 'enabled'}))
        self.receipt = self.context.enter_context(patch.object(install, 'read_receipt', return_value=None))

    def test_does_not_overwrite_an_untracked_file_with_other_bytes(self):
        with self.assertRaisesRegex(install.update.UpdateError, 'UNMANAGED_FILE_CONFLICT:report.py'):
            install.inspect(self.config, False)
        self.assertFalse(self.state.exists())

    def test_approved_prior_file_and_installer_owned_drift_are_recognized(self):
        self.config['previous_files'][self.file.name] = 'a' * 64
        plan = install.inspect(self.config, False)
        self.assertIn(str(self.file), plan[-1])
        self.receipt.return_value = plan[2]
        self.files[self.file] = ('b' * 64, 0o644)
        self.assertIn(str(self.file), install.inspect(self.config, False)[-1])

    def test_archive_trust_change_rejected_before_planning_writes(self):
        self.config['previous_files'][self.file.name] = 'a' * 64
        self.receipt.return_value = install.inspect(self.config, False)[2]
        self.config['update']['fingerprint'] = 'F' * 40
        with self.assertRaisesRegex(install.update.UpdateError, 'TRUST_ROOT_CHANGED'):
            install.inspect(self.config, False)

    def test_old_profile_cannot_restore_trust_after_external_rotation(self):
        self.config['previous_files'][self.file.name] = 'a' * 64
        self.receipt.return_value = install.inspect(self.config, False)[2]
        current = install.ETC / 'update.json'
        real_exists = install.exists
        with (patch.object(install, 'exists', side_effect=lambda path: path == current or real_exists(path)),
              patch.object(install.update, 'settings', return_value={**self.config['update'], 'fingerprint': 'F' * 40})):
            with self.assertRaisesRegex(install.update.UpdateError, 'TRUST_ROOT_CHANGED'):
                install.inspect(self.config, False)

    def test_healthy_files_and_running_timers_have_no_local_changes(self):
        self.files[self.file] = (install.checksum(b'reviewed reporter'), 0o644)
        self.receipt.return_value = install.inspect(self.config, False)[2]
        report = install.execute('status', {**self.config, 'components': {
            'tailscale': 'none', 'cloudflare': 'none', 'k3s': {'role': 'none'}}}, False)
        self.assertEqual(report['files'], [])
        self.assertEqual(report['units'], [])
        self.assertEqual(report['identity'], 'present')
        self.assertFalse(self.state.exists())

    def test_prepared_agent_does_not_start_after_external_ownership_appears(self):
        with (patch.object(install, 'service_state', return_value={'ActiveState': 'inactive'}),
              patch.object(install.native, 'discover', return_value={'k3s-ownership': {'state': 'detected'}}),
              patch.object(install.native, 'agent_plan', return_value={'outcome': 'OWNERSHIP_REVIEW'}),
              patch.object(install.native, 'preparation_plan', return_value={'outcome': 'PREPARE_DEDICATED_AGENT'}),
              patch.object(install.update, 'command') as command):
            with self.assertRaisesRegex(install.update.UpdateError, 'K3S_START_OWNERSHIP_REVIEW'):
                install.enable_owned(install.native.AGENT_UNIT, {'node_uid': self.config['enrollment']['node_uid']})
            command.assert_not_called()

    def test_owned_launcher_directory_access_gets_repaired(self):
        self.files[self.file] = (install.checksum(b'reviewed reporter'), 0o644)
        self.receipt.return_value = install.inspect(self.config, False)[2]
        self.config['components'].update(tailscale='none', cloudflare='none')
        install.LIB.mkdir(mode=0o700)
        with (patch.object(install, 'check_directory'), patch.object(install, 'root_directory'),
              patch.object(install, 'activate_release', return_value='UNCHANGED')):
            result = install.execute('repair', self.config, False)
        self.assertEqual(result['result'], 'APPLIED')
        self.assertIn(str(install.LIB), result['files'])
        self.assertEqual(install.LIB.stat().st_mode & 0o055, 0o055)


if __name__ == '__main__':
    unittest.main()
