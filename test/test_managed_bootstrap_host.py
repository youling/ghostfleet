import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
try:
    spec = importlib.util.spec_from_file_location('managed_bootstrap_host', SCRIPTS / 'managed-bootstrap-host.py')
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
finally:
    sys.path.pop(0)

heartbeat = host.heartbeat
ORIGIN = 'https://node.example.invalid'
UID = 'node-' + '11111111-1111-4111-8111-111111111111'
PROOF = {'request_id': '1' * 64, 'request_secret': '2' * 64, 'short_code': 'ab2xy3'}
RAW = json.dumps(PROOF).encode()
RECEIPT = {'ok': True, 'node_uid': UID, 'profile': host.MANAGED_PROFILE, 'reporting_token': 'gf_hb_' + 'a' * 43}


class ManagedHostStageTests(unittest.TestCase):
    def mocked(self, target, name, **options):
        patcher = patch.object(target, name, **options)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.config = Path(scratch.name) / 'presence.json'
        self.mocked(heartbeat, 'CONFIG', new=self.config)
        self.preflight = self.mocked(host, 'check_local_host')
        self.paths = self.mocked(host, 'check_install_paths')
        self.claim = self.mocked(heartbeat, 'post_json', return_value=RECEIPT)
        self.activate = self.mocked(heartbeat, 'install_claimed_reporter')

    def test_preflight_failure_leaves_pairing_and_existing_reporter_intact(self):
        self.preflight.side_effect = heartbeat.ClientError('SYSTEMD_MANAGER_REQUIRED')
        with self.assertRaisesRegex(heartbeat.ClientError, 'SYSTEMD_MANAGER_REQUIRED'):
            host.install(ORIGIN, RAW, b'pinned reporter')
        self.claim.assert_not_called()
        self.paths.assert_not_called()
        self.activate.assert_not_called()

    def test_handoff_claims_once_and_installs_the_embedded_reporter(self):
        host.install(ORIGIN, RAW, b'pinned reporter')
        self.claim.assert_called_once_with(ORIGIN, '/v1/managed-enrollment/claim', {**PROOF, 'short_code': 'AB2XY3'})
        self.activate.assert_called_once_with({'origin': ORIGIN, 'node_uid': UID,
            'reporting_token': RECEIPT['reporting_token'], 'units': heartbeat.DEFAULT_UNITS}, b'pinned reporter', None)

    def test_managed_reissue_keeps_same_uid_and_existing_observation_units(self):
        units = {'ssh': 'custom-ssh.service', 'cloudflared': 'custom-tunnel.service',
                 'tailscaled': 'custom-mesh.service'}
        existing = heartbeat.validate_config({'origin': ORIGIN, 'node_uid': UID,
            'reporting_token': 'gf_hb_' + 'b' * 43, 'units': units})
        self.config.touch()
        with patch.object(heartbeat, 'load_config', return_value=existing):
            host.install(ORIGIN, RAW, b'pinned reporter')

        self.claim.assert_called_once_with(ORIGIN, '/v1/managed-enrollment/claim',
            {**PROOF, 'short_code': 'AB2XY3', 'expected_node_uid': UID})
        self.activate.assert_called_once_with({**existing, 'reporting_token': RECEIPT['reporting_token']},
            b'pinned reporter', existing)

    def test_existing_uid_is_checked_by_the_server_and_ambiguous_claim_is_never_retried(self):
        self.config.touch()
        config = {'origin': ORIGIN, 'node_uid': UID}
        self.claim.side_effect = heartbeat.ClientError('NETWORK_OR_TLS_FAILURE')
        with patch.object(heartbeat, 'load_config', return_value=config), \
                self.assertRaisesRegex(heartbeat.ClientError, 'MANAGED_CLAIM_NOT_RETRIED'):
            host.install(ORIGIN, RAW, b'pinned reporter')
        self.claim.assert_called_once_with(ORIGIN, '/v1/managed-enrollment/claim',
            {**PROOF, 'short_code': 'AB2XY3', 'expected_node_uid': UID})
        self.activate.assert_not_called()

    def test_existing_origin_must_match_before_network_claim(self):
        self.config.touch()
        with patch.object(heartbeat, 'load_config', return_value={'origin': 'https://other.example.invalid', 'node_uid': UID}), \
                self.assertRaisesRegex(heartbeat.ClientError, 'EXISTING_REPORTER_ORIGIN_MISMATCH'):
            host.install(ORIGIN, RAW, b'pinned reporter')
        self.claim.assert_not_called()

    def test_proof_rejects_extra_fields_and_receipt_rejects_privileged_fields(self):
        with self.assertRaisesRegex(heartbeat.ClientError, 'INVALID_MANAGED_PAIRING_PROOF'):
            host.install(ORIGIN, json.dumps({**PROOF, 'role': 'controller'}).encode(), b'pinned reporter')
        self.claim.assert_not_called()
        self.claim.return_value = {**RECEIPT, 'role': 'controller'}
        with self.assertRaisesRegex(heartbeat.ClientError, 'INVALID_MANAGED_REPORTER_RECEIPT'):
            host.install(ORIGIN, RAW, b'pinned reporter')
        self.activate.assert_not_called()
