"""host-root 归属判据（user-namespace aware）。

ADR §9 的信任判据：默认路径（/etc/ghostfleet/node-agent.json、
/etc/ghostfleet/capability-status.json）的文件必须「host root 拥有」。但在
systemd user manager 的 mount 类硬化（PrivateTmp/ProtectSystem/ProtectHome/
ReadOnlyPaths 等隐式开启 PrivateUsers=）沙箱里，进程只映射自身 UID，host root
拥有的文件在沙箱内显示为 overflow uid（默认 65534），所以「st_uid == 0」不可靠。

可信必须满足其一：

  (a) uid 0 在当前 user namespace 已映射（/proc/self/uid_map）→ st_uid == 0；
  (b) uid 0 未映射（只映射自身 UID）→ st_uid == overflowuid（默认 65534），
      且该路径在 /proc/self/mountinfo 最长前缀匹配的挂载带 ro 选项，
      且当前进程对该路径没有写权限（os.access(path, W_OK) 为假）。

(b) 不是放宽：只映射自身 UID 的 namespace 里，「host root 拥有」与「host 65534
拥有」在 uid 上无法区分；唯一可用的内核级等价不变量是「该路径所在挂载只读 +
当前用户写不了」。unit 里的 RestrictNamespaces=yes 阻止服务自造可写挂载视图，
因此这个判据真正保证的是：「托管账户改不了这个文件」。

任何解析失败一律 fail closed（不可信）。本模块零依赖、只读 /proc 与文件元数据。
"""
from __future__ import annotations

import os
import re

# 可在测试中注入的 proc 路径（运行期读取模块常量，避免默认参数绑定）。
UID_MAP_PATH = "/proc/self/uid_map"
MOUNTINFO_PATH = "/proc/self/mountinfo"
OVERFLOWUID_PATH = "/proc/sys/kernel/overflowuid"

DEFAULT_OVERFLOWUID = 65534
MAX_PROC_BYTES = 256 * 1024

REASON_ROOT_MAPPED = "ROOT_MAPPED"
REASON_OVERFLOW_ON_READONLY_MOUNT = "OVERFLOW_ON_READONLY_MOUNT"
REASON_UID_MISMATCH = "UID_MISMATCH"
REASON_MOUNT_NOT_READONLY = "MOUNT_NOT_READONLY"
REASON_WRITABLE_BY_USER = "WRITABLE_BY_USER"

_ESCAPE_RE = re.compile(r"\\([0-7]{3})")


def _read_bounded(path: str, limit: int = MAX_PROC_BYTES) -> str:
    """读一个 /proc 文本文件；超限按读取失败处理（fail closed）。"""
    with open(path, "rb") as handle:
        raw = handle.read(limit + 1)
    if len(raw) > limit:
        raise OSError("proc-file-too-large")
    return raw.decode("utf-8", "replace")


def uid_zero_mapped(*, uid_map_path: str | None = None) -> bool:
    """uid 0 是否已在当前 user namespace 被映射。

    /proc/self/uid_map 每行三列：inside outside length。只要有一行 inside 列
    等于 0 且 length > 0，就说明 uid 0 已映射。读取或解析失败时返回 True（保守：
    退回「必须 st_uid == 0」这条最严格判据）。
    """
    target = UID_MAP_PATH if uid_map_path is None else uid_map_path
    try:
        text = _read_bounded(target)
    except (OSError, ValueError):
        return True
    ambiguous = False
    for line in text.splitlines():
        fields = line.split()
        if not fields:
            continue
        if len(fields) < 3:
            ambiguous = True
            continue
        try:
            length = int(fields[2])
        except ValueError:
            ambiguous = True
            continue
        if fields[1].strip() == "0" and length > 0:
            return True
    return True if ambiguous else False


def overflowuid(*, overflowuid_path: str | None = None) -> int:
    """沙箱内「未映射 UID」的占位值；读不到时用内核默认 65534。"""
    target = OVERFLOWUID_PATH if overflowuid_path is None else overflowuid_path
    try:
        text = _read_bounded(target, limit=64).strip()
        value = int(text)
    except (OSError, ValueError):
        return DEFAULT_OVERFLOWUID
    if value < 0 or value > 4294967294:
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
        text = _read_bounded(target)
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
    if uid_zero_mapped(uid_map_path=uid_map_path):
        if st.st_uid == 0:
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
