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
import shutil
import subprocess
import sys
import tarfile
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent / "host"))
from update import ARCHITECTURES, COMMIT, FINGERPRINT, MAX_SIZE, PAYLOAD, PKG, SHA, VERSION, check, matches  # noqa: E402

HOST = "nextgen/host/"
BOOTSTRAP = {
    HOST + "node.py": "node.py",
    HOST + "update.py": "update.py",
    HOST + "report.py": "report.py",
    HOST + "ghostfleet-nextgen-report.service": "ghostfleet-nextgen-report.service",
    HOST + "ghostfleet-nextgen-report.timer": "ghostfleet-nextgen-report.timer",
    HOST + "ghostfleet-nextgen-update.service": "ghostfleet-nextgen-update.service",
    HOST + "ghostfleet-nextgen-update.timer": "ghostfleet-nextgen-update.timer",
    HOST + "ghostfleet-nextgen-k3s-agent.service": "ghostfleet-nextgen-k3s-agent.service",
    "nextgen/native.py": "native.py",
}


def run(*args, cwd=None, env=None):
    return subprocess.check_output(args, cwd=cwd, env=env, timeout=120)


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
        for path in root.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)
        archive = Path(build) / filename
        run("dpkg-deb", "--root-owner-group", "--build", root, archive,
            env={**os.environ, "SOURCE_DATE_EPOCH": str(epoch)})
        check(not (out / filename).exists(), "OUTPUT_ALREADY_EXISTS")
        archive.rename(out / filename)
    return out / filename


def build(out, version, arch):
    check(not run("git", "status", "--porcelain=v1", "--untracked-files=all").strip(), "DIRTY_CHECKOUT")
    source = run("git", "rev-parse", "HEAD").decode().strip()
    epoch = int(run("git", "show", "-s", "--format=%ct", source))
    snapshot = run("git", "archive", "--format=tar", source, "nextgen/host", "nextgen/native.py")
    with tarfile.open(fileobj=io.BytesIO(snapshot)) as bundle:
        files = {}
        for original, filename in BOOTSTRAP.items():
            member = bundle.getmember(original)
            check(member.isfile() and member.size <= 1024 * 1024, "INVALID_BUILD_INPUT")
            files[filename] = bundle.extractfile(member).read()
    out.mkdir(parents=True, exist_ok=True)
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
    artifacts = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (package, artifact)}
    print(json.dumps({"source_revision": source, "version": version, "platform": "debian13-" + arch,
                      "sha256": artifacts}, sort_keys=True))


def sign(out, package, channel, arch, home, fingerprint, *, expected_sha256, now=None, valid_hours=24):
    check(matches(FINGERPRINT, fingerprint) and channel in ("canary", "stable") and arch in ARCHITECTURES,
          "INVALID_SIGNING_INPUT")
    check(not out.exists() and out.parent.is_dir(), "ARCHIVE_OUTPUT_MUST_BE_NEW")
    check(matches(SHA, expected_sha256) and 0 < package.stat().st_size <= MAX_SIZE, "INVALID_PROMOTION_DIGEST")
    fields = [run("dpkg-deb", "--field", package, field).decode().strip()
              for field in ("Package", "Version", "Architecture")]
    check(fields[0] == PKG and matches(VERSION, fields[1]) and fields[2] == arch, "WRONG_PACKAGE_TO_PROMOTE")
    now = now or datetime.now(timezone.utc)
    with tempfile.TemporaryDirectory(prefix=".ghostfleet-publish-", dir=out.parent) as directory:
        stage = Path(directory) / "archive"
        pool = stage / "pool"
        pool.mkdir(parents=True)
        staged_package = pool / f"{PKG}_{fields[1]}_{arch}.deb"
        shutil.copyfile(package, staged_package)
        check(hashlib.sha256(staged_package.read_bytes()).hexdigest() == expected_sha256, "PROMOTION_DIGEST_MISMATCH")
        relative = f"dists/{channel}"
        dist = stage / relative
        index = dist / "main" / ("binary-" + arch)
        index.mkdir(parents=True)
        (index / "Packages").write_bytes(run("apt-ftparchive", "packages", "pool", cwd=stage))
        release = run(
            "apt-ftparchive", "-o", "APT::FTPArchive::Release::Origin=GhostFleet",
            "-o", "APT::FTPArchive::Release::Label=GhostFleet",
            "-o", f"APT::FTPArchive::Release::Suite={channel}", "-o", f"APT::FTPArchive::Release::Codename={channel}",
            "-o", f"APT::FTPArchive::Release::Architectures={arch}", "-o", "APT::FTPArchive::Release::Components=main",
            "-o", f"APT::FTPArchive::Release::Date={format_datetime(now, usegmt=True)}",
            "release", relative, cwd=stage)
        (dist / "Release").write_bytes(
            ("Valid-Until: " + format_datetime(now + timedelta(hours=valid_hours), usegmt=True) + "\n").encode() + release)
        run("gpg", "--homedir", home, "--batch", "--local-user", fingerprint, "--digest-algo", "SHA256",
            "--output", dist / "InRelease", "--clearsign", dist / "Release")
        stage.rename(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    package = commands.add_parser("build")
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
        build(args.output.resolve(), args.version, args.arch)
    else:
        sign(args.output.resolve(), args.package.resolve(), args.channel, args.arch,
             args.signing_home.resolve(), args.fingerprint, expected_sha256=args.expected_sha256)


if __name__ == "__main__":
    main()
