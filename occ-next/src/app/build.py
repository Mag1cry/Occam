"""唯一的依赖装配根。**只有这里 new 具体实现。**

别处的每一行都应该是"用别人给的"，不是"自己造一个"。这不是洁癖：测试要一个
**干净的例子**，而全局变量得手动清理，忘了就串味；而且"拿到它"应该是一步看得见的事。

## 装配期定死两样"全局只有一份"

| 建什么 | 之后 |
| --- | --- |
| **存储** | 绑进 `core/kernel.py`——外围（gateway / tasks / web）拿不到它 |
| **四个列表** | 绑给需要的人——判决、起 worker、派发、前端 |

**都不是 `import` 一个全局变量**（`gateway/directory/README.md` 里那段"跟存储同一条规矩"）。

## 谁接谁，一句话

```text
存储 → 内核 → 工具管线 ─┐
四个列表 ───────────────┼→ 门面 ← web
任务控制 ───────────────┤
日程 ───────────────────┘
```

**加载器不 import 网关**，所以这里给它一个写入面（`_Registrar`）：
`extensions/` 交出一份"完整的现在"，它转手填进四个列表和供给表。
回滚时那份原样再交一遍（`extensions/hotload.py`）。

## 启动顺序里有一件事不能少

**先对账，再让任何东西起得来**（`tasks/reconcile.py`）。后端被杀时子进程会活下来，
而重启之后"哪些 Task 还在跑"只能靠启动记录重建——晚一步就会起第二个写者。

← 来自 composition/app.py（回填、种子、注册失败隔离三类东西都不在这里了）
"""
from __future__ import annotations

import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..core.kernel import Kernel
from ..extensions import manifest as manifest_module
from ..extensions.hotload import HotLoader
from ..extensions.loader import Loaded
from ..extensions.writer import Declarations
from ..gateway.access.policy import load_or_create_token
from ..gateway.audit import AuditLog
from ..gateway.directory import Registry
from ..gateway.facade import Facade, TaskDispatch
from ..gateway.function.pipeline import ToolPipeline
from ..gateway.function.providers import ToolSupplies
from ..gateway.output.callback import decide as callback_decide
from ..gateway.output.output import from_fact
from ..gateway.output.paths import ChannelPaths
from ..storage.control import SqliteCoreStore
from ..tasks import inputs
from ..tasks.controller import TaskController
from ..tasks.launches import LaunchLog
from ..tasks.reconcile import Reconciliation, reconcile
from ..tasks.scheduler import Scheduler
from ..tasks.spawn import WorkerSpawner
from ..web.http import create_app
from .settings import Settings


class _Registrar:
    """**加载期的写入面。** 它把一份 `Loaded` 转手填进四个列表和供给表。

    顺序有讲究：**先填列表、再换供给**。反过来的话，有一个瞬间能力列表说的是新的一份、
    而点下去调的是旧的那一份——那正是"半个包"。
    """

    def __init__(self, registry: Registry, supplies: ToolSupplies,
                 channels: ChannelPaths) -> None:
        self.registry = registry
        self.supplies = supplies
        self.channels = channels

    def replace(self, loaded: Loaded) -> None:
        self.registry.replace(loaded)
        self.supplies.replace(loaded.supplies)
        # 通道**也在这儿换**：加一条输出路径只需要装一个包，不改任何代码
        self.channels.replace(loaded.channels)


@dataclass
class Application:
    """**装配好了的整个系统。** 拿它跑，或者拿它测。"""

    settings: Settings
    store: SqliteCoreStore
    kernel: Kernel
    registry: Registry
    supplies: ToolSupplies
    hotloader: HotLoader
    declarations: Declarations
    controller: TaskController
    scheduler: Scheduler
    facade: Facade
    audit: AuditLog
    launches: LaunchLog
    app: Any
    reconciliation: Reconciliation
    #: **外面点了什么该怎么答**（`channels.arm` 递出去的就是它）。
    #: 装配根里那个闭包本身，挂在这儿是为了**测得到**：接缝测试要模拟"有人点了那张卡"，
    #: 得用**同一个**口子，不能另造一个。
    answer: Any = None
    token: str = ""
    stop: threading.Event = field(default_factory=threading.Event)

    @property
    def loaded(self) -> Loaded:
        return self.hotloader.current

    def start(self) -> None:
        """**只起轮询。** 通道的回来路**不在这儿**。

        飞书那种长连接是**独占资源**（同一应用的多条连接会互相吃事件，集群模式不
        广播），所以"没东西要送的时候不该连着"——它归通道自己管，起在**第一次真的
        要送东西出去之前**（`gateway/output/paths.py::ChannelPath._arm`）。
        宿主在这儿起它，等于开机就把插座插上、然后一直占着。
        """
        self.scheduler.start()

    def shutdown(self) -> None:
        """**关停要按顺序来**，而且每一件都要做完：

        ① 停轮询（不然它还会派发新的）② 终止所有 worker（**没杀干净的要说出来**）
        ③ 收掉供给（外面的连接、包内的单例）④ 关三个库。
        """
        self.stop.set()
        self.scheduler.stop()
        for channel in self.loaded.channels:
            try:
                channel.close()
            except Exception:                           # noqa: BLE001 — 关停路上不抛
                pass
        survivors = self.controller.stop_all()
        if survivors:
            # 没杀干净的那些**必须有个说法**——重启之后它们会被对账探到。
            self.audit.record(command="shutdown", principal="system", outcome="error",
                              detail=f"这些 worker 没停下来: {' · '.join(survivors)}")
        self.hotloader.current.close()
        self.launches.database_close()
        self.scheduler.log.close()
        self.audit.close()
        self.store.close()


def build(root: str | Path | None = None, *, settings: Settings | None = None,
          start_scheduler: bool = False) -> Application:
    """**全部装配在这里。** 一行一个"建什么、接给谁"。"""
    settings = (settings or Settings.from_env(root)).prepare()

    audit = AuditLog(settings.audit)

    def hear(fact: Any) -> None:
        """**事实落链之后叫的这一声，有两个消费者**——写死在装配根。

        多一个消费者就要改这儿一行，**这是有意的**：隐式的订阅（谁都能挂一只手）
        会让"内核发生一件事之后到底会发生什么"变成一道查不出答案的题。
        见 `gateway/output/README.md` 的「驱动」一节。
        """
        audit.fact(fact)                       # ① 事实流：谁脏了
        one = from_fact(kernel, fact)          # ② 输出层：这件事要不要送出去
        if one is None:
            return
        for receipt in channel_paths.deliver(one):
            if not receipt["ok"]:
                # **不吞**：飞书没送到是用户要知道的事，静默等于假装送到了
                print(f"[输出] {receipt['path']} 没送到: {receipt['error']}", file=sys.stderr)

    def answer(payload: dict) -> tuple[bool, str]:
        """**外面点了什么** → 一条带证据的命令。通道把它带回去给人看。

        返回 `(成没成, 那句话)`——**"成没成"是给卡片用的**：点完那张卡要原地换成
        「已批准」还是「没做成」，靠它判，**不靠猜那句话的文案**（文案是给人看的，
        会改；而卡片标题写错就是给用户看了个假状态）。

        ## 每次都留一行，**成的和不成的都留**

        这条路上的失败**在别处一点痕迹都没有**：没被看一眼就被指纹挡下的点击不写事件链、
        不发事实，只在那一张卡片的 toast 上闪一下就没了。事后想说清"那次到底怎么了"
        只能靠这一行——所以它是**先说结果再说话**，不成的把原因原样带上。

        ## 它和 `hear` 一样是**闭包**

        定义在这儿（比 `kernel` / `facade` 早），真正用到的名字**到被调用时才解析**
        ——那时候它们早建好了。这样 `channel_paths` 能在构造时就把口子带上，而不必
        事后往对象上挂一个可变的属性。
        """
        ok, message = callback_decide(payload, kernel=kernel, facade=facade)
        print(f"[输出] {payload.get('who') or '?'} 点了 {payload.get('action') or '?'}"
              f"（{payload.get('task_id') or '?'}）：{'成了' if ok else '没成'}——{message}",
              file=sys.stderr)
        return ok, message

    store = SqliteCoreStore(settings.database, on_fact=hear)
    kernel = Kernel(store)

    registry = Registry()
    supplies = ToolSupplies()
    channel_paths = ChannelPaths(kernel=kernel, answer=answer)
    hotloader = HotLoader(settings.extensions, _Registrar(registry, supplies, channel_paths))
    declarations = Declarations(settings.extensions, validators={
        "package": manifest_module.validate_package,
        "schedule": manifest_module.validate_schedule,
        "provider": manifest_module.validate_provider,
    })

    launches = LaunchLog(settings.launches)

    pipeline = ToolPipeline(kernel=kernel, view=registry.view, supplies=supplies)
    controller = TaskController(kernel=kernel, registry=registry, pipeline=pipeline,
                                spawner=WorkerSpawner(), launches=launches,
                                workspace=settings.workspace,
                                database_path=settings.executor_data)
    dispatch = TaskDispatch(kernel, controller, registry)
    scheduler = Scheduler(dispatch, registry.schedules, path=settings.dispatches)
    facade = Facade(kernel=kernel, registry=registry, dispatch=dispatch,
                    declarations=declarations, runner=controller, scheduler=scheduler,
                    refresher=hotloader, audit=audit)

    # **第一次加载**：读声明、把四个列表填上。没有这一步，判决没有任何东西可判。
    hotloader.refresh()

    # **对账在任何东西起得来之前**：一个还开着的启动记录挡住了重启，而那是唯一
    # 能防住"两个写者"的时机。
    reconciliation = reconcile(kernel=kernel, launches=launches)

    stop = threading.Event()
    token = load_or_create_token(settings.access_token)
    app = create_app(facade=facade, kernel=kernel, registry=registry, audit=audit,
                     dispatches=scheduler.log, workers=controller.open_workers,
                     last_tool_result=controller.last_tool_result,
                     declarations=lambda: hotloader.current, token=token,
                     executor_data=str(settings.executor_data),
                     extensions_root=str(settings.extensions),
                     # 「选择文件」那只手：写工作区的函数住在 tasks/，而 web/ 不许
                     # import tasks/（分层测试钉着）——所以在这儿递进去
                     save_task_input=lambda name, text: inputs.save(
                         name, text, root=settings.workspace),
                     # 设了才挂——开发时界面归 vite dev（见 `Settings.web_dir`）
                     web_dir=str(settings.web_dir or ""), stop=stop)

    application = Application(
        settings=settings, store=store, kernel=kernel, registry=registry, supplies=supplies,
        hotloader=hotloader, declarations=declarations, controller=controller,
        scheduler=scheduler, facade=facade, audit=audit, launches=launches, app=app,
        reconciliation=reconciliation, answer=answer, token=token, stop=stop)
    if start_scheduler:
        application.start()
    return application
