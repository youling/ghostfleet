"""trust：host-root 归属判据（反查 uid_map，user namespace aware，ADR §9）。

判据把观测到的 st_uid 用 uid_map 的 inside/outside/length 换回 host uid：
换回 0 → 可信；换回非 0 → 不可信；未被映射覆盖（典型是 overflow uid）才走
「只读挂载 + 不可写」分支。任何解析失败都 fail closed 到 overflow 分支。

所有 /proc 视图都由测试注入，不依赖测试机真实 uid_map / 挂载。
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


# -- 反查映射：正向与负向 ---------------------------------------------------
def test_inside_zero_mapping_to_host_user_does_not_prove_root(tmp_path):
    """0 1002 1：ns 内 uid 0 其实是 host 1002 —— 托管账户自己的文件。"""
    proc = write_proc(tmp_path / "proc", uid_map="          0       1002          1\n")
    trusted, reason = probe(proc, uid=0)
    assert trusted is False
    assert reason == trust.REASON_UID_MISMATCH


def test_identity_mapping_of_root_is_trusted_without_readonly_mount(tmp_path):
    proc = write_proc(tmp_path / "proc", uid_map="          0          0          1\n", mountinfo=WRITABLE_ROOT)
    assert probe(proc, uid=0) == (True, trust.REASON_ROOT_MAPPED)


def test_mapped_self_uid_that_is_host_root_is_trusted(tmp_path):
    """1002 0 1：ns 内 uid 1002 反查 host 0。"""
    proc = write_proc(tmp_path / "proc", uid_map="       1002          0          1\n", mountinfo=WRITABLE_ROOT)
    assert probe(proc, uid=1002) == (True, trust.REASON_ROOT_MAPPED)


def test_multi_line_uid_map_reverse_lookup(tmp_path):
    proc = write_proc(
        tmp_path / "proc",
        uid_map=(
            "         65534          0          1\n"
            "       1002       1002          1\n"
        ),
        mountinfo=WRITABLE_ROOT,
    )
    assert probe(proc, uid=65534) == (True, trust.REASON_ROOT_MAPPED)


def test_mapped_range_off_by_one_lands_outside_root(tmp_path):
    """0 1002 2 覆盖 ns uid 0..1；st_uid 1 → host 1003。"""
    proc = write_proc(tmp_path / "proc", uid_map="          0       1002          2\n")
    trusted, reason = probe(proc, uid=1)
    assert trusted is False
    assert reason == trust.REASON_UID_MISMATCH


def test_mapped_uid_is_never_judged_as_overflow(tmp_path):
    """1002 1002 1 + st_uid 1002：自身 UID 被映射到 host 1002。"""
    proc = write_proc(tmp_path / "proc", uid_map=SELF_ONLY_UID_MAP)
    trusted, reason = probe(proc, uid=1002)
    assert trusted is False
    assert reason == trust.REASON_UID_MISMATCH


def test_zero_length_mapping_does_not_cover_uid(tmp_path):
    proc = write_proc(tmp_path / "proc", uid_map="       1002       1002          0\n")
    assert trust.map_to_host_uid(1002, uid_map_path=str(proc / "uid_map")) is None
    trusted, reason = probe(proc, uid=1002)
    assert trusted is False
    assert reason == trust.REASON_UID_MISMATCH


# -- overflow 分支：只读挂载 + 不可写 ---------------------------------------
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


def test_overflow_uid_on_readonly_mount_is_accepted(tmp_path):
    proc = write_proc(tmp_path / "proc")
    assert probe(proc) == (True, trust.REASON_OVERFLOW_ON_READONLY_MOUNT)


def test_unmapped_uid_other_than_overflow_is_rejected(tmp_path):
    proc = write_proc(tmp_path / "proc")
    trusted, reason = probe(proc, uid=4321)
    assert trusted is False
    assert reason == trust.REASON_UID_MISMATCH


# -- 解析失败 fail closed 到 overflow 分支 ----------------------------------
def test_unreadable_uid_map_falls_back_to_overflow_branch(tmp_path):
    proc = write_proc(tmp_path / "proc")
    (proc / "uid_map").unlink()
    # uid 0 未被映射 → 只能靠 overflow 分支，因此不可信。
    assert probe(proc, uid=0) == (False, trust.REASON_UID_MISMATCH)
    assert probe(proc) == (True, trust.REASON_OVERFLOW_ON_READONLY_MOUNT)


def test_malformed_uid_map_falls_back_to_overflow_branch(tmp_path):
    proc = write_proc(tmp_path / "proc", uid_map="not-a-map\n")
    assert probe(proc, uid=0) == (False, trust.REASON_UID_MISMATCH)
    assert probe(proc) == (True, trust.REASON_OVERFLOW_ON_READONLY_MOUNT)


def test_uid_map_with_wrong_column_count_is_ignored(tmp_path):
    proc = write_proc(tmp_path / "proc", uid_map="          0          0\n")
    assert trust.map_to_host_uid(0, uid_map_path=str(proc / "uid_map")) is None
    assert probe(proc) == (True, trust.REASON_OVERFLOW_ON_READONLY_MOUNT)


def test_uid_map_range_overflow_is_rejected(tmp_path):
    proc = write_proc(tmp_path / "proc", uid_map="          0          0 99999999999\n")
    assert trust.map_to_host_uid(0, uid_map_path=str(proc / "uid_map")) is None


def test_unreadable_overflowuid_falls_back_to_kernel_default(tmp_path):
    proc = write_proc(tmp_path / "proc")
    (proc / "overflowuid").unlink()
    assert trust.overflowuid(overflowuid_path=str(proc / "overflowuid")) == 65534
    assert probe(proc) == (True, trust.REASON_OVERFLOW_ON_READONLY_MOUNT)


# -- map_to_host_uid 直接契约 ----------------------------------------------
def test_map_to_host_uid_translates_ranges(tmp_path):
    proc = write_proc(
        tmp_path / "proc",
        uid_map=(
            "          0       1002          1\n"
            "       1002       5000          3\n"
        ),
    )
    path = str(proc / "uid_map")
    assert trust.map_to_host_uid(0, uid_map_path=path) == 1002
    assert trust.map_to_host_uid(1002, uid_map_path=path) == 5000
    assert trust.map_to_host_uid(1004, uid_map_path=path) == 5002
    assert trust.map_to_host_uid(1005, uid_map_path=path) is None
    assert trust.map_to_host_uid(-1, uid_map_path=path) is None
    assert trust.map_to_host_uid(2 ** 32, uid_map_path=path) is None


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


def test_unreadable_mountinfo_fails_closed(tmp_path):
    proc = write_proc(tmp_path / "proc")
    (proc / "mountinfo").unlink()
    trusted, reason = probe(proc)
    assert trusted is False
    assert reason == trust.REASON_MOUNT_NOT_READONLY


def test_large_mountinfo_is_accepted_up_to_one_mib(tmp_path):
    line_count = 12000
    filler = "".join(
        f"{index} 1 8:{index} / /srv/mount{index} ro,relatime - ext4 /dev/root rw\n"
        for index in range(line_count)
    )
    proc = write_proc(tmp_path / "proc", mountinfo=filler)
    assert 256 * 1024 < len(filler.encode("ascii")) <= 1024 * 1024
    assert trust.path_on_readonly_mount(
        f"/srv/mount{line_count - 1}", mountinfo_path=str(proc / "mountinfo")
    )


def test_mountinfo_beyond_one_mib_fails_closed(tmp_path):
    filler = "".join(
        f"{index} 1 8:{index} / /srv/mount{index} ro,relatime - ext4 /dev/root rw\n"
        for index in range(20000)
    )
    assert len(filler.encode("ascii")) > 1024 * 1024
    proc = write_proc(tmp_path / "proc", mountinfo=filler)
    assert not trust.path_on_readonly_mount("/srv/mount19999", mountinfo_path=str(proc / "mountinfo"))
