"""Real Linux files, package-manager and systemd adapters for the T3 candidate.

No provider URLs, credentials, enrollment protocol or distro-specific copies of
the convergence engine belong here. Paths and commands come from typed methods.
"""
from __future__ import annotations
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import tempfile

from ghostfleet_runtime.control.enrollment_attempt import AttemptError

STATE = "/var/lib/fleet/converger-v1"
DESCRIPTOR = "/etc/youling-fleet/converger-v1/node.json"
CHECKPOINT = STATE + "/checkpoint.json"
SESSION = STATE + "/resume.json"
MARKER = "fleet-linux-converger/v1"


class ConvergeError(AttemptError):
    pass


class CommandRunner:
    """Fixed-command execution; output is bounded and never printed on failure."""
    def run(self, argv: list[str], *, input_text: str | None = None, timeout: int = 30):
        if not argv or not os.path.isabs(argv[0]):
            raise ConvergeError("EXECUTABLE_MUST_BE_ABSOLUTE")
        # Anonymous output files bound resident memory; caller sees no raw error.
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            try:
                result = subprocess.run(argv, input=input_text.encode() if input_text is not None else None,
                    stdin=subprocess.DEVNULL if input_text is None else None, stdout=out, stderr=err,
                    env={"PATH":"/usr/sbin:/usr/bin:/sbin:/bin", "LANG":"C", "LC_ALL":"C", "DEBIAN_FRONTEND":"noninteractive"},
                    timeout=timeout, check=False)
                out.seek(0)
                raw = out.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise ConvergeError("COMMAND_OUTPUT_TOO_LARGE")
                return result.returncode, raw.decode("utf-8", errors="strict")
            except (OSError, UnicodeError, subprocess.TimeoutExpired):
                raise ConvergeError("COMMAND_OUTCOME_UNKNOWN") from None


class DebianFamily:
    """Install absent exact versions from preconfigured trusted repositories."""
    def __init__(self, runner):
        self.runner = runner

    def package(self, name):
        code, output = self.runner.run(["/usr/bin/dpkg-query", "--show", "--showformat=${db:Status-Status}\t${Version}", "--", name])
        if code == 1 and not output:
            return None
        if code != 0 or not output.startswith("installed\t"):
            raise ConvergeError("PACKAGE_STATE_UNKNOWN")
        return output.split("\t", 1)[1].strip()

    def install(self, missing: dict[str, str]):
        if not missing:
            return
        if any(not re.fullmatch(r"[a-z0-9+.-]+", name) or not re.fullmatch(r"[0-9][A-Za-z0-9.+:~_-]{0,127}", version)
               for name, version in missing.items()):
            raise ConvergeError("PACKAGE_MANIFEST_INVALID")
        args = [f"{name}={version}" for name, version in sorted(missing.items())]
        code, audit = self.runner.run(["/usr/bin/dpkg", "--audit"])
        if code or audit.strip():
            raise ConvergeError("PACKAGE_DATABASE_NOT_CLEAN")
        base = ["/usr/bin/apt-get", "--no-upgrade", "--no-install-recommends", "--no-remove"]
        code, plan = self.runner.run([*base, "--simulate", "install", *args])
        if code != 0:
            raise ConvergeError("PACKAGE_PLAN_UNAVAILABLE")
        planned = set()
        for line in plan.splitlines():
            if line.startswith("Remv "):
                raise ConvergeError("PACKAGE_COLLATERAL_DELTA")
            if line.startswith("Inst "):
                match = re.fullmatch(r"Inst ([a-z0-9+.-]+) \(([^ ]+) .+\)", line)
                if not match or missing.get(match[1]) != match[2]:
                    raise ConvergeError("PACKAGE_COLLATERAL_DELTA")
                planned.add(match[1])
            if line.startswith("Conf ") and line.split()[1] not in missing:
                raise ConvergeError("PACKAGE_COLLATERAL_DELTA")
        if planned != set(missing):
            raise ConvergeError("PACKAGE_PLAN_MISMATCH")
        # Re-read before mutation; an in-transaction pre-dpkg hook also verifies
        # every archive, so a changed apt solver cannot silently add upgrades.
        if any(self.package(name) is not None for name in missing):
            raise ConvergeError("PACKAGE_PRECONDITION_CHANGED")
        guard = shlex.join(["/usr/bin/python3", "-m", "ghostfleet_runtime.linux.package_guard", *args])
        code, _ = self.runner.run([*base, "-o", "DPkg::ConfigurePending=false", "-o", "DPkg::Pre-Install-Pkgs::="+guard,
                                   "--assume-yes", "install", *args], timeout=300)
        if code != 0:
            raise ConvergeError("PACKAGE_APPLY_UNKNOWN")


class LinuxSystem:
    def __init__(self, *, root: Path = Path("/"), runner=None, owner_uid: int = 0):
        self.root = root.absolute()
        self.runner = runner or CommandRunner()
        self.owner_uid = owner_uid
        self.family = DebianFamily(self.runner)

    def path(self, absolute: str) -> Path:
        if not absolute.startswith("/") or ".." in Path(absolute).parts:
            raise ConvergeError("PATH_INVALID")
        return self.root / absolute.lstrip("/")

    def trusted(self, path: Path, *, secret=False, executable=False):
        try:
            relative = path.relative_to(self.root)
            current = self.root
            for part in relative.parts:
                current = current / part
                info = current.lstat()
                if stat.S_ISLNK(info.st_mode) or info.st_uid != self.owner_uid or info.st_mode & 0o022:
                    raise ConvergeError("FOREIGN_OR_UNTRUSTED_PATH")
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or (secret and stat.S_IMODE(info.st_mode) != 0o600):
                raise ConvergeError("PRIVATE_FILE_UNTRUSTED")
            if executable and not info.st_mode & 0o100:
                raise ConvergeError("ADAPTER_NOT_EXECUTABLE")
        except (OSError, ValueError):
            raise ConvergeError("TRUSTED_FILE_UNAVAILABLE") from None

    def read_json(self, absolute: str, *, secret=False, optional=False):
        path = self.path(absolute)
        if optional and not path.exists() and not path.is_symlink():
            return None
        self.trusted(path, secret=secret)
        if path.stat().st_size > 65536:
            raise ConvergeError("FILE_TOO_LARGE")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, OSError):
            raise ConvergeError("STATE_FILE_INVALID") from None

    def validate_destination(self, absolute):
        """Read-only preflight, including missing leaves below hostile parents."""
        path = self.path(absolute)
        current = self.root
        for part in path.parent.relative_to(self.root).parts:
            current /= part
            try:
                info = current.lstat()
            except FileNotFoundError:
                return  # Later ancestors cannot exist without this directory.
            if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
                    or info.st_uid != self.owner_uid or info.st_mode & 0o022):
                raise ConvergeError("FOREIGN_OR_UNTRUSTED_PATH")
        if path.exists() or path.is_symlink():
            self.trusted(path)

    def file_observation(self, absolute):
        path = self.path(absolute)
        if not path.exists() and not path.is_symlink():
            return None
        self.trusted(path)
        info = path.stat()
        return {"sha256": "sha256:"+hashlib.sha256(path.read_bytes()).hexdigest(),
                "mode": stat.S_IMODE(info.st_mode), "owner_uid": info.st_uid}

    def file_matches(self, absolute, value, *, secret=False):
        observed = self.file_observation(absolute)
        content = (json.dumps(value, sort_keys=True, separators=(",", ":"))+"\n").encode()
        return observed == {"sha256": "sha256:"+hashlib.sha256(content).hexdigest(),
                            "mode": 0o600 if secret else 0o644, "owner_uid": self.owner_uid}

    def _parents(self, path):
        current = self.root
        for part in path.parent.relative_to(self.root).parts:
            current /= part
            if not current.exists():
                current.mkdir(mode=0o700)
            info = current.lstat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != self.owner_uid or info.st_mode & 0o022:
                raise ConvergeError("FOREIGN_OR_UNTRUSTED_PATH")

    def write_json(self, absolute, value, *, secret=False):
        path = self.path(absolute)
        self._parents(path)
        mode = 0o600 if secret else 0o644
        content = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
        if path.exists() or path.is_symlink():
            self.trusted(path)
            old = self.read_json(absolute)
            if old.get("owner") != MARKER or old.get("node_uid") != value.get("node_uid"):
                raise ConvergeError("OWNED_FILE_CONFLICT")
            if path.read_bytes() == content and stat.S_IMODE(path.stat().st_mode) == mode:
                return False
        fd, tmp = tempfile.mkstemp(prefix=".fleet-", dir=path.parent)
        try:
            os.fchmod(fd, mode)
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, path)
            directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        return True

    @contextmanager
    def lock(self):
        import fcntl
        path = self.path(STATE + "/admission.lock")
        self._parents(path)
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != self.owner_uid or stat.S_IMODE(info.st_mode) != 0o600:
                raise ConvergeError("ADMISSION_LOCK_UNTRUSTED")
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(fd)

    def host_identity(self):
        path = self.path("/etc/machine-id")
        self.trusted(path)
        machine = path.read_text().strip()
        if not re.fullmatch(r"[0-9a-f]{32}", machine):
            raise ConvergeError("MACHINE_ID_INVALID")
        release = self.path("/etc/os-release")
        # /etc/os-release is commonly a vendor symlink; read-only resolution is
        # allowed only inside the system root, with a trusted regular target.
        release = release.resolve()
        self.trusted(release)
        values = {}
        for line in release.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                parsed = shlex.split(value)
                values[key] = parsed[0] if len(parsed) == 1 else ""
        if not set((values.get("ID", "") + " " + values.get("ID_LIKE", "")).split()) & {"debian", "ubuntu", "armbian"}:
            raise ConvergeError("OS_FAMILY_UNSUPPORTED")
        return {"machine_id_sha256":"sha256:"+hashlib.sha256(machine.encode()).hexdigest(), "os_family":"debian-family"}

    def service(self):
        code, raw = self.runner.run(["/usr/bin/systemctl", "show", "tailscaled.service", "--property=LoadState,ActiveState,UnitFileState"])
        if code != 0:
            raise ConvergeError("SERVICE_STATE_UNKNOWN")
        fields = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
        if fields.get("LoadState") not in {"loaded", "not-found"} or fields.get("ActiveState") not in {"active", "inactive", "failed"}:
            raise ConvergeError("SERVICE_STATE_UNKNOWN")
        if fields.get("UnitFileState", "") not in {"enabled", "disabled", ""}:
            raise ConvergeError("FOREIGN_SERVICE_POLICY")
        return fields

    def service_action(self, action):
        if action not in {"enable", "start"}:
            raise ConvergeError("SERVICE_ACTION_FORBIDDEN")
        code, _ = self.runner.run(["/usr/bin/systemctl", action, "tailscaled.service"])
        if code != 0:
            raise ConvergeError("SERVICE_APPLY_UNKNOWN")
