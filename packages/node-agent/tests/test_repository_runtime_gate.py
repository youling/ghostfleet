"""Non-production regression of DB ownership and shipped entrypoint routing."""
import os
import subprocess
import sys
from pathlib import Path
import pytest
from ghostfleet_agent.repository import TaskRepository, RepositoryError, read_status, digest
from ghostfleet_agent.protocol import make_result

NODE = "node-synthetic"


def test_second_daemon_refused_without_modifying_rows(tmp_path):
    r = TaskRepository(tmp_path / "tasks.db", NODE)
    try:
        r.begin("task-owned", "node.observe")
        old = r.path.read_bytes()
        with pytest.raises(RepositoryError, match="ALREADY_OWNED"):
            TaskRepository(r.path, NODE)
        assert r.path.read_bytes() == old
        assert r.get("task-owned")["execution_state"] == "MAY_HAVE_EXECUTED"
    finally:
        r.close()
    reopened = TaskRepository(tmp_path / "tasks.db", NODE)
    reopened.close()


def test_os_lock_released_after_process_death(tmp_path):
    source = str(Path(__file__).resolve().parents[1] / "src")
    child = "from ghostfleet_agent.repository import TaskRepository; import sys,time; r=TaskRepository(sys.argv[1],sys.argv[2]); print('READY',flush=True); time.sleep(30)"
    proc = subprocess.Popen([sys.executable, "-c", child, str(tmp_path / "tasks.db"), NODE],
        env={**os.environ, "PYTHONPATH":source}, stdout=subprocess.PIPE, text=True)
    try:
        assert proc.stdout.readline().strip() == "READY"
        with pytest.raises(RepositoryError, match="ALREADY_OWNED"):
            TaskRepository(tmp_path / "tasks.db", NODE)
        proc.kill(); proc.wait(timeout=5)
        r=TaskRepository(tmp_path / "tasks.db", NODE); r.close()
    finally:
        if proc.poll() is None: proc.kill(); proc.wait(timeout=5)
        proc.stdout.close()


def test_status_is_read_only_and_preserves_quarantine_evidence(tmp_path):
    r=TaskRepository(tmp_path / "tasks.db", NODE)
    try:
        r.begin("task-held", "node.observe")
        result=make_result(task_id="task-held", node_uid=NODE, operation="node.observe", status="SUCCEEDED")
        r.complete(result); r.quarantine("task-held", "node_uid_changed")
        before=r.path.read_bytes(); names=sorted(p.name for p in tmp_path.iterdir())
        report=read_status(r.path, NODE)
        assert report["outbox_depth"] == 0
        assert report["task_counts"] == {"QUARANTINED":1}
        assert report["quarantined"][0]["has_body"] == 1
        assert report["quarantined"][0]["original_node_uid"] == NODE
        assert report["quarantined"][0]["result_digest"] == digest(result)
        assert r.path.read_bytes() == before
        assert sorted(p.name for p in tmp_path.iterdir()) == names
    finally: r.close()


def test_cli_factory_is_sqlite_only(tmp_path, control_plane):
    from agent_test_support import AgentSandbox, TEST_TOKEN
    from ghostfleet_agent.cli import build_loop, status_report
    from ghostfleet_agent.config import load_config
    box=AgentSandbox(tmp_path / "agent")
    conf=load_config(str(box.write_config(control_plane.url)))
    loop=build_loop(conf, TEST_TOKEN, box.node_uid)
    try:
        assert isinstance(loop.repository, TaskRepository)
        assert status_report(conf)["task_store"] == "sqlite/v1"
        for name in ("ledger.json","outbox.json","tombstones.json","archive","tasks"):
            assert not (box.state_dir / name).exists()
    finally: loop.repository.close()
