#!/usr/bin/env python3
"""Build reviewed GhostFleet inputs and sign an explicitly selected APT channel."""
import argparse
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent / "host"))
from update import (  # noqa: E402
    ARCHITECTURES, COMMIT, FINGERPRINT, MAX_SIZE, PAYLOAD, PKG, SHA, VERSION, check, matches, version_compare,
)

HOST = "nextgen/host/"
RELEASE_VERSION_FLOOR = "0.3.0~rc3"
BOOTSTRAP = {
    HOST + "enroll.py": "enroll.py",
    HOST + "install.py": "install.py",
    HOST + "node.py": "node.py",
    HOST + "update.py": "update.py",
    HOST + "report.py": "report.py",
    HOST + "ghostfleet-nextgen-report.service": "ghostfleet-nextgen-report.service",
    HOST + "ghostfleet-nextgen-report.timer": "ghostfleet-nextgen-report.timer",
    HOST + "ghostfleet-nextgen-update.service": "ghostfleet-nextgen-update.service",
    HOST + "ghostfleet-nextgen-update.timer": "ghostfleet-nextgen-update.timer",
    HOST + "ghostfleet-nextgen-k3s-agent.service": "ghostfleet-nextgen-k3s-agent.service",
    "nextgen/install-profile.schema.json": "install-profile.schema.json",
    "nextgen/native.py": "native.py",
    "docs/nextgen/OPERATIONS.md": "OPERATIONS.md",
}


NATIVE_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "TZ": "UTC", "HOME": "/nonexistent"}
# Exact Debian package revisions of the tools producing the release bytes.
BUILD_TOOLS = {"dpkg": "1.22.22", "git": "1:2.47.3-0+deb13u1",
               "python3.13-minimal": "3.13.5-2+deb13u5", "libpython3.13-stdlib": "3.13.5-2+deb13u5",
               "zlib1g": "1:1.3.dfsg+really1.3.1-1+deb13u1", "tar": "1.35+dfsg-3.1"}


def run(*args, cwd=None, env=None):
    return subprocess.check_output(args, cwd=cwd, env={**NATIVE_ENV, **(env or {})}, timeout=120)


def git(*args):
    return run("git", "--no-replace-objects", "-c", "core.fsmonitor=false", *args,
               cwd=Path(__file__).resolve().parents[1],
               env={"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"})


def check_toolchain():
    check(Path(sys.executable).resolve() == Path("/usr/bin/python3.13"), "BUILD_PYTHON_MISMATCH")
    versions = run("dpkg-query", "-W", "-f=${Package}=${Version}\n", *BUILD_TOOLS).decode().splitlines()
    check(dict(line.split("=", 1) for line in versions) == BUILD_TOOLS, "BUILD_TOOLCHAIN_MISMATCH")


def build_package(out, source, epoch, version, arch, reporter):
    check(matches(COMMIT, source) and matches(VERSION, version) and arch in ARCHITECTURES, "INVALID_BUILD_TARGET")
    filename = f"{PKG}_{version}_{arch}.deb"
    with tempfile.TemporaryDirectory(prefix="ghostfleet-package-", dir=out) as build:
        root = Path(build) / "payload"
        (root / PAYLOAD).mkdir(parents=True)
        (root / "DEBIAN").mkdir()
        (root / "DEBIAN/control").write_text(
            f"Package: {PKG}\nVersion: {version}\nArchitecture: {arch}\n"
            "Maintainer: GhostFleet maintainers\nSection: admin\nPriority: optional\n"
            "Description: GhostFleet next-generation reporter payload\n", encoding="ascii")
        (root / PAYLOAD / "node.py").write_bytes(reporter)
        (root / PAYLOAD / "release.json").write_text(
            json.dumps({"source_revision": source, "version": version, "platform": "debian13-" + arch},
                       sort_keys=True), encoding="ascii")
        for path in [root, *root.rglob("*")]:
            path.chmod(0o755 if path.is_dir() else 0o644)
            os.utime(path, (epoch, epoch))
        archive = Path(build) / filename
        run("dpkg-deb", "-Znone", "--root-owner-group", "--build", root, archive,
            env={"SOURCE_DATE_EPOCH": str(epoch)})
        check(not (out / filename).exists(), "OUTPUT_ALREADY_EXISTS")
        os.link(archive, out / filename)
    return out / filename


def build(out, version, arch, source):
    check(matches(COMMIT, source) and git("rev-parse", "HEAD").decode().strip() == source, "SOURCE_REVISION_MISMATCH")
    check(not git("status", "--porcelain=v1", "--untracked-files=all").strip(), "DIRTY_CHECKOUT")
    check_toolchain()
    check(matches(VERSION, version) and arch in ARCHITECTURES, "INVALID_BUILD_TARGET")
    check(version_compare(version, "ge", RELEASE_VERSION_FLOOR), "RELEASE_VERSION_TOO_OLD")
    epoch = int(git("show", "-s", "--format=%ct", source))
    files = {}
    inputs = {"nextgen/release.py": hashlib.sha256(git("cat-file", "blob", source + ":nextgen/release.py")).hexdigest()}
    for original, filename in BOOTSTRAP.items():
        contents = git("cat-file", "blob", source + ":" + original)
        check(0 < len(contents) <= MAX_SIZE, "INVALID_BUILD_INPUT")
        files[filename] = contents
        inputs[original] = hashlib.sha256(contents).hexdigest()
    check(not out.exists() or (out.is_dir() and not any(out.iterdir())), "OUTPUT_ALREADY_EXISTS")
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".ghostfleet-build-", dir=out.parent) as directory:
        stage = Path(directory) / "candidate"
        stage.mkdir()
        artifacts = build_artifacts(stage, source, epoch, version, arch, files)
        stage.rename(out)
    print(json.dumps({"source_revision": source, "source_date_epoch": epoch, "version": version,
                      "platform": "debian13-" + arch, "build_arch": run("dpkg", "--print-architecture").decode().strip(),
                      "toolchain": BUILD_TOOLS, "input_sha256": inputs, "sha256": artifacts}, sort_keys=True))


def build_artifacts(out, source, epoch, version, arch, files):
    package = build_package(out, source, epoch, version, arch, files["node.py"])
    artifact = out / "ghostfleet-bootstrap.tar.gz"
    with artifact.open("xb") as compressed:
        with gzip.GzipFile(filename="", fileobj=compressed, mode="wb", mtime=epoch) as gz:
            with tarfile.open(fileobj=gz, mode="w") as tar:
                for filename, contents in sorted(files.items()):
                    member = tarfile.TarInfo(filename)
                    member.size = len(contents)
                    member.mode = 0o644
                    member.mtime = epoch
                    tar.addfile(member, io.BytesIO(contents))
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (package, artifact)}


def sign(out, package, channel, arch, home, fingerprint, *, expected_sha256, now=None, valid_hours=24):
    check(matches(FINGERPRINT, fingerprint) and channel in ("canary", "stable") and arch in ARCHITECTURES,
          "INVALID_SIGNING_INPUT")
    check(not out.exists() and out.parent.is_dir(), "ARCHIVE_OUTPUT_MUST_BE_NEW")
    check(matches(SHA, expected_sha256) and 0 < package.stat().st_size <= MAX_SIZE, "INVALID_PROMOTION_DIGEST")
    info = home.lstat()
    check(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077,
          "UNSAFE_SIGNING_HOME")
    check(type(valid_hours) is int and 0 < valid_hours <= 48, "INVALID_VALIDITY")
    now = now or datetime.now(timezone.utc)
    with tempfile.TemporaryDirectory(prefix=".ghostfleet-publish-", dir=out.parent) as directory:
        work = Path(directory)
        stage = work / "archive"
        pool = stage / "pool"
        pool.mkdir(parents=True)
        # Inspect exactly the copy whose approved digest was checked.
        approved = work / "approved.deb"
        with package.open("rb") as source:
            contents = source.read(MAX_SIZE + 1)
        check(len(contents) <= MAX_SIZE and hashlib.sha256(contents).hexdigest() == expected_sha256,
              "PROMOTION_DIGEST_MISMATCH")
        approved.write_bytes(contents)
        fields = [run("dpkg-deb", "--field", approved, field).decode().strip()
                  for field in ("Package", "Version", "Architecture")]
        check(fields[0] == PKG and matches(VERSION, fields[1]) and fields[2] == arch, "WRONG_PACKAGE_TO_PROMOTE")
        approved.rename(pool / f"{PKG}_{fields[1]}_{arch}.deb")
        apt_config = work / "apt.conf"
        (work / "empty.conf.d").mkdir()
        apt_config.write_text('Dir::Etc::main "/dev/null";\n'
                              'Dir::Etc::parts "/proc/self/cwd/../empty.conf.d";\n', encoding="ascii")
        apt_env = {"APT_CONFIG": str(apt_config)}
        relative = f"dists/{channel}"
        dist = stage / relative
        index = dist / "main" / ("binary-" + arch)
        index.mkdir(parents=True)
        (index / "Packages").write_bytes(run("apt-ftparchive", "packages", "pool", cwd=stage, env=apt_env))
        release = run(
            "apt-ftparchive", "-o", "APT::FTPArchive::Release::Origin=GhostFleet",
            "-o", "APT::FTPArchive::Release::Label=GhostFleet",
            "-o", f"APT::FTPArchive::Release::Suite={channel}", "-o", f"APT::FTPArchive::Release::Codename={channel}",
            "-o", f"APT::FTPArchive::Release::Architectures={arch}", "-o", "APT::FTPArchive::Release::Components=main",
            "-o", f"APT::FTPArchive::Release::Date={format_datetime(now, usegmt=True)}",
            "release", relative, cwd=stage, env=apt_env)
        expiry = b"Valid-Until: " + format_datetime(now + timedelta(hours=valid_hours), usegmt=True).encode("ascii")
        check(not any(line.lower().startswith(b"valid-until:") for line in release.splitlines()),
              "INVALID_RELEASE_VALIDITY")
        (dist / "Release").write_bytes(expiry + b"\n" + release)
        run("gpg", "--no-options", "--homedir", home, "--batch", "--no-auto-key-retrieve",
            "--local-user", fingerprint, "--digest-algo", "SHA256",
            "--output", dist / "InRelease", "--clearsign", dist / "Release")
        for artifact in [stage, *stage.rglob("*")]:
            artifact.chmod(0o755 if artifact.is_dir() else 0o644)
        stage.rename(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    package = commands.add_parser("build")
    package.add_argument("--source-revision", required=True)
    package.add_argument("--version", required=True)
    package.add_argument("--arch", choices=ARCHITECTURES, required=True)
    package.add_argument("--output", type=Path, required=True)
    channel = commands.add_parser("sign-channel")
    channel.add_argument("--package", type=Path, required=True)
    channel.add_argument("--channel", choices=("canary", "stable"), required=True)
    channel.add_argument("--arch", choices=ARCHITECTURES, required=True)
    channel.add_argument("--signing-home", type=Path, required=True)
    channel.add_argument("--fingerprint", required=True)
    channel.add_argument("--expected-sha256", required=True)
    channel.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "build":
        build(args.output.resolve(), args.version, args.arch, args.source_revision)
    else:
        sign(args.output.resolve(), args.package.resolve(), args.channel, args.arch,
             args.signing_home.resolve(), args.fingerprint, expected_sha256=args.expected_sha256)


if __name__ == "__main__":
    main()
