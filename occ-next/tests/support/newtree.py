"""一套**最小可跑**的例子：一个包（工具 + 执行者）+ 一条日程 + 一家供应商。

它同时是三种测试的地基：判决（有什么、允不允许）、进程（起没起来）、接入（快照长什么样）。
写在这里而不是各测试里各写一份，是因为"一个包长什么样"这件事**只该有一种写法**——
三份写法会漂移，而漂移之后不知道哪份是真的。

worker 是**真的子进程里跑的代码**（`spawn`），所以它是真的读写管道、真的报收尾。
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable

from src.app.build import Application, build
from src.app.settings import Settings

ECHO_MANIFEST = """\
id: echo
name: 回声
tools:
  - name: echo
    approval_required: false
    entrypoint: provider.py:Echo
executors:
  - name: echo.run
    tools_from: [echo]
    worker: {entrypoint: "worker.py:run"}
"""

ECHO_PROVIDER = '''\
"""一个最小的工具供给：一个单例，它的公开方法就是工具。"""


class Echo:
    """回声。"""

    def say(self, text: str) -> dict:
        """把这句话回一遍。"""
        return {"text": text, "length": len(text)}

    def boom(self) -> dict:
        """故意炸一次——用来验"工具自己失败了"这条路。"""
        raise ValueError("说炸就炸")
'''

#: 一个**会停下来等审批**的 worker：第一次调那个工具拿到 needs_approval 就报 interrupted；
#: 恢复之后（宿主重起它，带上 resume_value）再调同一个工具，指纹对上，这次兑现成 allow。
ECHO_WORKER = '''\
from src.gateway.permission.decision import NEEDS_APPROVAL
from src.tasks.channel import COMPLETED, FAILED, INTERRUPTED, WorkerChannel


def run(connection, task_data, config_data, input_text, database_path, resume_value=None):
    channel = WorkerChannel(connection, str(task_data["task_id"]))
    answer = channel.request_tool("guard.write", {"text": input_text.strip()})
    if answer.decision == NEEDS_APPROVAL:
        channel.report(INTERRUPTED, {"checkpoint_ref": "cp-1"})
        return
    if not answer.ok:
        channel.report(FAILED, {"reason": answer.error or "被拒绝了"})
        return
    channel.report(COMPLETED, {"result_ref": "写好了"})
'''

#: 一个**只用不批的工具**、跑完就报完成的 worker。
PLAIN_WORKER = '''\
from src.tasks.channel import COMPLETED, FAILED, WorkerChannel


def run(connection, task_data, config_data, input_text, database_path, resume_value=None):
    channel = WorkerChannel(connection, str(task_data["task_id"]))
    answer = channel.request_tool("echo.say", {"text": input_text.strip()})
    if not answer.ok:
        channel.report(FAILED, {"reason": answer.error or "调用失败"})
        return
    channel.report(COMPLETED, {"result_ref": str(answer.result)})
'''

#: 一个**什么都不说就退出**的 worker——"静默退出也要有终态"那条的试验品。
SILENT_WORKER = '''\
def run(connection, task_data, config_data, input_text, database_path, resume_value=None):
    return None
'''

#: 一个**跑很久**的 worker——取消要有东西可取消。
SLEEP_WORKER = '''import time

from src.tasks.channel import COMPLETED, WorkerChannel


def run(connection, task_data, config_data, input_text, database_path, resume_value=None):
    time.sleep(120)
    WorkerChannel(connection, str(task_data["task_id"])).report(COMPLETED, {"result_ref": "醒了"})
'''

#: 一个**一上来就抛**的 worker。
BOOM_WORKER = '''\
def run(connection, task_data, config_data, input_text, database_path, resume_value=None):
    raise RuntimeError("我在入口里炸了")
'''

GUARD_MANIFEST = """\
id: guard
name: 守卫
tools:
  - name: guard
    approval_required: true
    entrypoint: provider.py:Guard
executors:
  - name: guard.run
    tools_from: [guard]
    worker: {entrypoint: "worker.py:run"}
"""

GUARD_PROVIDER = '''\
class Guard:
    def write(self, text: str) -> dict:
        """写下去。**它要人批。**"""
        return {"written": text}
'''


#: 一条只会记账的通道：**把收到的卡片写进文件**，测试据此看"到底送出去了什么"。
#: 它不是假货——它就是"一条通道"能做到的最小样子（enabled / send_text / send_card）。
PIGEON_MANIFEST = """id: pigeon
name: 信鸽
channels:
  - name: pigeon
    entrypoint: "channel.py:Pigeon"
"""

PIGEON_CHANNEL = '''import json
import pathlib


class Pigeon:
    """把每一张卡片写进 `sent.jsonl`。**宿主的手，不是被审批的动作。**

    `arm` 那一格也记账（`armed.jsonl`）：**"口子什么时候递进来的"是这个夹具唯一
    能证明"回来路按需接上"的东西**——它自己不开连接，所以只记"宿主说了要回话"。
    """

    def __init__(self) -> None:
        self.who = "ou_pigeon"
        self.sent = pathlib.Path(__file__).parent / "sent.jsonl"
        self.armed = pathlib.Path(__file__).parent / "armed.jsonl"

    def enabled(self) -> bool:
        return True

    def send_text(self, text: str) -> dict:
        self._write({"text": text})
        return {"ok": True}

    def send_card(self, card: dict) -> dict:
        self._write(card)
        return {"ok": True}

    def arm(self, on_action) -> None:
        with self.armed.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"callable": callable(on_action)}) + chr(10))

    def _write(self, payload: dict) -> None:
        with self.sent.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + chr(10))
'''


def write_package(extensions: Path, name: str, manifest: str, files: dict[str, str]) -> Path:
    package = extensions / name
    package.mkdir(parents=True, exist_ok=True)
    (package / "manifest.yaml").write_text(manifest, encoding="utf-8")
    for filename, text in files.items():
        (package / filename).write_text(text, encoding="utf-8")
    return package


def write_tree(root: Path) -> Path:
    """建出 `extensions/` 那棵树：两个包 + 一条日程 + 一家供应商。"""
    extensions = root / "extensions"
    write_package(extensions, "echo", ECHO_MANIFEST,
                  {"provider.py": ECHO_PROVIDER, "worker.py": PLAIN_WORKER})
    write_package(extensions, "guard", GUARD_MANIFEST,
                  {"provider.py": GUARD_PROVIDER, "worker.py": ECHO_WORKER})
    write_package(extensions, "pigeon", PIGEON_MANIFEST, {"channel.py": PIGEON_CHANNEL})
    write_package(extensions, "slow", "\n".join([
        "id: slow",
        "executors:",
        "  - name: slow.run",
        '    worker: {entrypoint: "worker.py:run"}',
        "",
    ]), {"worker.py": SLEEP_WORKER})
    schedules = extensions / "_schedules"
    schedules.mkdir(parents=True, exist_ok=True)
    (schedules / "echo-daily.yaml").write_text(
        "name: echo.daily\ncron: '0 8 * * *'\ntimezone: Asia/Shanghai\n"
        "task_ref: hello.txt\nexecutor_ref: echo.run\n", encoding="utf-8")
    providers = extensions / "_providers"
    providers.mkdir(parents=True, exist_ok=True)
    (providers / "deepseek.yaml").write_text(
        "name: deepseek\nbase_url: https://api.deepseek.com/v1\n"
        "api_key_env: DEEPSEEK_API_KEY\nmodels:\n  - name: deepseek-v4-pro\n"
        "    context: 128000\n", encoding="utf-8")
    return extensions


def application(tmp_path: Path, *, approve: bool = True,
                web_dir: Path | None = None) -> Application:
    """装配起一整个系统，跑在 `tmp_path` 里。**测试用的那个"干净的例子"。**

    `web_dir` 是给"发布形态"用的（前端构建产物挂到 `/`）。默认 `None` = 开发形态：
    一棵多余的路由都不多。
    """
    workspace = tmp_path / "workspace"
    workspace.mkdir(exist_ok=True)
    (workspace / "hello.txt").write_text("你好", encoding="utf-8")
    extensions = write_tree(tmp_path)
    settings = Settings(root=tmp_path, database=tmp_path / "data" / "control.sqlite",
                        workspace=workspace, extensions=extensions, web_dir=web_dir)
    if approve:
        # 那条要人批的供给改成不用批——**大多数测试关心的是别的**，
        # 要测审批的自己把这一格改回去（`approval_required` 就在声明里）。
        path = extensions / "guard" / "manifest.yaml"
        path.write_text(GUARD_MANIFEST.replace("approval_required: true",
                                               "approval_required: false"), encoding="utf-8")
    return build(settings=settings)


def wait_until(check: Callable[[], Any], *, timeout: float = 20.0, interval: float = 0.05) -> Any:
    """等一件事发生。**子进程是真的，所以时间是测试的一部分。**"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError(f"等了 {timeout} 秒也没等到")


def wait_for_status(kernel, task_id: str, *statuses: str, timeout: float = 20.0):
    return wait_until(lambda: (task := kernel.get_task(task_id)).status in statuses and task,
                      timeout=timeout)
