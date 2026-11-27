"""Native APT integration with temporary keys, archives and state."""
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import hashlib
from io import StringIO
import json
import os
import pwd
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

NEXTGEN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(NEXTGEN))
from release import BOOTSTRAP, build, build_package, sign
from update import UpdateError, active, command, pull, sandbox


class ReleaseBuildTest(unittest.TestCase):
    def test_installer_bootstrap_and_reporter_payload(self):
        revision = "1" * 40
        version = "0.3.0~rc3"
        epoch = 1_760_000_000
        release_path = "nextgen/release.py"
        sources = {path: path.encode() for path in (*BOOTSTRAP, release_path)}
        git_results = {
            ("rev-parse", "HEAD"): revision.encode(),
            ("status", "--porcelain=v1", "--untracked-files=all"): b"",
            ("show", "-s", "--format=%ct", revision): str(epoch).encode(),
            **{("cat-file", "blob", f"{revision}:{path}"): contents for path, contents in sources.items()},
        }
        expected_installer = {
            "install.py": "nextgen/host/install.py",
            "install-profile.schema.json": "nextgen/install-profile.schema.json",
            "OPERATIONS.md": "docs/nextgen/OPERATIONS.md",
        }
        with tempfile.TemporaryDirectory() as tmp, patch("release.check_toolchain"), \
                patch("release.git", side_effect=lambda *args: git_results[args]):
            out = Path(tmp) / "release"
            for retired in ("0.3.0~rc1", "0.3.0~rc2", "0.3.0~rc2+rebuild"):
                with self.subTest(version=retired), self.assertRaisesRegex(UpdateError, "RELEASE_VERSION_TOO_OLD"):
                    build(out, retired, "amd64", revision)
                self.assertFalse(out.exists())

            with redirect_stdout(StringIO()) as stdout:
                build(out, version, "amd64", revision)
            receipt = json.loads(stdout.getvalue())
            self.assertEqual(receipt["version"], version)
            self.assertEqual(receipt["source_revision"], revision)
            self.assertEqual(receipt["input_sha256"], {path: hashlib.sha256(data).hexdigest()
                                                      for path, data in sources.items()})
            with tarfile.open(out / "ghostfleet-bootstrap.tar.gz", "r:gz") as tar:
                self.assertEqual(tar.getnames(), sorted(BOOTSTRAP.values()))
                for name, source in expected_installer.items():
                    member = tar.getmember(name)
                    self.assertTrue(member.isfile())
                    self.assertEqual(tar.extractfile(member).read(), sources[source])
                    self.assertEqual((member.mode, member.mtime), (0o644, epoch))

            extracted = Path(tmp) / "package"
            package = out / f"ghostfleet-node_{version}_amd64.deb"
            subprocess.run(["dpkg-deb", "-x", package, extracted], check=True, timeout=30)
            payload = extracted / "usr/share/ghostfleet-nextgen"
            self.assertEqual(sorted(path.name for path in payload.iterdir()), ["node.py", "release.json"])
            self.assertEqual((payload / "node.py").read_bytes(), sources["nextgen/host/node.py"])
            self.assertEqual(receipt["sha256"], {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                                for path in out.iterdir()})


class UpdateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        required = ("gpg", "gpgconf", "apt-ftparchive", "dpkg-deb", "apt-get", "apt-cache")
        if os.geteuid() != 0 or not all(shutil.which(tool) for tool in required):
            raise RuntimeError("Run in disposable Debian Linux with root, APT tools and GnuPG")
        cls.tmp = tempfile.TemporaryDirectory(prefix="ghostfleet-apt-test-")
        cls.addClassCleanup(cls.tmp.cleanup)
        cls.base = Path(cls.tmp.name)
        cls.base.chmod(0o755)
        cls.trusted, cls.fingerprint = cls.new_key("Trusted Fixture")
        cls.foreign, cls.foreign_fingerprint = cls.new_key("Untrusted Fixture")
        cls.keyring = cls.base / "public.gpg"
        with cls.keyring.open("wb") as out:
            subprocess.run(["gpg", "--homedir", str(cls.trusted), "--export", cls.fingerprint],
                           check=True, stdout=out, stderr=subprocess.DEVNULL, timeout=30)
        cls.reporter = (NEXTGEN / "host/node.py").read_bytes()
        cls.revision = "1" * 40

    @classmethod
    def new_key(cls, label):
        home = cls.base / label.replace(" ", "-")
        home.mkdir(mode=0o700)
        cls.addClassCleanup(subprocess.run, ["gpgconf", "--homedir", str(home), "--kill", "all"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=False)
        args = ["gpg", "--homedir", str(home), "--batch", "--pinentry-mode", "loopback", "--passphrase", ""]
        subprocess.run(args + ["--quick-generate-key", label, "ed25519", "sign", "1d"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        listing = subprocess.check_output(args + ["--with-colons", "--list-keys"], timeout=30).decode()
        return home, next(line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:"))

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="scenario-", dir=self.base))
        self.workspace.chmod(0o755)
        self.installed = self.workspace / "software"
        self.installed.mkdir(mode=0o755)
        self.credentials = self.workspace / "node-credentials.json"
        self.credentials.write_text('{"fixture":"retained-identity"}')

    def channel(self, version, *, tag=None, signer=None, expired=False, arch="amd64", reporter=None, name="canary"):
        suffix = tag or version
        out = self.workspace / (suffix + "-package")
        out.mkdir()
        package = build_package(out, self.revision, 1_760_000_000, version, arch, reporter or self.reporter)
        if expired:
            now = datetime.now(timezone.utc) - timedelta(hours=30)
        else:
            now = datetime.now(timezone.utc)
        archive = self.workspace / suffix
        key, fingerprint = signer or (self.trusted, self.fingerprint)
        sign(archive, package, name, arch, key, fingerprint, now=now,
             expected_sha256=hashlib.sha256(package.read_bytes()).hexdigest())
        return {"uri": archive.as_uri(), "channel": name, "keyring": str(self.keyring),
                "fingerprint": self.fingerprint}, package

    def test_umask_build_and_minimum_runtime_access(self):
        version = "0.3.0~rc2"
        original = os.umask(0o022)
        try:
            config, first = self.channel(version)
            os.umask(0o077)
            _, other = self.channel(version, tag="private-build")
            self.assertEqual(first.read_bytes(), other.read_bytes())
            self.assertEqual(pull(self.installed, config, "amd64"), "ACTIVATED")
            slot = (self.installed / "current").resolve()
            for name in ("receipt.json", "node.py"):
                self.assertEqual((slot / name).stat().st_mode & 0o777, 0o644)
            # Correct an rc1 slot previously staged under a restricted umask.
            slot.chmod(0o700)
            (slot / "receipt.json").chmod(0o600)
            self.assertEqual(pull(self.installed, config, "amd64"), "UNCHANGED")
            subprocess.run(["cat", str(slot / "receipt.json")], check=True, stdout=subprocess.DEVNULL,
                           user="nobody", group="nogroup", extra_groups=[])
        finally:
            os.umask(original)

    def test_native_apt_identity_and_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            env = sandbox(root, {"uri": "https://packages.example.invalid", "channel": "canary",
                                 "keyring": str(self.keyring), "fingerprint": self.fingerprint}, "amd64")
            self.assertEqual(int(command(["id", "-u"], env=env, unprivileged=True)), pwd.getpwnam("_apt").pw_uid)
            self.assertEqual(command(["id", "-G"], env=env, unprivileged=True).strip(), str(pwd.getpwnam("_apt").pw_gid))
            for setting, filename in (("preferences/f", "preferences"), ("preferencesparts/d", "preferences.d"),
                                      ("netrc/f", "auth.conf"), ("netrcparts/d", "auth.conf.d")):
                value = command(["apt-config", "shell", "ENTRY", "Dir::Etc::" + setting], env=env, unprivileged=True)
                value = value.strip().removeprefix("ENTRY='").removesuffix("'")
                self.assertEqual(Path(value), root / filename)

    def test_signer_expiry_and_commit_guards(self):
        # A normal foreign configuration and a private umask do not select release inputs.
        with patch.dict(os.environ, {"APT_CONFIG": str(self.workspace / "unrelated.conf"),
                                     "GNUPGHOME": str(self.foreign), "LC_ALL": "C"}):
            config, _ = self.channel("0.3.0~rc2")
        self.assertEqual(pull(self.installed, config, "amd64"), "ACTIVATED")
        release = (self.workspace / "0.3.0~rc2/dists/canary/Release").read_text()
        self.assertEqual(sum(line.lower().startswith("valid-until:") for line in release.splitlines()), 1)
        with self.assertRaisesRegex(UpdateError, "SOURCE_REVISION_MISMATCH"):
            build(self.workspace / "unpublished", "0.3.0~rc2", "amd64", "wrong")
        self.assertFalse((self.workspace / "unpublished").exists())
        report_actions = subprocess.check_output([sys.executable, "-I", NEXTGEN / "host/node.py", "--help"], text=True)
        self.assertNotIn("adopt", report_actions)
        self.assertNotIn("enroll", report_actions)

    def test_upgrade_noop_and_reviewed_roll_forward(self):
        first, previous = self.channel("0.3.0~rc1")
        second, latest = self.channel("0.3.0~rc2", reporter=self.reporter + b"\n# fixture change\n")
        third, known_good = self.channel("0.3.0~rc3")
        self.assertEqual(pull(self.installed, first, "amd64"), "ACTIVATED")
        self.assertEqual(active(self.installed)["sha256"], hashlib.sha256(previous.read_bytes()).hexdigest())
        self.assertEqual(pull(self.installed, first, "amd64"), "UNCHANGED")
        self.assertEqual(pull(self.installed, second, "amd64"), "ACTIVATED")
        self.assertEqual(active(self.installed)["sha256"], hashlib.sha256(latest.read_bytes()).hexdigest())
        with self.assertRaisesRegex(UpdateError, "ROLLBACK_REFUSED"):
            pull(self.installed, first, "amd64")
        self.assertEqual(pull(self.installed, third, "amd64"), "ACTIVATED")
        self.assertEqual(active(self.installed)["sha256"], hashlib.sha256(known_good.read_bytes()).hexdigest())
        self.assertEqual((self.installed / "current/node.py").read_bytes(), self.reporter)
        self.assertEqual(json.loads(self.credentials.read_text()), {"fixture": "retained-identity"})

    def test_signature_expiry_arch_and_tampering_fail_closed(self):
        baseline, _ = self.channel("0.3.0~rc1")
        self.assertEqual(pull(self.installed, baseline, "amd64"), "ACTIVATED")
        before = (self.installed / "current").readlink()
        foreign, _ = self.channel("0.3.0~rc2", signer=(self.foreign, self.foreign_fingerprint))
        expired, _ = self.channel("0.3.0~rc3", expired=True)
        wrong_arch, _ = self.channel("0.3.0~rc4", arch="arm64")
        wrong_channel, _ = self.channel("0.3.0~rc6", name="stable")
        wrong_archive = self.workspace / "0.3.0~rc6" / "dists"
        (wrong_archive / "stable").rename(wrong_archive / "canary")
        wrong_channel["channel"] = "canary"
        corrupt, package = self.channel("0.3.0~rc5")
        contents = self.workspace / "0.3.0~rc5/pool" / package.name
        with contents.open("r+b") as stream:
            stream.seek(-1, os.SEEK_END)
            tail = stream.read(1)
            stream.seek(-1, os.SEEK_END)
            stream.write(bytes([tail[0] ^ 1]))
        for bad in (foreign, expired, wrong_arch, wrong_channel, corrupt):
            with self.subTest(archive=Path(bad["uri"]).name):
                with self.assertRaises(UpdateError):
                    pull(self.installed, bad, "amd64")
                self.assertEqual((self.installed / "current").readlink(), before)

    def test_immutable_version_and_interrupted_activation(self):
        first, _ = self.channel("0.3.0~rc1")
        rewritten, _ = self.channel("0.3.0~rc1", tag="rewritten", reporter=self.reporter + b"\n# different\n")
        second, _ = self.channel("0.3.0~rc2")
        with self.assertRaisesRegex(UpdateError, "BELOW_APPROVED_FLOOR"):
            pull(self.installed, {**first, "minimum_version": "0.3.0~rc2"}, "amd64")
        pull(self.installed, first, "amd64")
        before = active(self.installed)
        with self.assertRaisesRegex(UpdateError, "IMMUTABLE_VERSION_CONFLICT"):
            pull(self.installed, rewritten, "amd64")
        original = Path.replace

        def interrupt(path, destination):
            if destination == self.installed / "current":
                raise OSError("fixture interruption before commit")
            return original(path, destination)

        with patch.object(Path, "replace", interrupt), self.assertRaises(OSError):
            pull(self.installed, second, "amd64")
        self.assertEqual(active(self.installed), before)
        self.assertEqual(pull(self.installed, second, "amd64"), "ACTIVATED")
        self.assertEqual(active(self.installed)["version"], "0.3.0~rc2")


if __name__ == "__main__":
    unittest.main()
