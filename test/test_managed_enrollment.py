import hashlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest


module_path = Path(__file__).resolve().parents[1] / 'scripts/enroll-managed.py'
spec = importlib.util.spec_from_file_location('enroll_managed', module_path)
wizard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wizard)


class EnrollmentTest(unittest.TestCase):
    panel = 'https://panel.example.invalid'
    node = 'https://node.example.invalid'
    trusted = {panel: node}
    script = b'#!/bin/sh\nexit 1\n'

    def opener(self, *, script_body=None, request_result=b'{"ok": true}', advertised_origin=None):
        pin = hashlib.sha256(self.script).hexdigest()
        url = self.node + '/bootstrap/' + pin + '.managed.sh'
        advertised_origin = advertised_origin or self.node
        response = {'ok': True, 'protocol': 'ghostfleet-managed-enrollment/v1', 'node_origin': advertised_origin,
                    'artifact': {'sha256': pin, 'url': advertised_origin + '/bootstrap/' + pin + '.managed.sh'}}
        files = {self.node + wizard.DISCOVERY: json.dumps(response).encode(),
                 url: self.script if script_body is None else script_body,
                 self.node + '/v1/managed-enrollment/requests': request_result}
        calls = []

        def open_url(request, timeout):
            calls.append(request)
            body = io.BytesIO(files[request.full_url])
            body.status = 201 if request.data else 200
            body.geturl = lambda: request.full_url
            return body

        return SimpleNamespace(open=open_url), calls

    def test_domain_and_code_pair_then_launch_with_credentials_only_in_stdin(self):
        opener, calls = self.opener()
        shown = []

        def launch(argv, *, input, text, env):
            payload = json.loads(input)
            only_request = json.loads(calls[-1].data)
            self.assertEqual(payload['request_id'], only_request['request_id'])
            self.assertEqual(payload['request_id'], hashlib.sha256(payload['request_secret'].encode()).hexdigest())
            self.assertEqual(shown, [payload['request_id'][-12:]])
            self.assertEqual(payload['short_code'], 'AB2XY3')
            assert_value = ' '.join(argv + list(env.values()))
            self.assertNotIn(payload['request_secret'], assert_value)
            self.assertNotIn(payload['short_code'], assert_value)
            self.assertEqual(Path(argv[1]).read_bytes(), self.script)
            self.assertEqual(argv[2:], ['--origin', self.node])
            return SimpleNamespace(returncode=0)

        wizard.enroll('Panel.Example.Invalid', lambda: 'ab2xy3', shown.append, trusted=self.trusted, opener=opener, launch=launch)
        pin = hashlib.sha256(self.script).hexdigest()
        self.assertEqual([(request.get_method(), request.full_url) for request in calls], [
            ('GET', self.node + wizard.DISCOVERY),
            ('GET', self.node + '/bootstrap/' + pin + '.managed.sh'),
            ('POST', self.node + '/v1/managed-enrollment/requests'),
        ])
        for request in calls:
            with self.subTest(url=request.full_url):
                self.assertEqual(request.get_header('User-agent'), 'GhostFleet-Enrollment/1')

    def test_wrong_digest_stops_before_pairing_or_prompt(self):
        opener, calls = self.opener(script_body=b'wrong bytes')
        with self.assertRaisesRegex(wizard.EnrollmentError, 'MANAGED_BOOTSTRAP_DIGEST_MISMATCH'):
            wizard.enroll('panel.example.invalid', lambda: self.fail('prompt called'), trusted=self.trusted, opener=opener)
        self.assertEqual(len(calls), 2)

    def test_failed_registration_stops_before_prompt(self):
        opener, _ = self.opener(request_result=b'{"ok": false}')
        with self.assertRaisesRegex(wizard.EnrollmentError, 'ENROLLMENT_REQUEST_NOT_REGISTERED'):
            wizard.enroll('panel.example.invalid', lambda: self.fail('prompt called'), trusted=self.trusted, opener=opener)

    def test_trust_policy_stops_unapproved_domain_or_delegation_before_artifact(self):
        opener, calls = self.opener()
        with self.assertRaisesRegex(wizard.EnrollmentError, 'UNTRUSTED_ENROLLMENT_DOMAIN'):
            wizard.enroll('other.example.invalid', lambda: self.fail('prompt called'), trusted=self.trusted, opener=opener)
        self.assertEqual(calls, [])
        opener, calls = self.opener(advertised_origin='https://other.example.invalid')
        with self.assertRaisesRegex(wizard.EnrollmentError, 'UNTRUSTED_NODE_ORIGIN'):
            wizard.enroll('panel.example.invalid', lambda: self.fail('prompt called'),
                          trusted=self.trusted, opener=opener)
        self.assertEqual(len(calls), 1)

    def test_domain_requires_bare_dns_name(self):
        for domain in ('https://panel.example.invalid', 'example.invalid/path', 'owner@example.invalid', 'localhost'):
            with self.subTest(domain=domain), self.assertRaisesRegex(wizard.EnrollmentError, 'INVALID_DOMAIN'):
                wizard.origin_for(domain)
