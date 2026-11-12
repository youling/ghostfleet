"""pytest 夹具：所有测试都在进程内本地闭环，不依赖网络与真实主机事实。"""
from __future__ import annotations

import pytest

from agent_test_support import FakeControlPlane


@pytest.fixture(autouse=True)
def allow_loopback_http(monkeypatch):
    """测试/验收专用的 loopback http 例外；生产配置默认拒绝（P2-8）。"""
    monkeypatch.setenv("GHOSTFLEET_AGENT_TEST_LOOPBACK_HTTP", "1")


@pytest.fixture()
def control_plane():
    plane = FakeControlPlane()
    plane.start()
    try:
        yield plane
    finally:
        plane.stop()
