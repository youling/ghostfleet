#!/usr/bin/env python3
"""Stage an offline Debian toolchain supply from signed APT indexes."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile


LOCK = Path(__file__).with_name("restore.lock.json")
APT_MIRRORS = ("https://deb.debian.org/debian/",)
SUITES = ("trixie",)
ARCHIVE_KEYRING = "/usr/share/keyrings/debian-archive-keyring.gpg"
NPM_MIRROR = "https://registry.npmjs.org/"
INSTALL = re.compile(r"^Inst (\S+)(?: \[[^]]+\])? \((\S+)")


def digest(path):
    with path.open("rb") as stream:
        return sha256_file(stream)


def sha256_file(stream):
    result = sha256()
    for chunk in iter(lambda: stream.read(1 << 20), b""):
        result.update(chunk)
    return result.hexdigest()


def run(*argv, environment=None):
    return subprocess.check_output(argv, env=environment, text=True, timeout=240)


def download(uri, destination, expected, caches):
    for cache in caches:
        cached = cache / destination.name
        if cached.is_file() and digest(cached) == expected:
            shutil.copyfile(cached, destination)
            return
    urls = [uri]
    if uri.startswith(APT_MIRRORS[0]):
        urls.append(uri.replace(APT_MIRRORS[0], "https://ftp.debian.org/debian/", 1))
    for url in urls:
        response = subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
            "--proto-redir", "=https", "--connect-timeout", "10", "--max-time", "55", "--speed-time", "15",
            "--speed-limit", "4096", "--output", destination, url], check=False, timeout=60)
        if response.returncode == 0:
            if digest(destination) != expected:
                raise ValueError(f"Artifact digest mismatch: {destination.name}")
            return
    raise ValueError(f"Artifact download failed: {destination.name}")


def apt_configuration(directory, status):
    lists = directory / "lists"
    (lists / "partial").mkdir(parents=True)
    empty = directory / "empty"
    empty.mkdir()
    sources = directory / "debian.sources"
    sources.write_text("\n\n".join(
        f"Types: deb\nURIs: {mirror}\nSuites: {suite}\nComponents: main\nArchitectures: amd64\nSigned-By: {ARCHIVE_KEYRING}"
        for mirror, suite in zip(APT_MIRRORS, SUITES, strict=True)
    ) + "\n")
    config = directory / "apt.conf"
    config.write_text(
        f'Dir::Etc::parts "{empty}"; Dir::Etc::main "/dev/null";\n'
        f'Dir::Etc::sourceparts "{empty}"; Dir::Etc::sourcelist "{sources}";\n'
        f'Dir::State::status "{status}"; Dir::State::lists "{lists}";\n'
        'Dir::Cache::pkgcache ""; Dir::Cache::srcpkgcache ""; APT::Architecture "amd64";\n'
        'Acquire::Languages "none"; APT::Update::Error-Mode "any"; '
        'Acquire::AllowInsecureRepositories "false"; Acquire::Check-Valid-Until "true";\n'
    )
    return {"APT_CONFIG": str(config), "PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}, lists


def copy_signed_indexes(cache, destination):
    for mirror, suite in zip(APT_MIRRORS, SUITES, strict=True):
        prefix = mirror.removeprefix("https://").replace("/", "_") + f"dists_{suite}"
        release_path = destination / f"{prefix}_InRelease"
        shutil.copyfile(cache / release_path.name, release_path)
        release = run("gpgv", "--keyring", ARCHIVE_KEYRING, "--output", "-", release_path)
        fields = dict(line.split(": ", 1) for line in release.splitlines() if re.match(r"^[A-Za-z-]+: ", line))
        now = datetime.now(timezone.utc)
        date = parsedate_to_datetime(fields["Date"])
        expires = parsedate_to_datetime(fields["Valid-Until"]) if "Valid-Until" in fields else None
        if (fields["Codename"] != suite or date > now + timedelta(seconds=10) or
                expires is not None and expires <= now):
            raise ValueError(f"Cached Debian release is outside its declared scope or validity: {suite}")
        sha_table = re.search(r"(?m)^SHA256:\n((?: +[a-f0-9]{64} +\d+ +\S+\n)+)", release)
        fields_by_path = {path: (expected, int(size)) for expected, size, path in
                          (line.split() for line in sha_table.group(1).splitlines())}
        expected, size = fields_by_path["main/binary-amd64/Packages"]
        stem = f"{prefix}_main_binary-amd64_Packages"
        candidates = [cache / (stem + suffix) for suffix in ("", ".lz4", ".xz", ".gz") if (cache / (stem + suffix)).is_file()]
        if len(candidates) != 1:
            raise ValueError(f"Expected one cached package index: {suite}")
        index = destination / candidates[0].name
        shutil.copyfile(candidates[0], index)
        with tempfile.TemporaryFile() as expanded:
            subprocess.run(["/usr/lib/apt/apt-helper", "cat-file", index], stdout=expanded, check=True, timeout=30)
            length = expanded.tell()
            expanded.seek(0)
            if length != size or sha256_file(expanded) != expected:
                raise ValueError(f"Cached Debian index differs from signed release metadata: {suite}")


def collect_package(fields, stage, direct, caches):
    uri, filename, size, checksum = fields
    if not uri.startswith(APT_MIRRORS) or not re.fullmatch(r"[A-Za-z0-9_.+%~-]+\.deb", filename):
        raise ValueError("Unexpected package locator from APT")
    algorithm, expected = checksum.split(":", 1)
    if algorithm != "SHA256" or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError("APT did not provide an exact SHA-256")
    artifact = stage / "apt" / filename
    download(uri, artifact, expected, caches)
    if artifact.stat().st_size != int(size):
        raise ValueError(f"Unexpected package size: {filename}")
    name, version = run("dpkg-deb", "--show", "--showformat=${Package}\n${Version}", artifact).splitlines()
    if name in direct and direct[name] != {"version": version, "sha256": expected}:
        raise ValueError(f"APT package differs from project lock: {name}")
    return name, version, str(artifact.relative_to(stage))


def prepare(output, status, node_archive, caches, index_cache):
    lock = json.loads(LOCK.read_text())
    direct = lock["apt"]
    if output.exists() or not output.parent.is_dir():
        raise ValueError("Use a new output directory inside an existing owner-controlled directory")
    with tempfile.TemporaryDirectory(prefix=".toolchain-supply-", dir=output.parent) as temporary:
        workspace = Path(temporary)
        stage = workspace / "supply"
        (stage / "apt").mkdir(parents=True)
        (stage / "npm").mkdir()
        environment, lists = apt_configuration(workspace, status)
        if index_cache is None:
            run("apt-get", "update", environment=environment)
        else:
            copy_signed_indexes(index_cache, lists)
        metadata = {file.name: digest(file) for file in sorted(lists.glob("*_InRelease"))}
        if len(metadata) != len(APT_MIRRORS):
            raise ValueError("Signed APT release records are incomplete")
        pinned = {name: entry["version"] for name, entry in direct.items()}
        goals = [f"{name}={version}" for name, version in pinned.items()]
        plan = run("apt-get", "--simulate", "install", "--no-install-recommends", "--no-remove", *goals,
                   environment=environment)
        resolved = {**pinned, **dict(match.groups() for line in plan.splitlines() if (match := INSTALL.match(line)))}
        requested = [f"{name}={version}" for name, version in sorted(resolved.items())]
        locators = run("apt-get", "--print-uris", "download", *requested, environment=environment)
        entries = [shlex.split(line) for line in locators.splitlines() if line.startswith("'")]
        if len(entries) != len(resolved):
            raise ValueError("APT did not resolve every package to one archive")
        with ThreadPoolExecutor(max_workers=8) as pool:
            packages = list(pool.map(lambda fields: collect_package(fields, stage, direct, caches), entries))
        observed = {name: version for name, version, _ in packages}
        if observed != resolved:
            raise ValueError("APT archives do not match the resolved transaction")
        (stage / "packages.tsv").write_text("".join("\t".join(row) + "\n" for row in sorted(packages)))
        for name, entry in sorted(lock["npm"].items()):
            filename = f"{name}-{entry['version']}.tgz"
            destination = stage / "npm" / filename
            if name == "node-linux-x64" and node_archive:
                shutil.copyfile(node_archive, destination)
                if digest(destination) != entry["sha256"]:
                    raise ValueError("Cached Node archive does not match the project lock")
            else:
                download(f"{NPM_MIRROR}{name}/-/{filename}", destination, entry["sha256"], caches)
        baseline = digest(status)
        (stage / "baseline.status.sha256").write_text(baseline + "\n")
        (stage / "source.json").write_text(json.dumps({"platform": lock["platform"], "lock_sha256": digest(LOCK),
            "apt_inrelease_sha256": metadata, "baseline_dpkg_status_sha256": baseline}, sort_keys=True) + "\n")
        paths = sorted(path for path in stage.rglob("*") if path.is_file())
        sums = stage / "SHA256SUMS"
        sums.write_text("".join(f"{digest(path)}  {path.relative_to(stage)}\n" for path in paths))
        result = {"result": "READY", "manifest_sha256": digest(sums), "apt_packaged": len(packages),
                  "lock_sha256": digest(LOCK)}
        stage.rename(output)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-status", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--node-archive", type=Path)
    parser.add_argument("--verified-cache", type=Path, action="append", default=[])
    parser.add_argument("--index-cache", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    prepare(args.output.absolute(), args.target_status.absolute(), args.node_archive, args.verified_cache, args.index_cache)
