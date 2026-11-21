#!/usr/bin/env python3
"""Trusted target-side entry point for domain and short-code enrollment."""
import getpass
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import urllib.request


DOMAIN = re.compile(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?')
DIGEST = re.compile(r'[0-9a-f]{64}')
CODE = re.compile(r'[0-9A-HJKMNP-TV-Z]{6}', re.ASCII | re.IGNORECASE)
DISCOVERY = '/.well-known/ghostfleet-enrollment'
MAX_BOOTSTRAP_BYTES = 262144


class EnrollmentError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def origin_for(domain):
    try:
        ascii_domain = domain.strip().encode('idna').decode('ascii').lower()
    except UnicodeError:
        raise EnrollmentError('INVALID_DOMAIN') from None
    if len(ascii_domain) > 253 or not DOMAIN.fullmatch(ascii_domain):
        raise EnrollmentError('INVALID_DOMAIN')
    return 'https://' + ascii_domain


def download(opener, url, limit, document=None):
    request = urllib.request.Request(url, headers={'Accept': 'application/json' if document is not None else '*/*'},
        data=None if document is None else json.dumps(document).encode('ascii'))
    if document is not None:
        request.add_header('Content-Type', 'application/json')
    try:
        with opener.open(request, timeout=20) as response:
            if response.status not in ({200} if document is None else {200, 201}) or response.geturl() != url:
                raise EnrollmentError('UNEXPECTED_RESPONSE')
            body = response.read(limit + 1)
    except OSError:
        raise EnrollmentError('ENROLLMENT_ENDPOINT_UNAVAILABLE') from None
    if len(body) > limit:
        raise EnrollmentError('RESPONSE_TOO_LARGE')
    return body


def metadata(raw):
    try:
        document = json.loads(raw)
        if document['ok'] is not True or document['protocol'] != 'ghostfleet-managed-enrollment/v1':
            raise ValueError()
        node_origin = document['node_origin']
        if not isinstance(node_origin, str) or not node_origin.startswith('https://') or origin_for(node_origin[8:]) != node_origin:
            raise ValueError()
        artifact = document['artifact']
        pin = artifact['sha256']
        if not DIGEST.fullmatch(pin) or artifact['url'] != node_origin + '/bootstrap/' + pin + '.managed.sh':
            raise ValueError()
    except (KeyError, TypeError, ValueError, EnrollmentError):
        raise EnrollmentError('INVALID_ENROLLMENT_METADATA') from None
    return node_origin, pin, artifact['url']


def enroll(domain, read_code, show_request=print, *, opener=None, launch=subprocess.run):
    if opener is None:
        opener = urllib.request.build_opener(NoRedirect())
    panel_origin = origin_for(domain)
    node_origin, pin, url = metadata(download(opener, panel_origin + DISCOVERY, 4096))
    script = download(opener, url, MAX_BOOTSTRAP_BYTES)
    if not hmac.compare_digest(hashlib.sha256(script).hexdigest(), pin):
        raise EnrollmentError('MANAGED_BOOTSTRAP_DIGEST_MISMATCH')
    secret = secrets.token_hex(32)
    request_id = hashlib.sha256(secret.encode('ascii')).hexdigest()
    registered = download(opener, node_origin + '/v1/managed-enrollment/requests', 4096, {'request_id': request_id})
    try:
        if json.loads(registered)['ok'] is not True:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise EnrollmentError('ENROLLMENT_REQUEST_NOT_REGISTERED') from None
    show_request(request_id[-12:])
    code = read_code().strip()
    if not CODE.fullmatch(code):
        raise EnrollmentError('INVALID_SHORT_CODE')
    with tempfile.TemporaryDirectory(prefix='ghostfleet-enroll-') as temporary:
        path = Path(temporary) / 'managed-bootstrap.sh'
        path.write_bytes(script)
        path.chmod(0o600)
        # No credential in environment, argv, or a persistent file.
        payload = json.dumps({'request_id': request_id, 'request_secret': secret, 'short_code': code.upper()})
        result = launch(['/bin/sh', str(path), '--origin', node_origin], input=payload + '\n', text=True,
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
        if result.returncode:
            raise EnrollmentError('MANAGED_BOOTSTRAP_FAILED')


def main():
    try:
        if not hasattr(os, 'geteuid') or os.geteuid() != 0 or not sys.stdin.isatty():
            raise EnrollmentError('TRUSTED_ROOT_TERMINAL_REQUIRED')
        enroll(input('纳管域名 / Enrollment domain: '), lambda: getpass.getpass('短码 / Short code: '),
            lambda identifier: print('请在面板选择此配对请求 / Select this pairing request in the Panel: ' + identifier))
    except (EnrollmentError, EOFError, KeyboardInterrupt) as error:
        print('GF_ENROLL_ERROR ' + (str(error) if isinstance(error, EnrollmentError) else 'CANCELLED'), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
