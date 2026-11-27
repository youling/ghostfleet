#!/usr/bin/env python3
"""Download one signed GhostFleet package and atomically activate its reporter."""
import argparse
import ast
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlsplit

PKG = "ghostfleet-node"
VERSION = re.compile(r"\d{1,8}\.\d{1,8}\.\d{1,8}(?:~[a-z0-9.]{1,24})?(?:\+[a-z0-9.]{1,24})?")
SHA = re.compile(r"[a-f0-9]{64}")
COMMIT = re.compile(r"[a-f0-9]{40}")
FINGERPRINT = re.compile(r"[A-F0-9]{40}")
ARCHITECTURES = ("amd64", "arm64")
PAYLOAD = "usr/share/ghostfleet-nextgen/"
FILES = {PAYLOAD + "node.py", PAYLOAD + "release.json"}
DIRS = {".", "usr", "usr/share", PAYLOAD.rstrip("/")}
MAX_SIZE = 1024 * 1024
ROOT = Path("/var/lib/ghostfleet-nextgen/software")


class UpdateError(Exception):
    pass


def check(requirement, message):
    if not requirement:
        raise UpdateError(message)


def matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value)


NATIVE_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "HOME": "/nonexistent"}


def apt_user():
    try:
        account = pwd.getpwnam("_apt")
    except KeyError:
        raise UpdateError("APT_USER_UNAVAILABLE") from None
    check(account.pw_uid != 0 and account.pw_gid != 0, "UNSAFE_APT_USER")
    return {"user": account.pw_uid, "group": account.pw_gid, "extra_groups": []}


def command(args, *, root=None, env=None, error="NATIVE_TOOL_FAILED", unprivileged=False):
    result = subprocess.run(args, cwd=root, env=env or NATIVE_ENV, capture_output=True, timeout=120, check=False,
                            **(apt_user() if unprivileged else {}))
    check(result.returncode == 0, error)
    return result.stdout.decode("utf-8")


def trusted_parents(path):
    check(path.is_absolute() and ".." not in path.parts, "UNSAFE_TRUST_PATH")
    for parent in path.parents:
        info = parent.lstat()
        # A root-owned sticky directory allows safe temporary test trees.
        check(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
              (not info.st_mode & 0o022 or info.st_mode & stat.S_ISVTX), "UNSAFE_TRUST_PATH")


def trusted_file(path):
    trusted_parents(path)
    info = path.lstat()
    check(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, "UNSAFE_TRUST_FILE")
    return path


def settings(path, local):
    data = json.loads(trusted_file(path).read_bytes())
    required = {"uri", "channel", "keyring", "fingerprint"}
    check(isinstance(data, dict) and required <= data.keys() <= required | {"minimum_version"}, "INVALID_UPDATE_SETTINGS")
    check("minimum_version" not in data or matches(VERSION, data["minimum_version"]), "INVALID_MINIMUM_VERSION")
    uri_text = data["uri"]
    check(isinstance(uri_text, str) and uri_text.isascii() and not any(char.isspace() for char in uri_text),
          "INVALID_ARCHIVE_URI")
    uri = urlsplit(uri_text)
    check(not (uri.username or uri.password or uri.query or uri.fragment) and
          ((uri.scheme == "https" and uri.hostname) or
           (local and uri.scheme == "file" and not uri.netloc and uri.path.startswith("/"))), "INVALID_ARCHIVE_URI")
    check(data["channel"] in ("canary", "stable"), "INVALID_CHANNEL")
    check(matches(FINGERPRINT, data["fingerprint"]), "INVALID_FINGERPRINT")
    keyring = data["keyring"]
    check(isinstance(keyring, str) and re.fullmatch(r"/[a-zA-Z0-9_./-]+\.gpg", keyring) and
          Path(keyring).resolve() == Path(keyring), "INVALID_KEYRING")
    trusted_file(Path(keyring))
    return data


def release_platform():
    os_release = {}
    for line in Path("/etc/os-release").read_text().splitlines():
        name, delim, value = line.partition("=")
        if delim:
            os_release[name] = value.strip('"')
    arch = command(["dpkg", "--print-architecture"]).strip()
    check(os_release.get("ID") == "debian" and os_release.get("VERSION_ID") == "13" and arch in ARCHITECTURES,
          "PLATFORM_NOT_SUPPORTED")
    return arch


def sandbox(scratch, config, arch):
    scratch.chmod(0o755)
    for name in ("lists", "conf.d", "downloads", "trusted.d", "preferences.d", "auth.conf.d"):
        (scratch / name).mkdir(parents=True)
    for name in ("status", "empty.gpg", "preferences", "auth.conf"):
        (scratch / name).touch()
    # Only this public key is exposed to the fetch user, even under a private /etc directory.
    (scratch / "archive.gpg").write_bytes(trusted_file(Path(config["keyring"])).read_bytes())
    (scratch / "channel.sources").write_text(
        f"Types: deb\nURIs: {config['uri']}\nSuites: {config['channel']}\nComponents: main\nArchitectures: {arch}\n"
        f"Signed-By: {scratch}/archive.gpg {config['fingerprint']}\nValid-Until-Max: 172800\n", encoding="ascii")
    # Empty the host's hook, key, cache and sources paths. No dpkg install is used.
    (scratch / "apt.conf").write_text(
        f'Dir::Etc::main "/dev/null";\nDir::Etc::parts "{scratch}/conf.d";\n'
        f'Dir::Etc::sourcelist "{scratch}/channel.sources";\nDir::Etc::sourceparts "-";\n'
        f'Dir::Etc::trusted "{scratch}/empty.gpg";\nDir::Etc::trustedparts "{scratch}/trusted.d";\n'
        f'Dir::Etc::preferences "{scratch}/preferences"; Dir::Etc::preferencesparts "{scratch}/preferences.d";\n'
        f'Dir::Etc::netrc "{scratch}/auth.conf"; Dir::Etc::netrcparts "{scratch}/auth.conf.d";\n'
        f'Dir::State::lists "{scratch}/lists";\nDir::State::status "{scratch}/status";\n'
        'Dir::Cache::pkgcache ""; Dir::Cache::srcpkgcache "";\n'
        f'APT::Architecture "{arch}";\nAPT::Update::Error-Mode "any";\n'
        'Acquire::Languages "none"; Acquire::Retries "0";\n'
        'Acquire::Check-Date "true"; Acquire::Check-Valid-Until "true";\n'
        'Acquire::AllowInsecureRepositories "false"; Acquire::AllowDowngradeToInsecureRepositories "false";\n'
        'Acquire::https::AllowRedirect "false";\n', encoding="ascii")
    for item in scratch.iterdir():
        item.chmod(0o755 if item.is_dir() else 0o644)
    account = apt_user()
    for directory in (scratch / "lists", scratch / "downloads"):
        directory.chmod(0o700)
        os.chown(directory, account["user"], account["group"])
    return {**NATIVE_ENV, "APT_CONFIG": str(scratch / "apt.conf")}


def candidate(env, arch, channel):
    command(["apt-get", "update"], env=env, unprivileged=True, error="ARCHIVE_CHECK_FAILED")
    archive_policy = command(["apt-cache", "policy"], env=env, unprivileged=True, error="INDEX_POLICY_FAILED")
    archive_releases = re.findall(r"^\s*release (?!a=now$)(.+)$", archive_policy, re.MULTILINE)
    expected = {"o=GhostFleet", "a=" + channel, "n=" + channel, "l=GhostFleet", "c=main", "b=" + arch}
    check(len(archive_releases) == 1 and expected.issubset(archive_releases[0].split(",")), "WRONG_ARCHIVE_CHANNEL")
    policy = command(["apt-cache", "policy", PKG], env=env, unprivileged=True, error="INDEX_POLICY_FAILED")
    found = re.search(r"^\s*Candidate: (\S+)$", policy, re.MULTILINE)
    check(found and matches(VERSION, found[1]), "NO_APPROVED_PACKAGE")
    version = found[1]
    summary = command(["apt-cache", "show", PKG + "=" + version], env=env, unprivileged=True, error="INDEX_READ_FAILED")
    records = [record for record in summary.strip().split("\n\n") if record]
    check(len(records) == 1, "AMBIGUOUS_PACKAGE")
    fields = dict(line.split(": ", 1) for line in records[0].splitlines() if ": " in line and not line.startswith(" "))
    size = fields.get("Size", "")
    check(fields.get("Package") == PKG and fields.get("Version") == version and fields.get("Architecture") == arch and
          matches(SHA, fields.get("SHA256")) and re.fullmatch(r"[0-9]{1,8}", size) and 0 < int(size) <= MAX_SIZE,
          "INVALID_PACKAGE_INDEX")
    return version, fields["SHA256"], int(size)


def read_package(package, expected):
    process = subprocess.Popen(["dpkg-deb", "--fsys-tarfile", str(package)], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env=NATIVE_ENV, **apt_user())
    files = {}
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as contents:
            for number, entry in enumerate(contents):
                name = entry.name.removeprefix("./").rstrip("/")
                check(number < 8, "UNEXPECTED_PACKAGE_CONTENTS")
                if entry.isdir():
                    check(name in DIRS, "UNEXPECTED_PACKAGE_CONTENTS")
                    continue
                check(entry.isfile() and name in FILES and name not in files and entry.size <= MAX_SIZE,
                      "UNEXPECTED_PACKAGE_CONTENTS")
                with contents.extractfile(entry) as data:
                    files[name] = data.read()
        check(process.wait(timeout=15) == 0 and set(files) == FILES, "PACKAGE_EXTRACT_FAILED")
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait()
    release = json.loads(files[PAYLOAD + "release.json"])
    check(isinstance(release, dict) and set(release) == {"version", "source_revision", "platform"} and
          release["version"] == expected[0] and release["platform"] == expected[1] and
          matches(COMMIT, release["source_revision"]), "RELEASE_MANIFEST_MISMATCH")
    script = files[PAYLOAD + "node.py"]
    ast.parse(script, filename="node.py")
    return release, script


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_file(path, content, mode):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    with os.fdopen(fd, "wb") as handle:
        os.fchmod(handle.fileno(), mode)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())


def safe_dir(path):
    if not path.exists():
        if not path.parent.exists():
            safe_dir(path.parent)
        trusted_parents(path)
        try:
            path.mkdir(mode=0o755)
        except FileExistsError:
            pass
        else:
            path.chmod(0o755)
    trusted_parents(path)
    info = path.lstat()
    check(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, "UNSAFE_UPDATE_DIRECTORY")
    # The reporter's DynamicUser must traverse software directories even after a
    # bootstrap with umask 077. Only root-owned software directories enter here.
    if info.st_mode & 0o011 != 0o011:
        path.chmod(stat.S_IMODE(info.st_mode) | 0o011)
    return path


def active(root):
    link = root / "current"
    if not link.exists() and not link.is_symlink():
        return None
    check(link.is_symlink(), "INVALID_ACTIVE_RELEASE")
    target = link.readlink()
    check(len(target.parts) == 2 and target.parts[0] == "releases" and target.name not in (".", ".."),
          "INVALID_ACTIVE_RELEASE")
    receipt = json.loads(trusted_file(root / target / "receipt.json").read_bytes())
    check(isinstance(receipt, dict) and matches(VERSION, receipt.get("version")) and
          matches(SHA, receipt.get("sha256")) and matches(COMMIT, receipt.get("source_revision")) and
          target.name == receipt["version"] + "_" + receipt["sha256"], "INVALID_ACTIVE_RELEASE")
    return receipt


def activate(root, release, script):
    releases = safe_dir(root / "releases")
    destination = releases / (release["version"] + "_" + release["sha256"])
    manifest = json.dumps(release, sort_keys=True).encode()
    with tempfile.TemporaryDirectory(prefix=".stage-", dir=releases) as staging:
        staged = Path(staging) / "release"
        staged.mkdir(mode=0o755)
        staged.chmod(0o755)
        sync_file(staged / "receipt.json", manifest, 0o644)
        sync_file(staged / "node.py", script, 0o644)
        sync_dir(staged)
        if destination.exists():
            safe_dir(destination)
            check(trusted_file(destination / "receipt.json").read_bytes() == manifest and
                  trusted_file(destination / "node.py").read_bytes() == script, "STAGED_RELEASE_CONFLICT")
        else:
            staged.rename(destination)
            sync_dir(releases)
    # The old pointer and credentials are untouched until this single rename.
    with tempfile.TemporaryDirectory(prefix=".activate-", dir=root) as staging:
        link = Path(staging) / "current"
        link.symlink_to(destination.relative_to(root))
        link.replace(root / "current")
        sync_dir(root)


def pull(root, config, arch):
    safe_dir(root)
    installed = active(root)
    if installed:
        # An rc1 installation may have been staged under a restrictive umask.
        slot = root / "current"
        previous = root / slot.readlink()
        safe_dir(previous.parent)
        safe_dir(previous)
        for name in ("receipt.json", "node.py"):
            path = trusted_file(previous / name)
            path.chmod(0o644)
    platform = "debian13-" + arch
    check(not installed or installed.get("platform") == platform, "INSTALLED_PLATFORM_MISMATCH")
    with tempfile.TemporaryDirectory(prefix="ghostfleet-apt-", dir="/tmp") as directory:
        scratch = Path(directory)
        env = sandbox(scratch, config, arch)
        version, digest, size = candidate(env, arch, config["channel"])
        floor = config.get("minimum_version")
        if floor:
            check(not version_compare(version, "lt", floor), "BELOW_APPROVED_FLOOR")
        if installed:
            if version_compare(version, "le", installed["version"]):
                check(version == installed["version"], "ROLLBACK_REFUSED")
                check(digest == installed["sha256"], "IMMUTABLE_VERSION_CONFLICT")
                return "UNCHANGED"
        download = scratch / "downloads"
        command(["apt-get", "download", PKG + "=" + version], root=download, env=env, unprivileged=True, error="PACKAGE_DOWNLOAD_FAILED")
        packages = list(download.glob("*.deb"))
        check(len(packages) == 1, "PACKAGE_HASH_MISMATCH")
        # Copy once from the fetch account; unpack the same verified, root-owned bytes.
        fd = os.open(packages[0], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            check(stat.S_ISREG(info.st_mode) and info.st_size == size, "PACKAGE_HASH_MISMATCH")
            contents = source.read(MAX_SIZE + 1)
        check(len(contents) == size and hashlib.sha256(contents).hexdigest() == digest, "PACKAGE_HASH_MISMATCH")
        verified = scratch / "verified.deb"
        sync_file(verified, contents, 0o644)
        release, script = read_package(verified, (version, platform))
        activate(root, {**release, "sha256": digest}, script)
    return "ACTIVATED"


def version_compare(version, comparison, reference):
    result = subprocess.run(["dpkg", "--compare-versions", version, comparison, reference],
                            capture_output=True, timeout=15, check=False, env=NATIVE_ENV)
    check(result.returncode in (0, 1), "VERSION_COMPARE_FAILED")
    return result.returncode == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("/etc/ghostfleet-nextgen/update.json"))
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--allow-local-fixture", action="store_true", help="allow a local signed file: test archive")
    args = parser.parse_args()
    try:
        check(os.geteuid() == 0, "ROOT_REQUIRED")
        config = settings(args.config, args.allow_local_fixture)
        if args.root == ROOT:
            safe_dir(ROOT.parent)
        root = safe_dir(args.root.absolute())
        fd = os.open(root / "update.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = pull(root, config, release_platform())
        print("GHOSTFLEET_UPDATE_" + result)
    except UpdateError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, SyntaxError, tarfile.TarError, subprocess.TimeoutExpired):
        print("UPDATE_IO_OR_VALIDATION_FAILED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
