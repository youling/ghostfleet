"""zipapp 载荷：确定性构建字节相等 + python3 -I 下 check-config/status 冒烟（合同 B/G）。

这些用例不联网、不依赖 cwd、不写 pyz 内部字节；构建器只读 src/ 与 tools/。
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
BUILD_SCRIPT = PACKAGE_ROOT / "tools" / "build_pyz.py"
DIST_PYZ = PACKAGE_ROOT / "dist" / "node-agent.pyz"
NODE_UID = "node-00000000-0000-4000-8000-000000000000"


def _load_build_module():
    spec = importlib.util.spec_from_file_location("ghostfleet_build_pyz", BUILD_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _run(pyz: Path, cwd: Path, *arguments: str):
    environment = {
        "HOME": str(cwd),
        "PATH": "/usr/bin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    return subprocess.run(
        [sys.executable, "-I", str(pyz), *arguments],
        capture_output=True,
        text=True,
        cwd=str(cwd),
        env=environment,
        timeout=60,
    )


def _last_json_line(text: str) -> dict:
    for line in reversed([item for item in text.splitlines() if item.strip()]):
        try:
            document = json.loads(line)
        except ValueError:
            continue
        if isinstance(document, dict):
            return document
    raise AssertionError(f"no JSON object in output: {text!r}")


def _write_agent_files(root: Path) -> Path:
    token = root / "node-token"
    token.write_text("test-token-0000000000000000000000000000\n", encoding="utf-8")
    os.chmod(token, 0o600)
    meta = root / "node.json"
    meta.write_text(json.dumps({"node_uid": NODE_UID, "platform": "linux"}), encoding="utf-8")
    os.chmod(meta, 0o600)
    state = root / "state"
    state.mkdir(mode=0o700, exist_ok=True)
    config = root / "node-agent.json"
    config.write_text(
        json.dumps(
            {
                "control_plane_origin": "https://control.example.invalid",
                "token_path": str(token),
                "node_meta_path": str(meta),
                "state_dir": str(state),
            }
        ),
        encoding="utf-8",
    )
    os.chmod(config, 0o600)
    return config


# -- 确定性构建 -------------------------------------------------------------
def test_build_is_byte_deterministic(tmp_path):
    module = _load_build_module()
    first = tmp_path / "first.pyz"
    second = tmp_path / "second.pyz"
    digest_first = module.build(str(first))
    digest_second = module.build(str(second))
    assert first.read_bytes() == second.read_bytes()
    assert digest_first == digest_second == _sha256(first)


def test_committed_dist_matches_rebuild(tmp_path):
    module = _load_build_module()
    rebuilt = tmp_path / "rebuilt.pyz"
    digest = module.build(str(rebuilt))
    assert DIST_PYZ.is_file(), (
        f"提交产物缺失：请运行 python3 {BUILD_SCRIPT} --out {DIST_PYZ}"
    )
    committed = _sha256(DIST_PYZ)
    assert committed == digest, (
        f"dist/node-agent.pyz 与源码不一致（committed {committed} != rebuild {digest}）；"
        f"请在包目录运行：python3 tools/build_pyz.py --out dist/node-agent.pyz"
    )


# -- -I 冒烟 ---------------------------------------------------------------
def test_zipapp_check_config_works_under_isolated_python(tmp_path):
    pyz = tmp_path / "node-agent.pyz"
    _load_build_module().build(str(pyz))
    config = _write_agent_files(tmp_path)

    result = _run(pyz, tmp_path, "check-config", "--config", str(config))
    assert result.returncode == 0, result.stderr
    document = _last_json_line(result.stdout)
    assert document["ok"] is True
    assert document["command"] == "check-config"
    assert document["node_uid"] == NODE_UID
    assert document["control_plane_host"] == "control.example.invalid"


def test_zipapp_status_is_machine_readable_and_offline(tmp_path):
    pyz = tmp_path / "node-agent.pyz"
    _load_build_module().build(str(pyz))
    config = _write_agent_files(tmp_path)

    result = _run(pyz, tmp_path, "status", "--json", "--config", str(config))
    assert result.returncode == 0, result.stderr
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    assert len(lines) == 1, result.stdout  # status 输出必须是纯 JSON 单行
    document = json.loads(lines[0])
    assert document["ok"] is True
    assert document["initialised"] is False
    for key in ("polls", "tasks_executed", "outbox_overflow", "outbox_depth", "seq", "boot_id"):
        assert key in document


def test_zipapp_exit_codes_for_missing_inputs(tmp_path):
    pyz = tmp_path / "node-agent.pyz"
    _load_build_module().build(str(pyz))

    missing_config = _run(pyz, tmp_path, "check-config", "--config", str(tmp_path / "absent.json"))
    assert missing_config.returncode == 3

    version = _run(pyz, tmp_path, "--version")
    assert version.returncode == 0
    assert "0.1.0.dev0" in version.stdout

    # status 在完全没有配置时也必须可读（纯本地、退出 0）。
    status = _run(pyz, tmp_path, "status", "--json")
    assert status.returncode == 0
    assert _last_json_line(status.stdout)["ok"] is True


def test_fixture_permissions_do_not_depend_on_caller_umask(tmp_path):
    for mask in (0, 0o002, 0o077):
        root = tmp_path / str(mask)
        root.mkdir(mode=0o700)
        previous = os.umask(mask)
        try:
            config = _write_agent_files(root)
        finally:
            os.umask(previous)
        assert config.stat().st_mode & 0o777 == 0o600
        assert (root / "state").stat().st_mode & 0o777 == 0o700
