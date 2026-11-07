#!/usr/bin/python3 -I
"""Root-only V4 configuration check/apply/verify/rollback; no package installation."""
from __future__ import annotations
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import pwd
import sys

MODULE = Path(__file__).with_name("fleet_admin_command.py")
spec = importlib.util.spec_from_file_location("fleet_admin_command", MODULE)
if spec is None or spec.loader is None:
    raise SystemExit("ADMIN_MODULE_UNAVAILABLE")
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)


class Installer:
    def __init__(self, target: Path = admin.DEFAULT_CONFIG, fs=None, backend_factory=None):
        self.target = target
        self.fs = fs or admin.TrustedFiles()
        self.manifest = target.parent / "admin-command-installation.json"
        self.backend_factory = backend_factory or admin.SystemdBackend

    def _read_manifest(self):
        if not self.manifest.exists() and not self.manifest.is_symlink():
            return None
        value = admin.json_object(self.fs.read(self.manifest, private=True))
        if value.get("schema") != "ghostfleet-admin-installation/v1":
            admin.fail("ADMIN_INSTALL_MANIFEST_INVALID")
        return value

    def _active(self, state_dir: Path):
        leases = state_dir / "leases"
        if not leases.exists():
            return
        self.fs.path(leases, kind="dir", private=True)
        for entry in leases.iterdir():
            if entry.suffix == ".json":
                record = admin.json_object(self.fs.read(entry, private=True))
                if record.get("state") not in admin.TERMINAL:
                    admin.fail("ADMIN_INSTALL_RECONCILE_REQUIRED")

    def _atomic_bytes(self, path: Path, raw: bytes):
        self.fs.path(path.parent, kind="dir")
        if path.exists() or path.is_symlink():
            self.fs.path(path, private=True)
        tmp = path.parent / ("." + path.name + "." + os.urandom(12).hex())
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, path)
            fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass

    def check(self, candidate: Path):
        cfg = admin.load_config(candidate, self.fs, require_state=False)
        backend = self.backend_factory(cfg, candidate, self.fs)
        backend.preflight()
        self.fs.path(self.target.parent, kind="dir")
        return cfg

    def apply(self, candidate: Path, expected_source: str, expected_current: str):
        raw_source = self.fs.read(candidate, private=True)
        if admin.digest(raw_source) != expected_source:
            admin.fail("ADMIN_INSTALL_SOURCE_MOVED")
        cfg = self.check(candidate)
        new_bytes = admin.canonical(cfg) + b"\n"
        new_hash = admin.digest(new_bytes)
        old = self.fs.read(self.target, private=True) if self.target.exists() or self.target.is_symlink() else None
        current_hash = admin.digest(old) if old is not None else "ABSENT"
        if current_hash != expected_current:
            admin.fail("ADMIN_INSTALL_CURRENT_MOVED")
        manifest = self._read_manifest()
        if old is not None and current_hash == new_hash:
            return {"status": "COMPLIANT", "config_sha256": new_hash, "changed": False}
        if manifest and current_hash not in {manifest["applied_sha256"], manifest["previous_sha256"]}:
            admin.fail("ADMIN_INSTALL_OWNER_CONFLICT")
        state_dir = Path(cfg["state_dir"])
        if state_dir.exists():
            self._active(state_dir)
        else:
            self.fs.mkdir(state_dir)
        if manifest is None:
            manifest = {
                "schema": "ghostfleet-admin-installation/v1",
                "previous_b64": base64.b64encode(old).decode("ascii") if old is not None else None,
                "previous_sha256": current_hash,
            }
        manifest.update(applied_sha256=new_hash, state_dir=str(state_dir), state="APPLYING")
        self._atomic_bytes(self.manifest, admin.canonical(manifest) + b"\n")
        self._atomic_bytes(self.target, new_bytes)
        manifest["state"] = "APPLIED"
        self._atomic_bytes(self.manifest, admin.canonical(manifest) + b"\n")
        return self.verify()

    def verify(self):
        cfg = admin.load_config(self.target, self.fs)
        self.backend_factory(cfg, self.target, self.fs).preflight()
        manifest = self._read_manifest()
        actual = admin.digest(self.fs.read(self.target, private=True))
        if not manifest or actual != manifest["applied_sha256"]:
            admin.fail("ADMIN_INSTALL_VERIFICATION_MISMATCH")
        return {"status": "VERIFIED", "config_sha256": actual, "changed": True,
                "live_approval_execution": "NOT_RUN"}

    def rollback(self, expected_current: str):
        manifest = self._read_manifest()
        if not manifest:
            admin.fail("ADMIN_INSTALL_MANIFEST_REQUIRED")
        current = self.fs.read(self.target, private=True) if self.target.exists() or self.target.is_symlink() else None
        current_hash = admin.digest(current) if current is not None else "ABSENT"
        if current_hash != expected_current or current_hash != manifest["applied_sha256"]:
            admin.fail("ADMIN_INSTALL_CURRENT_MOVED")
        self._active(Path(manifest["state_dir"]))
        previous = manifest["previous_b64"]
        if previous is None:
            self.target.unlink()
            fd = os.open(self.target.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        else:
            raw = admin.b64(previous, admin.MAX_RECORD)
            if admin.digest(raw) != manifest["previous_sha256"]:
                admin.fail("ADMIN_INSTALL_PREIMAGE_CORRUPT")
            self._atomic_bytes(self.target, raw)
        manifest["state"] = "ROLLED_BACK"
        self._atomic_bytes(self.manifest, admin.canonical(manifest) + b"\n")
        return {"status": "ROLLED_BACK", "config_sha256": manifest["previous_sha256"],
                "receipts_retained": True, "ordinary_control_changed": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check", "apply", "verify", "rollback"])
    parser.add_argument("--config-source", type=Path)
    parser.add_argument("--expected-source-sha256")
    parser.add_argument("--expected-current-sha256")
    args = parser.parse_args()
    if os.geteuid() != 0:
        admin.fail("ADMIN_ROOT_BOOTSTRAP_REQUIRED")
    fs = admin.TrustedFiles()
    fs.path(Path(__file__))
    fs.path(MODULE)
    fs.path(Path("/usr/bin/sudo"), executable=True)
    try:
        if pwd.getpwnam(admin.OPS_USER).pw_uid == 0:
            admin.fail("ADMIN_OPS_ACCOUNT_INVALID")
    except KeyError:
        admin.fail("ADMIN_EXISTING_OPS_LANE_REQUIRED")
    manager = Installer(fs=fs)
    if args.action in {"check", "apply"} and args.config_source is None:
        admin.fail("ADMIN_CONFIG_SOURCE_REQUIRED")
    if args.action == "check":
        manager.check(args.config_source)
        result = {"status": "PLAN_READY", "effects": 0,
                  "prerequisite": "EXISTING_DEDICATED_OPS_LANE"}
    elif args.action == "apply":
        if not args.expected_source_sha256 or not args.expected_current_sha256:
            admin.fail("ADMIN_CURRENTNESS_GUARDS_REQUIRED")
        result = manager.apply(args.config_source, args.expected_source_sha256, args.expected_current_sha256)
    elif args.action == "verify":
        result = manager.verify()
    else:
        if not args.expected_current_sha256:
            admin.fail("ADMIN_CURRENTNESS_GUARD_REQUIRED")
        result = manager.rollback(args.expected_current_sha256)
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except admin.AdminError as error:
        print(json.dumps({"ok": False, "error": error.code}, separators=(",", ":")))
        raise SystemExit(1)
