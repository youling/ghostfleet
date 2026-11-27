"""Fail-closed convergence inputs and narrow original owner selection."""
from hashlib import sha256
from pathlib import Path
import runpy
import tempfile
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[1]
runner = runpy.run_path(str(ROOT / 'scripts/ghostfleet_converge.py'))
handoff = runpy.run_path(str(ROOT / 'config/convergence/owner_handoff.py'))
package_action = runpy.run_path(str(ROOT / 'config/convergence/package_action.py'))
Refused = runner['Refused']


class ConfigureScopeTest(unittest.TestCase):
    def test_input_bytes_must_match_file_claim(self):
        payload = b'{{ literal data }}\r\n'
        digest = sha256(payload).hexdigest()
        claim = {'owner': 'ansible', 'mode': 'manage', 'scope': 'host', 'kind': 'path',
                 'key': '/opt/ghostfleet-example/config.txt',
                 'desired': {'state': 'file', 'mode': '0640', 'sha256': digest}}
        with tempfile.TemporaryDirectory() as place:
            assets = Path(place)
            (assets / digest).write_bytes(payload)
            target = {'user': 'fixture', 'lock_path': '/opt/ghostfleet-lock/controller'}
            paths, packages = runner['desired_resources']({'resources': [claim]}, target, assets)
            self.assertEqual(paths[0]['content'], payload)
            self.assertFalse(packages)
            (assets / digest).write_bytes(b'changed')
            with self.assertRaisesRegex(Refused, 'INPUT_DIGEST_MISMATCH'):
                runner['desired_resources']({'resources': [claim]}, target, assets)

    def test_package_claim_cannot_escalate_nonroot(self):
        resource = {'mode': 'manage', 'owner': 'ansible', 'scope': 'host', 'kind': 'package',
                    'key': 'git', 'desired': {'state': 'present', 'version': '1:2.47.3-0+deb13u1'}}
        with self.assertRaisesRegex(Refused, 'PINNED_PACKAGE_SCOPE_INVALID'):
            runner['desired_resources']({'resources': [resource]}, {'user':'fixture'}, None)

    def test_package_action_requires_exact_existing_runtime_pins(self):
        packages = [{'name': 'git', 'version': '1:2.47.3-0+deb13u1'}]
        guarded = package_action['command']
        with self.assertRaisesRegex(Refused, 'EXISTING_PACKAGE_GUARD_REQUIRED'):
            guarded(None, packages, 'apply', runner['require'])
        with self.assertRaisesRegex(Refused, 'EXISTING_PACKAGE_GUARD_PIN_INVALID'):
            guarded({'runtime_version': '0.7.0', 'system_sha256': 'a' * 64, 'guard_sha256': 'short'},
                    packages, 'apply', runner['require'])
        pins = {'runtime_version': '0.7.0', 'system_sha256': 'a' * 64, 'guard_sha256': 'b' * 64}
        self.assertEqual(guarded(pins, packages, 'apply', runner['require'])[:3],
                         ['/usr/bin/python3', '-IB', '-c'])

    def test_linux_converger_write_scope_requires_its_original_owner(self):
        uid = 'node-' + str(uuid.uuid4())
        resource = {'id': 'original-owner', 'owner': 'converger', 'scope': 'host', 'mode': 'manage',
                    'kind': 'lifecycle', 'key': 'fleet:primary-converger',
                    'desired': {'state': 'present', 'version': '0.7.0'}}
        spec = {'component': 'linux-converger', 'resource_id': resource['id'],
                'profile': '/etc/ghostfleet-example/profile.json', 'profile_sha256': 'a' * 64,
                'runtime_version': '0.7.0', 'module_sha256': 'b' * 64}
        projection = {'resources': [resource], 'target': {'node_uid': uid, 'platform': 'debian13-amd64'}}
        for action in ('apply', 'verify'):
            with self.subTest(action=action):
                with self.assertRaisesRegex(Refused, 'CONVERGER_WRITE_SCOPE_NOT_SUPPORTED'):
                    handoff['command'](spec, projection, {'user': 'root'}, action,
                                       runner['require'], runner['absolute'])
        command = handoff['command'](spec, projection, {'user': 'root'}, 'plan', runner['require'], runner['absolute'])
        self.assertEqual(command[-2:], ['plan', uid])

    def test_handoff_requires_one_matching_managed_lifecycle(self):
        uid = 'node-' + str(uuid.uuid4())
        resource = {'id': 'original-owner', 'owner': 'ghostfleet', 'scope': 'host', 'mode': 'manage',
                    'kind': 'lifecycle', 'key': 'ghostfleet:installer', 'desired': {'state': 'present'}}
        spec = {'component': 'ghostfleet-installer', 'resource_id': resource['id'],
                'profile': '/etc/ghostfleet-example/profile.json', 'profile_sha256': 'a' * 64,
                'bootstrap_directory': '/opt/ghostfleet-example',
                'bootstrap_files': {name: 'b' * 64 for name in handoff['BOOTSTRAP']}}
        projection = {'resources': [resource], 'target': {'node_uid': uid, 'platform': 'debian13-amd64'}}
        command = handoff['command'](spec, projection, {'user': 'root'}, 'plan', runner['require'], runner['absolute'])
        self.assertEqual(command[:3], ['/usr/bin/python3', '-I', '-c'])
        self.assertEqual(command[-2:], ['plan', uid])
        with self.assertRaisesRegex(Refused, 'OWNER_HANDOFF_SCOPE_INVALID'):
            handoff['command'](spec, projection, {'user': 'fixture'}, 'apply', runner['require'], runner['absolute'])
        resource['mode'] = 'observe'
        with self.assertRaisesRegex(Refused, 'OWNER_LIFECYCLE_CLAIM_REQUIRED'):
            handoff['command'](spec, projection, {'user': 'root'}, 'apply', runner['require'], runner['absolute'])


if __name__ == '__main__':
    unittest.main()
