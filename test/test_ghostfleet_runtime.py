import hashlib
import importlib.util
import json
import os
import platform
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


script = Path(__file__).resolve().parents[1] / "scripts" / "ghostfleet_runtime.py"
spec = importlib.util.spec_from_file_location("ghostfleet_runtime", script)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name, "有 空格")
        self.directory.mkdir()
        if os.name == "nt":
            target = dict(os="windows", distro=None, user=runtime.windows_user(), shell="powershell")
            self.entry = self.directory / "echo args.ps1"
            self.entry.write_text(
                "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n"
                "[Console]::Out.Write((ConvertTo-Json -InputObject @($args) -Compress))\n"
                "[Console]::Error.Write(([char]0x9519).ToString() + [char]13 + [char]10)\nexit 7\n", encoding="utf-8")
        else:
            import pwd
            target = dict(os="linux", distro=platform.freedesktop_os_release()["ID"],
                          user=pwd.getpwuid(os.geteuid()).pw_name, shell="exec")
            self.entry = Path(sys.executable)
        self.request = {**target, "cwd": str(self.directory), "argv": [str(self.entry)],
                        "timeout_seconds": 5, "output_limit_bytes": 4096}

    def invoke(self, args, **changes):
        return runtime.run({**self.request, "argv": [str(self.entry), *args], **changes})

    def test_literal_argv_and_two_streams(self):
        literals = ["有 空格", 'a"b', "c'd", "back\\slash", "$HOME; & *", "A\r\nB", ""]
        program = [] if os.name == "nt" else ["-c", "import json,sys;print(json.dumps(sys.argv[1:]),end='');"
                                                  "sys.stderr.buffer.write('错\\r\\n'.encode());sys.exit(7)"]
        row = self.invoke([*program, *literals])
        self.assertEqual((row["status"], row["exit_code"]), ("EXIT_NONZERO", 7))
        self.assertEqual(json.loads(row["stdout"]), literals)
        self.assertEqual(row["stderr"], "错\r\n")

    @unittest.skipIf(os.name == "nt", "Linux Bash fixed file")
    def test_bash_fixed_file_cwd_and_clean_environment(self):
        bash = self.directory / "有 空格.sh"
        bash.write_text('printf "%s" "$1"; printf "%s|%s" "$PWD" "${GHOSTFLEET_TEST_SECRET-unset}" >&2\n')
        text = '$(echo changed); "literal"\r\n'
        with mock.patch.dict(os.environ, {"GHOSTFLEET_TEST_SECRET": "must-not-cross", "BASH_ENV": "/bad"}):
            row = self.invoke([], shell="bash", argv=[str(bash), text])
        self.assertEqual(row, runtime.receipt("OK", 0, text, str(self.directory) + "|unset"))
        with self.assertRaises(runtime.Failure):
            self.invoke([], shell="bash", argv=["-c", "ignored"])

    def test_output_cap_timeout_and_encoding(self):
        if os.name == "nt":
            self.entry.write_text("[Console]::Out.Write('x' * 1024)", encoding="utf-8")
            args = []
        else:
            args = ["-c", "print('x'*1024)"]
        row = self.invoke(args, output_limit_bytes=16)
        self.assertEqual(row["status"], "OUTPUT_LIMIT")
        self.assertLessEqual(len(row["stdout"].encode()) + len(row["stderr"].encode()), 16)
        if os.name == "nt":
            self.entry.write_text("Start-Sleep -Seconds 15", encoding="utf-8")
            args = []
        else:
            args = ["-c", "import time;time.sleep(15)"]
        start = time.monotonic()
        self.assertEqual(self.invoke(args, timeout_seconds=1)["status"], "TIMEOUT")
        self.assertLess(time.monotonic() - start, 8)
        if os.name != "nt":
            self.assertEqual(self.invoke(["-c", "import sys;sys.stdout.buffer.write(b'\\xff')"])["status"], "OUTPUT_ENCODING")

    def test_bad_contract_and_target_preflight(self):
        for change in ({"argv": "echo guessed"}, {"cwd": "relative"}, {"timeout_seconds": True},
                       {"output_limit_bytes": -1}, {"extra": "ignored"}, {"shell": "guess"}):
            with self.subTest(change=change), self.assertRaises(runtime.Failure):
                runtime.run({**self.request, **change})
        with self.assertRaisesRegex(runtime.Failure, "TARGET_MISMATCH"):
            self.invoke([], user="another-synthetic-owner")

    @unittest.skipUnless(os.name == "nt", "Windows job lifetime")
    def test_finished_windows_script_does_not_leave_a_background_process(self):
        ready = self.directory / "child.pid"
        late = self.directory / "unexpected.txt"
        child = self.directory / "synthetic child.py"
        child.write_text("import os,pathlib,time\npathlib.Path('child.pid').write_text(str(os.getpid()))\n"
                         "time.sleep(2)\npathlib.Path('unexpected.txt').write_text('orphan')\n")
        self.entry.write_text(
            "$p = [Diagnostics.ProcessStartInfo]::new($args[0])\n$p.ArgumentList.Add($args[1])\n"
            "$p.UseShellExecute = $false\n$p.CreateNoWindow = $true\n"
            "$p.RedirectStandardOutput = $true\n$p.RedirectStandardError = $true\n"
            "$child = [Diagnostics.Process]::Start($p)\n"
            "while (-not (Test-Path -LiteralPath 'child.pid')) { Start-Sleep -Milliseconds 20 }\nexit 0\n")
        self.assertEqual(self.invoke([sys.executable, str(child)])["status"], "OK")
        self.assertTrue(ready.read_text().isdigit())
        time.sleep(2.1)
        self.assertFalse(late.exists())

    @unittest.skipIf(os.name == "nt", "Linux process group")
    def test_finished_linux_script_does_not_leave_a_background_process(self):
        child = self.directory / "fixture.py"
        child.write_text("import pathlib,time\npathlib.Path('ready').touch()\ntime.sleep(1)\n"
                         "pathlib.Path('unexpected').touch()\n")
        bash = self.directory / "parent.sh"
        bash.write_text('"$1" fixture.py &\nwhile [[ ! -e ready ]]; do sleep .01; done\n')
        self.assertEqual(self.invoke([], shell="bash", argv=[str(bash), sys.executable])["status"], "OK")
        time.sleep(1.1)
        self.assertFalse((self.directory / "unexpected").exists())

    @unittest.skipUnless(os.name == "nt", "Windows WSL launcher")
    def test_windows_distro_not_installed_or_stopped_does_not_launch(self):
        r = {**self.request, "os": "wsl", "shell": "exec", "cwd": "/tmp", "argv": ["/usr/bin/true"],
             "user": "fixture", "distro": "Synthetic-Test"}
        for names, category in (([[]], "WSL_NOT_FOUND"), ([["Synthetic-Test"], []], "WSL_STOPPED")):
            with mock.patch.object(runtime, "wsl_names", side_effect=names), mock.patch.object(subprocess, "run") as child:
                with self.assertRaisesRegex(runtime.Failure, category):
                    runtime.run(r)
                child.assert_not_called()

    def test_wsl_inventory_is_encoded_and_fails_closed(self):
        with mock.patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "\ufeff合成\r\n".encode("utf-16-le"), b"")):
            self.assertEqual(runtime.wsl_names([], time.monotonic() + 5), ["合成"])
        with mock.patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b"", b"")):
            with self.assertRaisesRegex(runtime.Failure, "WSL_UNAVAILABLE"):
                runtime.wsl_names([], time.monotonic() + 5)

    @unittest.skipUnless(os.name == "nt" and os.environ.get("GHOSTFLEET_TEST_WSL_DISTRO")
                         and os.environ.get("GHOSTFLEET_TEST_WSL_USER"), "opt-in running local WSL fixture")
    def test_real_wsl_bridge_roundtrip(self):
        values = ["a b", "中文", 'x"y', "a'b", r"x\y", "first\r\nnext", "", "$HOME; &"]
        r = {**self.request, "os": "wsl", "distro": os.environ["GHOSTFLEET_TEST_WSL_DISTRO"], "shell": "exec",
             "user": os.environ["GHOSTFLEET_TEST_WSL_USER"], "cwd": "/tmp", "timeout_seconds": 10,
             "argv": ["/usr/bin/python3", "-c", "import json,os,sys;print(json.dumps(sys.argv[1:]),end='');"
                      "sys.stderr.write(str(os.environ.get('GHOSTFLEET_TEST_SECRET')));sys.exit(7)", *values]}
        with mock.patch.dict(os.environ, {"GHOSTFLEET_TEST_SECRET": "do-not-inherit",
                                          "WSLENV": "GHOSTFLEET_TEST_SECRET/u"}):
            row = runtime.run(r)
        self.assertEqual((row["status"], row["exit_code"], row["stderr"]), ("EXIT_NONZERO", 7, "None"))
        self.assertEqual(json.loads(row["stdout"]), values)
        r.update(timeout_seconds=2, argv=["/usr/bin/python3", "-c", "import time;time.sleep(15)"])
        self.assertEqual(runtime.run(r)["status"], "TIMEOUT")

    def test_cli_utf8_bom_crlf_and_separate_receipt(self):
        f = self.directory / "请求.json"
        r = self.request if os.name == "nt" else {**self.request, "argv": [str(self.entry), "-c", "print('fixture')"]}
        f.write_bytes(("\ufeff" + json.dumps(r, ensure_ascii=False, indent=2).replace("\n", "\r\n")).encode())
        result = subprocess.run([sys.executable, str(script), "run", str(f)], capture_output=True, timeout=10)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(json.loads(result.stdout)["status"], "EXIT_NONZERO" if os.name == "nt" else "OK")


class ExchangeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("in/task-1", "out", "work"):
            (self.root / name).mkdir(parents=True)
        self.data = "合成\r\n".encode()
        self.grant = dict(direction="in", task="task-1", name="样本 copy.txt", kind="sample_copy", source="owner-fixture",
                          purpose="fixture", receiver="fixture-linux", size=len(self.data),
                          sha256=hashlib.sha256(self.data).hexdigest(), expires_at=int(time.time()) + 60)
        self.projection = {"paths": {"exchange": {k: str(self.root / k) for k in ("in", "out")}}}
        self.source = self.root / "in/task-1" / self.grant["name"]
        self.source.write_bytes(self.data)

    def copy(self, **change):
        return runtime.exchange(self.projection, {**self.grant, **change}, self.root / "work")

    def test_scoped_exchange_integrity_idempotency_and_received_bytes(self):
        self.assertEqual(self.copy()["status"], "COPIED")
        self.assertEqual(self.copy()["status"], "ALREADY_PRESENT")
        self.assertEqual(self.source.read_bytes(), self.data)
        self.assertFalse((self.root / "work" / self.grant["name"]).stat().st_mode & 0o200)
        self.assertEqual(self.copy(direction="out", kind="artifact")["status"], "COPIED")
        self.assertEqual((self.root / "out/task-1" / self.grant["name"]).read_bytes(), self.data)

    @unittest.skipUnless(os.name == "nt" and os.environ.get("GHOSTFLEET_TEST_WSL_DISTRO")
                         and os.environ.get("GHOSTFLEET_TEST_WSL_USER"), "opt-in Windows to WSL path readback")
    def test_wsl_receiver_reads_exact_windows_exchange_file(self):
        self.copy()
        exported = self.copy(direction="out", kind="report")
        native_path = str(self.root / "out/task-1" / self.grant["name"])
        r = {"os": "wsl", "shell": "exec", "distro": os.environ["GHOSTFLEET_TEST_WSL_DISTRO"],
             "user": os.environ["GHOSTFLEET_TEST_WSL_USER"], "cwd": "/tmp", "timeout_seconds": 10,
             "output_limit_bytes": 4096, "argv": ["/usr/bin/wslpath", "-u", native_path]}
        translated = runtime.run(r)
        self.assertEqual(translated["status"], "OK")
        path = translated["stdout"].removesuffix("\n")
        r["argv"] = ["/usr/bin/python3", "-c", "import hashlib,pathlib,sys;"
                     "print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())", path]
        checked = runtime.run(r)
        self.assertEqual(checked["status"], "OK")
        self.assertEqual(checked["stdout"].strip(), exported["readback_sha256"])

    def test_refuses_overwrite_mismatch_unsafe_paths_and_expired_grants(self):
        for change in ({"sha256": "a"*64}, {"size": 1}, {"name": "../outside"}, {"name": "folder/file"},
                       {"name": "state.db"}, {"name": "NUL.txt"}, {"task": ".."}, {"kind": "credentials"},
                       {"expires_at": 0}):
            with self.subTest(change=change), self.assertRaises(runtime.Failure):
                self.copy(**change)
        self.assertFalse(list((self.root / "work").iterdir()))
        target = self.root / "work" / self.grant["name"]
        target.write_bytes(b"existing")
        with self.assertRaises(runtime.Failure):
            self.copy()
        self.assertEqual(target.read_bytes(), b"existing")
        with self.assertRaisesRegex(runtime.Failure, "EXCHANGE_PATH_DENIED"):
            runtime.exchange(self.projection, self.grant, self.root / "out")

    @unittest.skipIf(os.name == "nt", "Linux link fixtures")
    def test_link_and_database_body_cannot_enter_exchange(self):
        path = self.root / "in/task-1/another.txt"
        path.symlink_to(self.source)
        with self.assertRaisesRegex(runtime.Failure, "EXCHANGE_PATH_DENIED"):
            self.copy(name=path.name)
        path.unlink()
        os.link(self.source, path)
        with self.assertRaisesRegex(runtime.Failure, "EXCHANGE_PATH_DENIED"):
            self.copy(name=path.name)
        path.unlink()
        data = b"SQLite format 3\0" + b"x" * 64
        self.source.write_bytes(data)
        with self.assertRaisesRegex(runtime.Failure, "EXCHANGE_PATH_DENIED"):
            self.copy(size=len(data), sha256=hashlib.sha256(data).hexdigest())


if __name__ == "__main__":
    unittest.main()
