"""One-shot SSH lock holder and durable reservation for a configuration apply."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import subprocess
import sys


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def pending_path(lock):
    return lock.with_name(lock.name + '.pending')


def require_idle(pending):
    try:
        pending.lstat()
    except FileNotFoundError:
        return
    raise SystemExit(43)


def reserve(pending, record):
    # Create exclusively. An interrupted creation still reserves the target
    # even if its record was never finished.
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w', encoding='ascii') as stream:
        json.dump(record, stream, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
        meta = os.fstat(stream.fileno())
    sync_directory(pending.parent)
    return meta


def complete(pending, expected, received, meta):
    if received != ('COMMIT ' + expected + '\n').encode('ascii'):
        return False
    current = pending.lstat()
    if (current.st_dev, current.st_ino) != (meta.st_dev, meta.st_ino):
        raise SystemExit(41)
    pending.unlink()
    sync_directory(pending.parent)
    return True


def target_machine(expected, product_platform):
    machine = Path('/etc/machine-id').read_bytes().strip()
    with open('/etc/os-release', encoding='utf-8') as stream:
        release = dict(line.rstrip().split('=', 1) for line in stream if '=' in line)
    is_wsl = 'microsoft' in platform.release().lower()
    if (hashlib.sha256(machine).hexdigest() != expected or release.get('ID') != 'debian'
            or release.get('VERSION_ID', '').strip('"') != '13' or platform.machine() != 'x86_64'
            or is_wsl != (product_platform == 'wsl-debian13-amd64')):
        raise SystemExit(40)


def owned_path(path, planned, required=False):
    for parent in reversed(path.parents):
        try:
            meta = parent.lstat()
        except FileNotFoundError:
            if not required and parent in planned:
                continue
            raise SystemExit(41) from None
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid not in (0, os.getuid()) or meta.st_mode & 0o022:
            raise SystemExit(41)
    try:
        meta = path.lstat()
    except FileNotFoundError:
        if required:
            raise SystemExit(41) from None
        return None
    if meta.st_uid != os.getuid() or not (stat.S_ISREG(meta.st_mode) or stat.S_ISDIR(meta.st_mode)):
        raise SystemExit(41)
    return meta


def require_persistent_parent(path):
    try:
        result = subprocess.run(['/usr/bin/findmnt', '--kernel', '--noheadings', '--output',
                                 'FSTYPE', '--target', str(path)], capture_output=True, timeout=3, check=True)
    except (OSError, subprocess.SubprocessError):
        raise SystemExit(45) from None
    if result.stdout.strip() not in {b'ext4', b'xfs', b'btrfs'}:
        raise SystemExit(45)


def hold(lock, paths, action, attempt, projection, expires):
    lock_meta = owned_path(lock, (), required=True)
    if not stat.S_ISREG(lock_meta.st_mode) or lock_meta.st_nlink != 1 or lock_meta.st_mode & 0o077:
        raise SystemExit(41)
    require_persistent_parent(lock.parent)
    fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        locked = os.fstat(fd)
        if (locked.st_dev, locked.st_ino) != (lock_meta.st_dev, lock_meta.st_ino):
            raise SystemExit(41)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit(42) from None
        pending = pending_path(lock)
        require_idle(pending)
        planned = {Path(path) for path, kind in paths if kind == 'directory'}
        for path, kind in paths:
            existing = owned_path(Path(path), planned)
            if existing and (stat.S_ISDIR(existing.st_mode) != (kind == 'directory') or
                             (kind == 'file' and existing.st_nlink != 1)):
                raise SystemExit(41)
        deadline = datetime.datetime.fromisoformat(expires)
        if datetime.datetime.now(datetime.timezone.utc) >= deadline:
            raise SystemExit(44)
        if action != 'apply':
            print('LOCKED', flush=True)
            sys.stdin.buffer.read(1)
            return
        meta = reserve(pending, {'schema': 'ghostfleet-pending/v1', 'attempt_id': attempt,
                                 'projection_sha256': projection, 'authority_expires_at': expires,
                                 'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()})
        print('LOCKED', flush=True)
        received = sys.stdin.buffer.readline(80)
        if datetime.datetime.now(datetime.timezone.utc) < deadline and complete(pending, attempt, received, meta):
            print('COMMITTED', flush=True)
    finally:
        os.close(fd)


if __name__ == '__main__':
    expected, product_platform, lock, paths, action, attempt, projection, expires = sys.argv[1:]
    target_machine(expected, product_platform)
    hold(Path(lock), json.loads(paths), action, attempt, projection, expires)
