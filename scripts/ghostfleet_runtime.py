"""One-shot invocation and checked file handoff on the local workstation."""
import argparse
import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time


class Failure(Exception):
    """Stable receipt category; never include command arguments or launch diagnostics."""


def require(condition, status="INVALID_REQUEST"):
    if not condition:
        raise Failure(status)


def fields(value, names):
    require(type(value) is dict and set(value) == set(names.split()))


def string(value):
    return type(value) is str and "\0" not in value


def validate(r):
    fields(r, "os shell distro user cwd argv timeout_seconds output_limit_bytes")
    require(r["os"] in ("linux", "windows", "wsl"))
    require(string(r["user"]) and 0 < len(r["user"]) <= 128 and not r["user"].startswith("-"))
    windows = r["os"] == "windows"
    require((windows and r["distro"] is None) or
            (not windows and string(r["distro"]) and 0 < len(r["distro"]) <= 128 and not r["distro"].startswith("-")))
    require(r["shell"] in (("powershell",) if windows else ("exec", "bash")))
    path = PureWindowsPath if windows else PurePosixPath
    require(string(r["cwd"]) and path(r["cwd"]).is_absolute())
    args = r["argv"]
    require(type(args) is list and 0 < len(args) <= 128 and all(string(a) for a in args))
    require(path(args[0]).is_absolute() and len(json.dumps(args, ensure_ascii=False).encode()) <= 16000)
    if windows:
        require(path(args[0]).suffix.lower() == ".ps1")
    require(type(r["timeout_seconds"]) is int and 1 <= r["timeout_seconds"] <= 3600)
    require(type(r["output_limit_bytes"]) is int and 1 <= r["output_limit_bytes"] <= 1048576)


def receipt(status, code=None, stdout="", stderr=""):
    return {"status": status, "exit_code": code, "stdout": stdout, "stderr": stderr}


def windows_user():
    size = ctypes.c_ulong(257)
    buf = ctypes.create_unicode_buffer(size.value)
    require(ctypes.windll.advapi32.GetUserNameW(buf, ctypes.byref(size)), "TARGET_UNAVAILABLE")
    return buf.value


def windows_child(argv, cwd, env):
    # Do not release the fixed bootstrap's stdin until it belongs to our job.
    # Descendants are then cancellable even after the original script exits.
    win = ctypes.WinDLL("kernel32", use_last_error=True)
    win.CreateJobObjectW.restype = ctypes.c_void_p
    job = win.CreateJobObjectW(None, None)
    require(job, "WINDOWS_JOB_UNAVAILABLE")
    job = ctypes.c_void_p(job)
    p = None
    def stop():
        try:
            win.TerminateJobObject(job, 1)
        finally:
            win.CloseHandle(job)
    try:
        bootstrap = ("import json,subprocess,sys; "
                     "sys.exit(subprocess.run(json.load(sys.stdin),stdin=subprocess.DEVNULL).returncode)")
        p = subprocess.Popen([sys.executable, "-I", "-c", bootstrap],
                             cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, bufsize=0)
        require(win.AssignProcessToJobObject(job, ctypes.c_void_p(int(p._handle))), "WINDOWS_JOB_UNAVAILABLE")
        with p.stdin:
            p.stdin.write(json.dumps(argv, ensure_ascii=True).encode())
        return p, stop
    except BaseException:
        stop()
        if p is not None:
            p.kill()
            p.wait()
            for pipe in (p.stdin, p.stdout, p.stderr):
                pipe.close()
        raise


def execute(argv, cwd, env, seconds, limit):
    """Drain both streams concurrently. One shared capacity bounds captured bytes."""
    deadline = time.monotonic() + seconds
    try:
        if os.name == "nt":
            p, stop = windows_child(argv, cwd, env)
        else:
            p = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, bufsize=0, start_new_session=True)
            def stop():
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    except FileNotFoundError:
        raise Failure("ENTRY_OR_CWD_NOT_FOUND") from None
    except OSError:
        raise Failure("START_FAILED") from None
    streams = [bytearray(), bytearray()]
    lock = threading.Lock()
    overflow = threading.Event()
    def drain(pipe, destination):
        with pipe:
            while block := pipe.read(8192):
                with lock:
                    free = limit - sum(map(len, streams))
                    destination.extend(block[:free])
                    if len(block) > free:
                        overflow.set()
                        return
    threads = [threading.Thread(target=drain, args=(pipe, dest), daemon=True)
               for pipe, dest in zip((p.stdout, p.stderr), streams)]
    for thread in threads:
        thread.start()
    status = None
    try:
        while p.poll() is None:
            if overflow.is_set() or time.monotonic() >= deadline:
                status = "OUTPUT_LIMIT" if overflow.is_set() else "TIMEOUT"
                break
            overflow.wait(min(0.02, max(0, deadline - time.monotonic())))
    finally:
        stop()
        p.wait()
        for thread in threads:
            thread.join(timeout=1)
        if not status and any(t.is_alive() for t in threads):
            status = "OUTPUT_INCOMPLETE"
    if overflow.is_set():
        status = "OUTPUT_LIMIT"
    with lock:
        raw = [bytes(s) for s in streams]
    try:
        out, err = [s.decode("utf-8") for s in raw]
    except UnicodeDecodeError:
        return receipt(status or "OUTPUT_ENCODING", p.returncode)
    return receipt(status or ("OK" if p.returncode == 0 else "EXIT_NONZERO"), p.returncode, out, err)


def native(r, guest=False, deadline=None):
    if os.name == "nt":
        require(r["os"] == "windows" and windows_user().casefold() == r["user"].casefold(), "TARGET_MISMATCH")
        path = shutil.which("pwsh.exe")
        require(path is not None, "POWERSHELL_UNAVAILABLE")
        argv = [path, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", *r["argv"]]
        env = {k: os.environ[k] for k in ("SystemRoot", "WINDIR", "TEMP", "TMP") if k in os.environ}
        env["PATH"] = os.pathsep.join((str(Path(path).parent), str(Path(env["SystemRoot"], "System32"))))
        env["POWERSHELL_TELEMETRY_OPTOUT"] = "1"
    else:
        import platform
        import pwd
        require(sys.platform == "linux" and r["os"] == ("wsl" if guest else "linux"), "TARGET_MISMATCH")
        distro = os.environ.get("WSL_DISTRO_NAME") if guest else platform.freedesktop_os_release().get("ID")
        require(distro == r["distro"] and pwd.getpwuid(os.geteuid()).pw_name == r["user"], "TARGET_MISMATCH")
        env = {"PATH": os.defpath, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
        argv = r["argv"] if r["shell"] == "exec" else ["/bin/bash", "--noprofile", "--norc", "--", *r["argv"]]
    seconds = r["timeout_seconds"]
    if deadline is not None:
        seconds = min(seconds, deadline - time.time())
        require(seconds > 0, "TIMEOUT")
    return execute(argv, r["cwd"], env, seconds, r["output_limit_bytes"])


def wsl_names(command, deadline):
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=max(0.01, deadline - time.monotonic()), check=False)
        require(result.returncode == 0, "WSL_UNAVAILABLE")
        raw = result.stdout
        value = raw.decode("utf-16-le" if b"\0" in raw else "utf-8-sig").lstrip("\ufeff")
        return value.splitlines()
    except (OSError, UnicodeError):
        raise Failure("WSL_UNAVAILABLE") from None
    except subprocess.TimeoutExpired:
        raise Failure("TIMEOUT") from None


def launch_wsl(r):
    require(os.name == "nt", "TARGET_MISMATCH")
    launcher = str(Path(os.environ["SystemRoot"], "System32", "wsl.exe"))
    deadline = time.monotonic() + r["timeout_seconds"]
    require(r["distro"] in wsl_names([launcher, "--list", "--quiet"], deadline), "WSL_NOT_FOUND")
    require(r["distro"] in wsl_names([launcher, "--list", "--running", "--quiet"], deadline), "WSL_STOPPED")
    payload = base64.urlsafe_b64encode(json.dumps([r, time.time() + deadline - time.monotonic()],
                                                  ensure_ascii=False).encode()).decode("ascii")
    # Only this installed local module travels over stdin. The caller's argv and
    # target-native cwd are data, never Windows command-line quoting or Bash text.
    cmd = [launcher, "--distribution", r["distro"], "--user", r["user"], "--cd", "/",
           "--exec", "/usr/bin/python3", "-I", "-", "--guest", payload]
    try:
        launcher_env = {k: os.environ[k] for k in ("SystemRoot", "WINDIR", "TEMP", "TMP") if k in os.environ}
        result = subprocess.run(cmd, input=Path(__file__).read_bytes(), capture_output=True, env=launcher_env,
                                timeout=max(0.01, deadline - time.monotonic()) + 2, check=False)
        require(result.returncode == 0, "WSL_LAUNCH_FAILED")
        response = json.loads(result.stdout)
        fields(response, "status exit_code stdout stderr")
        return response
    except subprocess.TimeoutExpired:
        raise Failure("TIMEOUT") from None
    except (OSError, UnicodeError, ValueError):
        raise Failure("WSL_LAUNCH_FAILED") from None


def run(request):
    validate(request)
    return launch_wsl(request) if request["os"] == "wsl" else native(request)


def checked_path(path):
    """Existing roots are the owner's trusted, ACL-controlled handoff directories."""
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts, "EXCHANGE_PATH_DENIED")
    for part in (*reversed(path.parents), path):
        info = part.lstat()
        require(not stat.S_ISLNK(info.st_mode) and
                not getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT,
                "EXCHANGE_PATH_DENIED")
    return path


def exchange(projection, grant, workspace):
    """Use only the two owner-resolved paths and one exact task-scoped grant."""
    fields(grant, "direction task name kind source purpose receiver size sha256 expires_at")
    direction = grant["direction"]
    require(direction in ("in", "out") and grant["kind"] in ("sample_copy", "report", "artifact", "receipt"))
    require(all(string(grant[k]) and 0 < len(grant[k]) <= 160 for k in ("source", "purpose", "receiver")))
    require(string(grant["task"]) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", grant["task"]))
    name = grant["name"]
    require(string(name) and 0 < len(name) <= 128 and not name.startswith(".") and not name.endswith((" ", "."))
            and not re.search(r'[<>:"/\\|?*\x00-\x1f]', name), "EXCHANGE_PATH_DENIED")
    require(not re.match(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", name)
            and not re.search(r"(?i)(\.sqlite\w*|\.db|\.pem|\.key|\.pfx|\.kdbx|\.env)(-wal|-shm)?$", name),
            "EXCHANGE_PATH_DENIED")
    require(type(grant["size"]) is int and 0 <= grant["size"] <= 67108864)
    require(string(grant["sha256"]) and re.fullmatch(r"[0-9a-f]{64}", grant["sha256"]))
    require(type(grant["expires_at"]) is int and time.time() < grant["expires_at"], "EXCHANGE_EXPIRED")
    try:
        roots = projection["paths"]["exchange"]
        incoming, outgoing, work = (checked_path(p) for p in (roots["in"], roots["out"], workspace))
    except (KeyError, TypeError, OSError):
        raise Failure("EXCHANGE_PATH_DENIED") from None
    paths = [incoming, outgoing, work]
    require(all(p.is_dir() and p != p.parent for p in paths) and
            all(not a.is_relative_to(b) for i, a in enumerate(paths) for j, b in enumerate(paths) if i != j),
            "EXCHANGE_PATH_DENIED")
    slot = (incoming if direction == "in" else outgoing) / grant["task"]
    if direction == "out":
        slot.mkdir(mode=0o700, exist_ok=True)
    checked_path(slot)
    src, dst = (slot / name, work / name) if direction == "in" else (work / name, slot / name)
    checked_path(src)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0)
    def copy_checked(source, sink=None):
        with os.fdopen(os.open(source, flags), "rb") as handle:
            info = os.fstat(handle.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "EXCHANGE_PATH_DENIED")
            require(info.st_size == grant["size"], "EXCHANGE_DIGEST_MISMATCH")
            digest, count = hashlib.sha256(), 0
            while block := handle.read(65536):
                if count == 0:
                    require(not block.startswith(b"SQLite format 3\x00"), "EXCHANGE_PATH_DENIED")
                count += len(block)
                require(count <= grant["size"], "EXCHANGE_DIGEST_MISMATCH")
                digest.update(block)
                if sink:
                    sink.write(block)
            require(count == grant["size"] and digest.hexdigest() == grant["sha256"], "EXCHANGE_DIGEST_MISMATCH")
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(dir=dst.parent, delete=False) as out:
            tmp = Path(out.name)
            copy_checked(src, out)
            out.flush()
            os.fsync(out.fileno())
        require(time.time() < grant["expires_at"], "EXCHANGE_EXPIRED")
        try:
            os.link(tmp, dst)
            disposition = "COPIED"
        except FileExistsError:
            checked_path(dst)
            copy_checked(dst)
            disposition = "ALREADY_PRESENT"
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
    checked_path(dst)
    copy_checked(dst)
    if direction == "in" and dst.stat().st_mode & stat.S_IWUSR:
        dst.chmod(stat.S_IRUSR)
    return {"status": disposition, **grant, "readback_sha256": grant["sha256"], "readback_size": grant["size"]}


def load_json(path):
    with open(path, "rb") as source:
        data = source.read(65537)
    require(len(data) <= 65536)
    return json.loads(data.decode("utf-8-sig"))


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--guest":
        try:
            request, deadline = json.loads(base64.urlsafe_b64decode(sys.argv[2]))
            validate(request)
            result = native(request, guest=True, deadline=deadline)
        except Failure as error:
            result = receipt(str(error))
        print(json.dumps(result, ensure_ascii=True))
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("run").add_argument("request")
    handoff = commands.add_parser("exchange")
    for field in ("host", "grant", "workspace"):
        handoff.add_argument("--" + field, required=True)
    args = parser.parse_args()
    try:
        result = run(load_json(args.request)) if args.action == "run" else exchange(
            load_json(args.host), load_json(args.grant), args.workspace)
    except Failure as error:
        result = receipt(str(error)) if args.action == "run" else {"status": str(error)}
    except (OSError, UnicodeError, ValueError):
        result = receipt("INVALID_INPUT_OR_IO") if args.action == "run" else {"status": "INVALID_INPUT_OR_IO"}
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result["status"] in ("OK", "COPIED", "ALREADY_PRESENT") else 1


if __name__ == "__main__":
    sys.exit(main())
