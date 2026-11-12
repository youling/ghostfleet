"""host-root 归属判据（user-namespace aware，反查映射）。

ADR §9 的信任判据：默认路径（/etc/ghostfleet/node-agent.json、
/etc/ghostfleet/capability-status.json）的文件必须「host root 拥有」。但在
systemd user manager 的 mount 类硬化（PrivateTmp/ProtectSystem/ProtectHome/
ReadOnlyPaths 等隐式开启 PrivateUsers=）沙箱里，进程只映射了自身的 UID，
host root 拥有的文件在沙箱内显示为 overflow uid（默认 65534），所以
「st_uid == 0」不可靠。

正确做法是**反查映射**：把观测到的 st_uid 用 /proc/self/uid_map 的
inside / outside / length 三元组换回 host uid。

  (a) st_uid 被某行覆盖（inside <= st_uid < inside + length，且 length > 0）：
      host_uid = outside + (st_uid - inside)，可信当且仅当 host_uid == 0。
  (b) st_uid 未被任何行覆盖（未映射，典型是 overflow uid）：要求
      st_uid == overflowuid，且该路径在 /proc/self/mountinfo 最长前缀匹配的
      挂载带 ro 选项，且当前进程写不了该文件。

为什么不能只看「uid 0 是否出现在 uid_map 里」：嵌套命名空间 0 1002 1
（inside 0 ↔ host 1002）下，托管账户自己拥有的文件在 ns 内就显示为 uid 0，
那会把「用户自己的文件」误判成 host root 拥有。反查 host uid 后得到 1002，
判据直接拒绝。

(b) 不是放宽：只映射自身 UID 的 namespace 里，「host root 拥有」与「host
65534 拥有」在 uid 上无法区分；唯一可用的内核级等价不变量是「该路径所在
挂载只读 + 当前用户写不了」。unit 里的 RestrictNamespaces=yes 阻止服务自造
可写挂载视图，因此这个判据真正保证的是：「托管账户改不了这个文件」。

解析失败（uid_map 不可读、行格式错、数字溢出）一律 fail closed：只走 (b)，
即只有 overflow uid + 只读挂载 + 不可写才可信。本模块零依赖、只读 /proc
与文件元数据。
"""
from __future__ import annotations

import os
import re

# 可在测试中注入的 proc 路径（运行期读取模块常量，避免默认参数绑定）。
UID_MAP_PATH = "/proc/self/uid_map"
MOUNTINFO_PATH = "/proc/self/mountinfo"
OVERFLOWUID_PATH = "/proc/sys/kernel/overflowuid"

DEFAULT_OVERFLOWUID = 65534
MAX_UID_MAP_BYTES = 64 * 1024
# 真实机器的 mountinfo 可以很大（容器/快照挂载很多），给到 1 MiB。
MAX_MOUNTINFO_BYTES = 1024 * 1024
UID_SPACE = 2 ** 32

REASON_ROOT_MAPPED = "ROOT_MAPPED"
REASON_OVERFLOW_ON_READONLY_MOUNT = "OVERFLOW_ON_READONLY_MOUNT"
REASON_UID_MISMATCH = "UID_MISMATCH"
REASON_MOUNT_NOT_READONLY = "MOUNT_NOT_READONLY"
REASON_WRITABLE_BY_USER = "WRITABLE_BY_USER"

_ESCAPE_RE = re.compile(r"\\([0-7]{3})")


def _read_bounded(path: str, limit: int) -> str:
    """读一个 /proc 文本文件；超限按读取失败处理（fail closed）。"""
    with open(path, "rb") as handle:
        raw = handle.read(limit + 1)
    if len(raw) > limit:
        raise OSError("proc-file-too-large")
    return raw.decode("utf-8", "replace")


def _parse_uid_map(text: str) -> list[tuple[int, int, int]] | None:
    """解析 uid_map 行为 (inside, outside, length)。

    任何格式问题（列数不对、非十进制、负数、越界、区间溢出）都返回 None，
    调用方据此 fail closed 到 overflow 分支。
    """
    entries: list[tuple[int, int, int]] = []
    for line in text.splitlines():
        fields = line.split()
        if not fields:
            continue
        if len(fields) != 3:
            return None
        try:
            inside, outside, length = (int(field, 10) for field in fields)
        except ValueError:
            return None
        for value in (inside, outside, length):
            if value < 0 or value >= UID_SPACE:
                return None
        if inside + length > UID_SPACE or outside + length > UID_SPACE:
            return None
        entries.append((inside, outside, length))
    if not entries:
        return None
    return entries


def map_to_host_uid(uid: int, *, uid_map_path: str | None = None) -> int | None:
    """把 namespace 内观测到的 uid 反查成 host uid。

    返回 None 表示「未被任何映射行覆盖」或「uid_map 不可读/不可解析」；
    两种情况都交由 overflow 分支判断（fail closed）。
    """
    if not isinstance(uid, int) or isinstance(uid, bool) or uid < 0 or uid >= UID_SPACE:
        return None
    target = UID_MAP_PATH if uid_map_path is None else uid_map_path
    try:
        text = _read_bounded(target, MAX_UID_MAP_BYTES)
    except (OSError, ValueError):
        return None
    entries = _parse_uid_map(text)
    if entries is None:
        return None
    for inside, outside, length in entries:
        if length > 0 and inside <= uid < inside + length:
            return outside + (uid - inside)
    return None


def overflowuid(*, overflowuid_path: str | None = None) -> int:
    """沙箱内「未映射 UID」的占位值；读不到时用内核默认 65534。"""
    target = OVERFLOWUID_PATH if overflowuid_path is None else overflowuid_path
    try:
        text = _read_bounded(target, 64).strip()
        value = int(text)
    except (OSError, ValueError):
        return DEFAULT_OVERFLOWUID
    if value < 0 or value >= UID_SPACE - 1:
        return DEFAULT_OVERFLOWUID
    return value


def _unescape_mountinfo(value: str) -> str:
    """mountinfo 用八进制转义表示空格等字符（\\040 等）。"""
    def _replace(match: re.Match) -> str:
        try:
            return chr(int(match.group(1), 8))
        except ValueError:  # pragma: no cover - 正则已限定 0-7
            return match.group(0)

    return _ESCAPE_RE.sub(_replace, value)


def _remember(root: str, candidate: str) -> bool:
    """最长前缀匹配：path 是否落在 mount_point 之下（挂载点自身也算）。"""
    if candidate == "/":
        return root.startswith("/")
    if root == candidate:
        return True
    return root.startswith(candidate.rstrip("/") + "/")


def path_on_readonly_mount(path: str, *, mountinfo_path: str | None = None) -> bool:
    """path 最长前缀匹配的挂载是否带 ro 选项。

    mountinfo 每行第 5 列（0 基，即第 6 个字段）是 per-mount 选项，逗号分隔。
    读不到、解析失败或没有任何挂载匹配 → False（fail closed，不可信）。
    """
    target = MOUNTINFO_PATH if mountinfo_path is None else mountinfo_path
    normalized = os.path.normpath(path)
    try:
        text = _read_bounded(target, MAX_MOUNTINFO_BYTES)
    except (OSError, ValueError):
        return False
    best_option: str | None = None
    best_length = -1
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 6:
            continue
        mount_point = _unescape_mountinfo(fields[4])
        if not mount_point.startswith("/"):
            continue
        if not _remember(normalized, mount_point):
            continue
        length = len(mount_point.rstrip("/"))
        if length >= best_length:
            best_length = length
            best_option = fields[5]
    if best_option is None:
        return False
    return "ro" in best_option.split(",")


def _path_is_writable(path: str) -> bool:
    """当前进程是否可写该路径；测试可 monkeypatch。"""
    return os.access(path, os.W_OK)


def host_root_owned(
    path: str,
    st: os.stat_result,
    *,
    uid_map_path: str | None = None,
    mountinfo_path: str | None = None,
    overflowuid_path: str | None = None,
    access_check=None,
) -> tuple[bool, str]:
    """判断 stat 结果是否等价于「host root 拥有」。

    返回 (可信?, 原因码)。原因码是稳定字符串，调用方自行映射成自己的错误码：
    ROOT_MAPPED / OVERFLOW_ON_READONLY_MOUNT 表示可信；UID_MISMATCH /
    MOUNT_NOT_READONLY / WRITABLE_BY_USER 表示不可信。
    """
    host_uid = map_to_host_uid(st.st_uid, uid_map_path=uid_map_path)
    if host_uid is not None:
        if host_uid == 0:
            return True, REASON_ROOT_MAPPED
        return False, REASON_UID_MISMATCH
    expected = overflowuid(overflowuid_path=overflowuid_path)
    if st.st_uid != expected:
        return False, REASON_UID_MISMATCH
    if not path_on_readonly_mount(path, mountinfo_path=mountinfo_path):
        return False, REASON_MOUNT_NOT_READONLY
    writable = _path_is_writable(path) if access_check is None else bool(access_check(path))
    if writable:
        return False, REASON_WRITABLE_BY_USER
    return True, REASON_OVERFLOW_ON_READONLY_MOUNT
