"""测试支撑：本地假控制面、沙箱配置、任务信封工厂。

约束：不访问外网、不使用真实主机名/IP/令牌，全部在 127.0.0.1 随机端口内闭环。
"""
from __future__ import annotations

import http.server
import json
import os
import threading
import uuid
from datetime import timedelta
from pathlib import Path

from ghostfleet_agent import protocol

TEST_AGENT_VERSION = "0.1.0.dev0"
TEST_TOKEN = "test-token-0000000000000000000000000000"


def make_node_uid() -> str:
    return "node-" + str(uuid.uuid4())


def unprivileged_owner(path, *, uid: int = 4242, gid: int = 4242):
    """让「文件不属于运行者」在 root 与非 root 两种环境下都成立。

    信任闸门的负向臂需要 st_uid != 0（uid 0 已映射的场景）。以 root 跑测试时夹具文件
    天然是 root 拥有，会把负向臂变成假绿；这里在 euid==0 时把属主改成 4242（一个必然
    不是 root 的普通 uid），非 root 运行时文件本来就属于当前用户、无需改动。
    只改属主不改 mode，断言语义与运行者身份无关。
    """
    if os.geteuid() == 0:
        os.chown(path, uid, gid)
    return path


class _Handler(http.server.BaseHTTPRequestHandler):
    server_version = "FakeControlPlane/0"
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args) -> None:  # 静音测试输出
        pass

    def _read_body(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(min(length, 1 << 20)) if length > 0 else b""
        try:
            return raw, json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, ValueError):
            return raw, None

    def do_POST(self) -> None:
        raw, body = self._read_body()
        record = {
            "method": "POST",
            "path": self.path,
            # HTTP 头名大小写不敏感；urllib 会重新 capitalize，统一小写便于断言。
            "headers": {name.lower(): value for name, value in self.headers.items()},
            "raw": raw,
            "body": body,
        }
        plane = self.server.plane
        plane.records.append(record)
        if plane.respond is not None:
            status, payload = plane.respond(record)
        else:
            status, payload = plane.default_respond(record)
        encoded = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        for name, value in (plane.respond_headers or {}).items():
            self.send_header(name, value)
        if payload is not None:
            self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class FakeControlPlane:
    """本地假控制面：记录请求、按回调返回响应、收集结果回传。"""

    def __init__(self) -> None:
        self.records: list[dict] = []
        self.results: list[dict] = []
        self.heartbeat_tasks: list[dict] = []
        self.poll_tasks: list[dict] = []
        self.heartbeat_interval_s: float = 15.0
        self.respond = None
        self.respond_headers: dict | None = None
        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._httpd.daemon_threads = True
        self._httpd.plane = self
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="fake-control-plane", daemon=True)

    # -- 生命周期 -----------------------------------------------------------
    def start(self) -> "FakeControlPlane":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)

    def __enter__(self) -> "FakeControlPlane":
        return self.start()

    def __exit__(self, *_exc) -> None:
        self.stop()

    # -- 地址 ---------------------------------------------------------------
    @property
    def port(self) -> int:
        return self._httpd.server_address[1]

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    # -- 默认协议 -----------------------------------------------------------
    def default_respond(self, record: dict):
        path = record["path"]
        if path.endswith("/heartbeat"):
            return 200, {"interval_s": self.heartbeat_interval_s, "tasks": list(self.heartbeat_tasks)}
        if path.endswith("/tasks/poll"):
            return 200, {"tasks": list(self.poll_tasks)}
        if path.endswith("/result"):
            body = record["body"] or {}
            self.results.append(body)
            return 200, {"status": "accepted", "task_id": body.get("task_id")}
        return 404, {"code": "NOT_FOUND"}

    # -- 查询 ---------------------------------------------------------------
    def requests_to(self, suffix: str) -> list[dict]:
        return [record for record in self.records if record["path"].endswith(suffix)]


class AgentSandbox:
    """临时目录里的 token/node.json/config.json；全部为绝对路径。"""

    def __init__(self, root, *, node_uid: str | None = None) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_dir = self.root / "state"
        self.token_path = self.root / "token"
        self.node_meta_path = self.root / "node.json"
        self.config_path = self.root / "node-agent.json"
        self.node_uid = node_uid or make_node_uid()
        self.token_path.write_text(TEST_TOKEN + "\n", encoding="utf-8")
        self.token_path.chmod(0o600)
        self.node_meta_path.write_text(json.dumps({"node_uid": self.node_uid, "platform": "linux"}), encoding="utf-8")
        self.node_meta_path.chmod(0o600)

    def config_document(self, base_url: str, **overrides) -> dict:
        document = {
            "control_plane_url": base_url,
            "token_path": str(self.token_path),
            "node_meta_path": str(self.node_meta_path),
            "state_dir": str(self.state_dir),
            "agent_version": TEST_AGENT_VERSION,
            "interval_s": 15.0,
            "jitter_ratio": 0.0,
            "request_timeout_s": 5.0,
            "allowed_units": [],
        }
        document.update(overrides)
        return document

    def write_config(self, base_url: str, **overrides) -> Path:
        self.config_path.write_text(json.dumps(self.config_document(base_url, **overrides)), encoding="utf-8")
        self.config_path.chmod(0o644)
        return self.config_path

    def write_raw_config(self, text: str) -> Path:
        self.config_path.write_text(text, encoding="utf-8")
        self.config_path.chmod(0o644)
        return self.config_path

    def state_paths(self) -> dict:
        return {
            "state": self.state_dir / "state.json",
            "ledger": self.state_dir / "ledger.json",
            "outbox": self.state_dir / "outbox.json",
        }


def make_task(
    *,
    node_uid: str,
    task_id: str = "task-0001",
    operation: str = "node.observe",
    params=None,
    attempt: int = 1,
    issued_at: str | None = None,
    expires_at: str | None = None,
    schema: str = protocol.SCHEMA_TASK,
    include_schema: bool = True,
) -> dict:
    now = protocol.now_utc()
    envelope = {
        "task_id": task_id,
        "node_uid": node_uid,
        "operation": operation,
        "params": {} if params is None else params,
        "issued_at": issued_at or protocol.format_timestamp(now),
        "expires_at": expires_at or protocol.format_timestamp(now + timedelta(seconds=300)),
        "attempt": attempt,
    }
    if include_schema:
        envelope["schema"] = schema
    return envelope
