"""OCC Next 实现审查探针。

对应 `docs/architecture-next/engineering/review-findings.md` 里那批实测条目。
这些探针**故意构造单元测试没覆盖的旁路**，用来证明那类缺陷现在到底在哪一侧。
它们不碰项目数据：每一项都在自己的临时目录里跑。

用法（在 occ-next 目录下）：

    ./.venv/Scripts/python.exe scripts/review_probes.py

每一项输出一行结论：`[已修复]` 说明这一版里那类缺陷不成立，`[仍存在]` 说明它还在。

## 这一版是照新树重写的，两件事必须知道

**一、`if __name__ == "__main__":` 那道守卫不是风格，是硬要求。** 新树的 worker 走
`multiprocessing` 的 **spawn**（`tasks/spawn.py`：传的是一个顶层函数加一份纯数据），
而 spawn 的子进程会**把父进程的 `__main__` 整个重新 import 一遍**。守卫缺了，
每起一个 worker 就等于把这个脚本在子进程里从头再跑一次——它会在探针一里卡住，
而父进程看见的是"worker 起来了、什么都不说"，任务永远停在 running。

旧树那份没有这道守卫，是因为旧 `ProcessSupervisor` 走的是 `subprocess`：子进程
只执行指定的入口，不 import `__main__`。**换了实现，这条要求就回来了。**

**二、包名不再是 `composition` / `core` 这些顶层名。** 旧脚本把 `occ-next/src`
插进 `sys.path` 再 `from composition.app import build_app`；新树里 `src` 就是包名
（`python -m src.serve`），插的是**仓库根**（`src/` 与 `tests/` 都在这一层）。

五道题本身没变；问法跟着新契约变了的两处，各自写在探针里。
"""
from __future__ import annotations

import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))

from src.app.build import build                            # noqa: E402
from src.app.settings import Settings                      # noqa: E402
from src.storage.control import SqliteCoreStore            # noqa: E402
from tests.support.newtree import (                        # noqa: E402
    application, wait_for_status, write_package, write_tree,
)

#: 临时树落在**仓库里**（已 gitignore），跑完就删。
#: **不用系统临时目录**：那是用户的地盘，不是这个项目的产物堆。
SCRATCH = BASE / ".probe-tmp"

RESULTS: list[tuple[str, bool, str]] = []


def scratch() -> Path:
    """一个干净的空目录。每一项探针一个，互不串味。"""
    SCRATCH.mkdir(exist_ok=True)
    return Path(tempfile.mkdtemp(dir=SCRATCH))


def record(name: str, fixed: bool, detail: str) -> None:
    RESULTS.append((name, fixed, detail))
    print(f"[{'已修复' if fixed else '仍存在'}] {name}: {detail}")


def start(app, **payload) -> str:
    """建一个 Task 并启动它（走命令面，不碰内核内部）。返回 task_id。"""
    created = app.facade.submit("create_task", {"summary": "探针", **payload})
    task_id = created.data["task_id"]
    app.facade.submit("start_task", {"task_id": task_id})
    return task_id


def banner(title: str) -> None:
    print()
    print("=" * 60)
    print(title)
    print("=" * 60)


def probe_reassembly() -> None:
    """一、连续两次装配，会不会把**真在跑**的任务判死？

    新树在装配期对账，而且**会把"进程已死 / 没有启动记录"的 Task 自动收成 failed**
    （`tasks/reconcile.py`）。所以这道题的前提是那个 worker 真的还在跑：对账要认出
    "启动记录还开着、进程还活着"，而不是看见 running 就当成上次留下的残骸。
    """
    banner("探针一：连续两次装配是否会把在跑的任务判死")
    root = scratch()
    app = application(root)
    task_id = start(app, executor_ref="slow.run")
    wait_for_status(app.kernel, task_id, "running")
    before = app.kernel.get_task(task_id).status

    second = build(settings=app.settings)
    after = second.kernel.get_task(task_id).status
    print(f"第一次装配后: {before} → 第二次装配后: {after}")
    record("装配即判死在跑任务", after == before, f"{before} → {after}")
    second.shutdown()
    app.shutdown()


def probe_corrupted_event() -> None:
    """二、一条事件损坏之后，内核还能不能继续干活（显式修复那条路走不走得通）。"""
    banner("探针二：一条事件损坏之后，内核还能不能继续干活")
    root = scratch()
    app = application(root)
    warm = start(app, executor_ref="echo.run", task_ref="hello.txt")
    wait_for_status(app.kernel, warm, "succeeded", "failed")

    db = app.settings.database
    with sqlite3.connect(db) as con:
        # **改最后一条的自身校验和**——那才是"尾部损坏"：`repair_tail` 修的就是它
        # （把这条连同它之后的备份出去、丢掉，链继续接得上）。
        #
        # 改 `prev_hash`（链接）是**另一种**坏法：断链说明"上游被删过/被改过"，
        # 那时 `inspect()` 判的是 internal 而不是 tail，`repair_tail` 会拒修——
        # 拒得对：把链接好等于把"链断过"这件事抹掉，而链存在的理由就是让它看得见。
        con.execute("""
            UPDATE control_events SET checksum='damaged'
            WHERE rowid = (SELECT MAX(rowid) FROM control_events)
        """)

    store = SqliteCoreStore(db)
    report = store.inspect()
    print(f"检查结论: tail_corruption={report.tail_corruption} "
          f"errors={list(report.errors)[:1]}")

    repaired = report
    if report.tail_corruption and report.errors:
        tail = [report.errors[0].split(":", 1)[0].removeprefix("event ")]
        repaired = store.repair_tail(tail, True)

    try:
        start(app, executor_ref="echo.run", task_ref="hello.txt")
        print(f"显式修复后可继续创建任务: repaired={repaired.repaired}")
        record("损坏后内核继续可用", repaired.repaired, "尾部显式备份/修复后恢复追加")
    except Exception as exc:  # noqa: BLE001
        record("损坏后内核继续可用", False, f"{type(exc).__name__}: {exc}")
    app.shutdown()


def probe_bad_package() -> None:
    """三、坏包会不会让整个内核起不来（隔离要**同时**做到两件事）。"""
    banner("探针三：坏包会不会让整个内核起不来")
    root = scratch()
    extensions = write_tree(root)
    # 两种坏法各来一个：清单里写了契约表不认的键、以及 YAML 根本读不出来。
    write_package(extensions, "bad-keys", "id: bad-keys\nkind: readonly_json\n", {})
    (extensions / "bad-yaml").mkdir(parents=True, exist_ok=True)
    (extensions / "bad-yaml" / "manifest.yaml").write_text("executors: [oops\n", encoding="utf-8")

    workspace = root / "workspace"
    workspace.mkdir(exist_ok=True)
    settings = Settings(root=root, database=root / "data" / "control.sqlite",
                        workspace=workspace, extensions=extensions)
    try:
        app = build(settings=settings)
        registered = sorted(item.name for item in app.registry.executors.all())
        diagnostics = [item.message for item in app.loaded.diagnostics]
        print(f"注册上的执行者: {registered}")
        print(f"坏包留下的诊断: {len(diagnostics)} 条 {diagnostics[:2]}")
        # 判据有两半：**好包照旧登记**，而且坏包**留下了话说**。
        # 只用一条会放过"静默把它丢掉"——那比起不来更难查。
        fixed = "echo.run" in registered and len(diagnostics) >= 1
        record("坏包隔离", fixed,
               f"内核照常启动，{len(registered)} 个执行者登记着" if fixed
               else f"好包={registered}，诊断={diagnostics}")
        if diagnostics:
            # 诊断只活在内存里，而 `/api/state` 没有它的出口（`extensions/diagnostics.py`
            # 记着的欠账）。所以"坏包被记下来了"这件事**只有这一个地方说得出口**。
            print("注意：这些诊断在 /api/state 里读不到（欠账记在 OPEN_ISSUES.md）")
        app.shutdown()
    except Exception as exc:  # noqa: BLE001
        record("坏包隔离", False, f"内核启动失败 {type(exc).__name__}: {exc}")


def probe_tool_schema() -> None:
    """四、交给模型的参数 schema 与函数签名是不是同一个事实。

    旧契约里参数写在清单里（`input_schema`），所以那道题问的是"清单声明的 == 模型
    看到的"。新契约**清单里没有这一栏**（`extensions/manifest.py` 的契约表），
    schema 从签名读出来（`extensions/tools.py::schema_from_signature`）——于是漂移
    只可能发生在"签名读错了"这一侧，不可能发生在"两边各写一份"。
    """
    banner("探针四：交给模型的参数 schema 是不是从函数签名读出来的")
    root = scratch()
    app = application(root)
    try:
        tool = next(item for item in app.loaded.tools
                    if item.implementation.tool_id == "echo.say")
        schema = tool.implementation.input_schema
        properties = sorted((schema.get("properties") or {}).keys())
        expected = ["text"]                       # `Echo.say(self, text: str)`
        print(f"模型看到的参数: {properties}；函数签名上的参数: {expected}")
        record("工具参数 schema", properties == expected,
               f"模型看到 {properties}（schema 类型：{schema.get('type')}）")
    except StopIteration:
        record("工具参数 schema", False, "没找到 echo.say 这台供给")
    app.shutdown()


def probe_denied_tool() -> None:
    """五、被拒的工具调用要回告 worker，而不是把监听链路打死。

    `tools_from: []` 就是"一个工具都不许"（默认拒绝）——那正是判决表的第一条。
    """
    banner("探针五：内核拒绝时，监听链路是否还能继续")
    root = scratch()
    extensions = write_tree(root)
    write_package(extensions, "intruder", "\n".join([
        "id: intruder",
        "executors:",
        "  - name: intruder.run",
        "    tools_from: []",
        '    worker: {entrypoint: "worker.py:run"}',
        "",
    ]), {"worker.py": '''\
from src.tasks.channel import COMPLETED, FAILED, WorkerChannel


def run(connection, task_data, config_data, input_text, database_path, resume_value=None):
    channel = WorkerChannel(connection, str(task_data["task_id"]))
    answer = channel.request_tool("guard.write", {"text": "偷偷写"})
    if not answer.ok:
        channel.report(FAILED, {"reason": f"被拒了: {answer.decision} / {answer.error}"})
        return
    channel.report(COMPLETED, {"result_ref": str(answer.result)})
'''})
    workspace = root / "workspace"
    workspace.mkdir(exist_ok=True)
    (workspace / "hello.txt").write_text("你好", encoding="utf-8")
    settings = Settings(root=root, database=root / "data" / "control.sqlite",
                        workspace=workspace, extensions=extensions)
    try:
        app = build(settings=settings)
        task_id = start(app, executor_ref="intruder.run", task_ref="hello.txt")
        task = wait_for_status(app.kernel, task_id, "failed", "succeeded", timeout=20)
        reasons = [str((event.payload or {}).get("reason") or "")
                   for event in app.kernel.events(task_id)]
        print(f"收尾: {task.status}；理由: {[item for item in reasons if item][:1]}")
        # 两半都要：worker 收到的是一个**答复**（不是挂住、也不是把宿主打死），
        # 而且宿主**还能接着干活**——后一条才是"异常没逃出监听循环"真正的判据。
        alive = start(app, executor_ref="echo.run", task_ref="hello.txt")
        wait_for_status(app.kernel, alive, "succeeded", "failed", timeout=20)
        fixed = task.status == "failed" and any("deny" in item for item in reasons)
        record("内核拒绝可回告 worker", fixed,
               "worker 收到拒绝并报 failed（宿主仍可继续建任务）" if fixed
               else f"status={task.status} reasons={reasons}")
        app.shutdown()
    except Exception as exc:  # noqa: BLE001
        record("内核拒绝可回告 worker", False, f"{type(exc).__name__}: {exc}")


def main() -> int:
    for probe in (probe_reassembly, probe_corrupted_event, probe_bad_package,
                  probe_tool_schema, probe_denied_tool):
        try:
            probe()
        except Exception as exc:  # noqa: BLE001 — 一项炸了不拖垮其余几项
            record(probe.__name__, False, f"探针自己炸了 {type(exc).__name__}: {exc}")

    banner("汇总")
    for name, fixed, detail in RESULTS:
        print(f"  {'OK   ' if fixed else 'GAP  '} {name} — {detail}")
    gaps = sum(1 for _, fixed, _ in RESULTS if not fixed)
    print(f"\n未修复项：{gaps} / {len(RESULTS)}")
    # 临时树是跑出来的中间物，跑完就删——**更不该留在用户的 Temp 里**
    shutil.rmtree(SCRATCH, ignore_errors=True)
    return 1 if gaps else 0


if __name__ == "__main__":
    raise SystemExit(main())
