"""trust：host-root 归属判据（user namespace aware，ADR §9）。

八条臂全部用注入的 /proc 视图构造，不依赖测试机真实 uid_map/挂载：
- uid 0 已映射：只认 st_uid == 0；
- uid 0 未映射（systemd 硬化沙箱常态）：只认 overflow uid + 只读挂载 + 当前用户不可写。
任何解析失败都 fail closed。
"""
from __future__ import annotations

import os
import stat

import pytest

from ghostfleet_agent import trust

READONLY_ROOT = "36 1 8:1 / / ro,relatime - ext4 /dev/root rw\n"
WRITABLE_ROOT = "36 1 8:1 / / rw,relatime - ext4 /dev/root rw\n"
SELF_ONLY_UID_MAP = "       1002       1002          1\n"
ROOT_MAPPED_UID_MAP = "          0          0 4294967295\n"


def fake_stat(uid: int, mode: int = 0o644) -> os.stat_result:
    return os.stat_result((stat.S_IFREG | mode, 1, 1, 1, uid, uid, 0, 0, 0, 0))


def write_proc(directory, *, uid_map=SELF_ONLY_UID_MAP, mountinfo=READONLY_ROOT, overflowuid="65534\n"):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "uid_map").write_text(uid_map, encoding="ascii")
    (directory / "mountinfo").write_text(mountinfo, encoding="ascii")
    (directory / "overflowuid").write_text(overflowuid, encoding="ascii")
    return directory


def probe(directory, path="/etc/ghostfleet/node-agent.json", *, uid=65534, access_check=lambda path: False):
    return trust.host_root_owned(
        path,
        fake_stat(uid),
        uid_map_path=str(directory / "uid_map"),
        mountinfo_path=str(directory / "mountinfo"),
        overflowuid_path=str(directory / "overflowuid"),
        access_check=access_check,
    )


# -- 判据矩阵 ---------------------------------------------------------------
def test_root_mapped_accepts_only_uid_zero(tmp_path):
    proc = write_proc(tmp_path / "proc", uid_map=ROOT_MAPPED_UID_MAP)
    assert probe(proc, uid=0) == (True, trust.REASON_ROOT_MAPPED)


def test_root_mapped_rejects_overflow_uid(tmp_path):
    proc = write_proc(tmp_path / "proc", uid_map=ROOT_MAPPED_UID_MAP)
    trusted, reason = probe(proc, uid=65534)
    assert trusted is False
    assert reason == trust.REASON_UID_MISMATCH


def test_overflow_uid_on_readonly_mount_is_accepted(tmp_path):
    proc = write_proc(tmp_path / "proc")
    assert probe(proc) == (True, trust.REASON_OVERFLOW_ON_READONLY_MOUNT)


def test_overflow_uid_on_writable_mount_is_rejected(tmp_path):
    proc = write_proc(tmp_path / "proc", mountinfo=WRITABLE_ROOT)
    trusted, reason = probe(proc)
    assert trusted is False
    assert reason == trust.REASON_MOUNT_NOT_READONLY


def test_overflow_uid_that_user_can_write_is_rejected(tmp_path):
    proc = write_proc(tmp_path / "proc")
    trusted, reason = probe(proc, access_check=lambda path: True)
    assert trusted is False
    assert reason == trust.REASON_WRITABLE_BY_USER


def test_unmapped_namespace_rejects_other_uids(tmp_path):
    proc = write_proc(tmp_path / "proc")
    trusted, reason = probe(proc, uid=1002)
    assert trusted is False
    assert reason == trust.REASON_UID_MISMATCH


def test_unreadable_mountinfo_fails_closed(tmp_path):
    proc = write_proc(tmp_path / "proc")
    (proc / "mountinfo").unlink()
    trusted, reason = probe(proc)
    assert trusted is False
    assert reason == trust.REASON_MOUNT_NOT_READONLY


def test_unreadable_uid_map_only_accepts_uid_zero(tmp_path):
    proc = write_proc(tmp_path / "proc")
    (proc / "uid_map").unlink()
    assert probe(proc, uid=0) == (True, trust.REASON_ROOT_MAPPED)
    assert probe(proc, uid=65534) == (False, trust.REASON_UID_MISMATCH)


def test_unreadable_overflowuid_falls_back_to_kernel_default(tmp_path):
    proc = write_proc(tmp_path / "proc")
    (proc / "overflowuid").unlink()
    assert trust.overflowuid(overflowuid_path=str(proc / "overflowuid")) == 65534
    assert probe(proc) == (True, trust.REASON_OVERFLOW_ON_READONLY_MOUNT)


def test_malformed_uid_map_is_treated_as_mapped(tmp_path):
    proc = write_proc(tmp_path / "proc", uid_map="not-a-map\n")
    assert probe(proc, uid=0) == (True, trust.REASON_ROOT_MAPPED)
    assert probe(proc, uid=65534) == (False, trust.REASON_UID_MISMATCH)


# -- 挂载最长前缀匹配 -------------------------------------------------------
def test_longest_prefix_mount_wins(tmp_path):
    proc = write_proc(
        tmp_path / "proc",
        mountinfo=(
            "36 1 8:1 / / ro,relatime - ext4 /dev/root rw\n"
            "37 36 8:2 / /etc rw,relatime - ext4 /dev/root rw\n"
            "38 37 8:3 / /etc/ghostfleet ro,relatime - ext4 /dev/root rw\n"
        ),
    )
    assert trust.path_on_readonly_mount("/etc/ghostfleet/node-agent.json", mountinfo_path=str(proc / "mountinfo"))
    assert not trust.path_on_readonly_mount("/etc/hostname", mountinfo_path=str(proc / "mountinfo"))
    assert trust.path_on_readonly_mount("/var/lib/x", mountinfo_path=str(proc / "mountinfo"))


def test_mount_point_itself_is_covered(tmp_path):
    proc = write_proc(tmp_path / "proc")
    assert trust.path_on_readonly_mount("/", mountinfo_path=str(proc / "mountinfo"))
    assert trust.path_on_readonly_mount("/etc", mountinfo_path=str(proc / "mountinfo"))


def test_unknown_path_without_any_mount_is_not_readonly(tmp_path):
    proc = write_proc(tmp_path / "proc", mountinfo="36 1 8:1 / /tmp ro,relatime - ext4 /dev/root rw\n")
    assert not trust.path_on_readonly_mount("/etc/ghostfleet/node-agent.json", mountinfo_path=str(proc / "mountinfo"))


def test_uid_map_detects_root_mapping_and_self_only_mapping(tmp_path):
    mapped = write_proc(tmp_path / "mapped", uid_map=ROOT_MAPPED_UID_MAP)
    self_only = write_proc(tmp_path / "self", uid_map=SELF_ONLY_UID_MAP)
    assert trust.uid_zero_mapped(uid_map_path=str(mapped / "uid_map")) is True
    assert trust.uid_zero_mapped(uid_map_path=str(self_only / "uid_map")) is False


def test_either_uid_map_column_naming_zero_counts_as_mapped(tmp_path):
    inside_zero = write_proc(tmp_path / "inside", uid_map="          0       1002          1\n")
    outside_zero = write_proc(tmp_path / "outside", uid_map="       1002          0          1\n")
    assert trust.uid_zero_mapped(uid_map_path=str(inside_zero / "uid_map")) is True
    assert trust.uid_zero_mapped(uid_map_path=str(outside_zero / "uid_map")) is True
    # 已映射 → 只认 st_uid == 0，overflow 一律不可信。
    assert probe(inside_zero, uid=0)[0] is True
    assert probe(outside_zero, uid=0)[0] is True


def test_zero_length_mapping_does_not_count(tmp_path):
    proc = write_proc(tmp_path / "proc", uid_map="          0          0          0\n")
    assert trust.uid_zero_mapped(uid_map_path=str(proc / "uid_map")) is False
