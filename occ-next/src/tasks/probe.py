"""判断历史记录里的进程**还活着吗**（防 pid 复用）。

后端被杀时，非 daemon 的 worker 子进程会活下来。重启之后内存里的句柄全没了，
只有启动记录里的 `process_id` 和 `started_at` 还留着——**光看"这个 pid 存在吗"是不够的**：
pid 会被复用，一个不相干的进程完全可能顶上这个号。

所以要多问一句"**它是什么时候出生的**"：对得上，才是我们那个。

## 误报的方向要选安全的

拿不到创建时间时（权限不够、平台查不了），**保守地判"可能活着"**。

代价是该 Task 需要人工确认一下；而反过来（判成"已经死了"）的代价是**悄悄起第二个
写者**——两个进程同时写同一个 checkpoint，那是数据损坏。两者的代价不成比例。

← 来自 control/process_probe.py
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

#: 出生时间允许多大的误差（秒）。进程启动和宿主写下 `started_at` 之间总有一点点差，
#: 而记录精度也在秒一级。
#:
#: **它只往一个方向量**：进程的出生时间**晚于**记录的时间超过这么多，才判"不是我们那个"。
#: 反过来（出生时间比记录早很多）说明的是**记录不对**，不是进程不对——那时候保守判活。
TOLERANCE_SECONDS = 5.0

#: Windows 的常量。只有那两个 API 用得到它们。
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_SYNCHRONIZE = 0x00100000


def is_alive(process_id: int, started_at: str = "") -> bool:
    """那个进程还在吗？**拿不准就答"在"。**

    `started_at` 是启动记录里那一格（UTC ISO-8601）。给空字符串就是"不比对出生时间"，
    那时只要有这个 pid 就判活着——**保守那一边**。
    """
    if process_id <= 0:
        return False
    if sys.platform == "win32":
        return _windows_alive(process_id, started_at)
    return _posix_alive(process_id, started_at)


def _windows_alive(process_id: int, started_at: str) -> bool:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(
        _PROCESS_QUERY_LIMITED_INFORMATION | _SYNCHRONIZE, False, int(process_id))
    if not handle:
        return False                      # 打不开 = 没有这个进程（或者它已经退出）
    try:
        created = _windows_created_at(kernel32, wintypes, handle)
    finally:
        kernel32.CloseHandle(handle)
    if created is None:
        return True                       # **问不出来就保守判活**（见文件说明）
    return _same_moment(created, started_at)


def _windows_created_at(kernel32, wintypes, handle) -> datetime | None:
    import ctypes

    creation, exit_time, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
    ok = kernel32.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_time),
                                  ctypes.byref(kernel_time), ctypes.byref(user_time))
    if not ok:
        return None
    # FILETIME 是"1601 年以来的 100 纳秒数"。
    ticks = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
    if ticks <= 0:
        return None
    return datetime.fromtimestamp(ticks / 10_000_000 - 11_644_473_600, tz=timezone.utc)


def _posix_alive(process_id: int, started_at: str) -> bool:
    try:
        os.kill(process_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True                       # 存在，只是不是我们的——**保守判活**
    return _same_moment(_posix_created_at(process_id), started_at)


def _posix_created_at(process_id: int) -> datetime | None:
    """`/proc` 说得清就比对；macOS 之类没有 `/proc` 的就退回"不比对"。"""
    try:
        stat = os.stat(f"/proc/{process_id}")
    except OSError:
        return None
    return datetime.fromtimestamp(stat.st_ctime, tz=timezone.utc)


def _same_moment(created: datetime | None, started_at: str) -> bool:
    """这个进程还是当初那个吗。**只有确凿才说"不是"。**

    判据是**单向**的：**出生时间晚于我们记录的时间** = 这个 pid 后来被别人占了
    （pid 复用），我们那个已经死了。反过来不成立——出生时间比记录早很多，说明的是
    **记录**不对（时钟偏了、或者记录写得晚），不是进程不对，那时候按"可能活着"算。

    拿不准就答"活着"：代价是要人确认一次，而不是悄悄起第二个写者。
    """
    if created is None or not started_at:
        return True                       # 比对不了 → 保守判活
    try:
        recorded = datetime.fromisoformat(started_at)
    except ValueError:
        return True
    if recorded.tzinfo is None:
        recorded = recorded.replace(tzinfo=timezone.utc)
    return created <= recorded + timedelta(seconds=TOLERANCE_SECONDS)
