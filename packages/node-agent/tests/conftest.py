"""pytest 夹具：所有测试都在进程内本地闭环，不依赖网络与真实主机事实。"""
from __future__ import annotations

import pytest

from agent_test_support import FakeControlPlane


@pytest.fixture()
def control_plane():
    plane = FakeControlPlane()
    plane.start()
    try:
        yield plane
    finally:
        plane.stop()
