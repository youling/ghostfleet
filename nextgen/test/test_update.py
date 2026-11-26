"""Native APT integration with temporary keys, archives and state."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

NEXTGEN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(NEXTGEN))
from release import build_package, sign
from update import UpdateError, active, pull


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
