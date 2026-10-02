"""只读投影：**前端唯一的事实入口**。

前端不拼事实，它读这个。所以有哪几样东西要展示，这里就得有几样：

| 投影什么 | 从哪读 |
| --- | --- |
| 四个列表（能力 / 执行者 / 供应商 / 日程） | `gateway/directory/`——**含关着的那些** |
| Task 的状态与最近事件 | 内核（`core/task.py` + `core/event.py`） |
| 历史的引用还读得回来吗 | `references.py` 的三态 |
| 派发过什么 | `tasks/scheduler.py` 的记录（可选） |

**关着的东西也要在里面**：列表是前端渲染的唯一依据，投影要是把它们滤掉，前端就只能
自己另编一套"关着的扩展"——同一件事又变成两处在说，而它们会漂移。

**它不是网关的一部分。** 它经由网关暴露，但承担的是**接入面的责任**：给前端一个稳定的
形状。判决和记账都不经过这里。

## 两套视图，各服务一种读者

| 视图 | 按什么组织 | 谁读 |
| --- | --- | --- |
| **注册表**（`registry`） | 按**类型** | 后端判决、起 worker、派发 |
| **配置舱**（`console`） | 按**声明文件**（包 / 独立文件） | 人 |

**后端从不问"这属于哪个包"**——它只问"这个工具存在吗"、"这个执行者允许用它吗"。
而配置舱问的正是前者，所以它是**投影，不是第五份数据**。

**同一份声明里的两条按名字缝成一个节点**：工具的 `供给名.函数名` 和执行者的全名对上，
人就看到一个函数带两个词条（`extensions/README.md` 的"同一个函数可以有两个身份"）。

## 事件只给最近几条

"把每个 Task 的全部事件装进响应"是旧代码的写法，而一个跑久了的系统，快照会大到前端
接不住（`OPEN_ISSUES.md` 里那条）。所以这里**限量**，要更多就按 Task 单独读。

← 来自 gateway.py::snapshot + 四个 _*_snapshot + 配置舱（按声明文件分组的树）
"""
from __future__ import annotations

from dataclasses import asdict
from typing import Any

from pathlib import Path

from ..extensions.loader import MANIFEST_NAME, PROVIDERS_DIR, SCHEDULES_DIR
from ..gateway.output.output import standing
from ..gateway.directory import Registry
from . import references

#: 每个 Task 带几条最近事件。**有意的上限**，不是分页的替代品。
RECENT_EVENTS = 20


def snapshot(*, kernel, registry: Registry, audit: Any = None,
             dispatches: Any = None, workers: Any = None,
             declarations: Any = None, extensions: str = "") -> dict[str, Any]:
    tasks = kernel.list_tasks()
    return {
        "registry": _registry(registry),
        "declarations": _declarations(declarations),
        "tasks": [_task(task, kernel, registry) for task in tasks],
        "console": _console(registry, extensions),
        "dispatches": _dispatches(dispatches),
        "workers": list(workers()) if workers is not None else [],
        "cursor": int(audit.latest()) if audit is not None else 0,
        # **悬着的输出**（今天只有"等人拍板"这一种）。
        #
        # 它进快照而不是单开一条路由，理由和别的一样：**前端的唯一事实入口是这里**。
        # 而它是**投影**——从 Task 现算（`gateway/output/output.py::standing`），
        # 不存任何状态，所以多读一次不会让两边漂开。前端那条输出路径就是靠它送达的：
        # "出现在快照里"= 送到了（`gateway/output/README.md`）。
        "outputs": [asdict(item) for item in standing(kernel)],
    }


def _declarations(loaded: Any) -> list[dict[str, Any]]:
    """**声明原文**：每个包里那几条 `tools` / `executors` 条目，一字不改地给出去。

    为什么要有它：改一条**列表里**的条目（关掉一台供给、改一个工具的审批要求），
    唯一的写路径是"整列重写"——而重写必须有那一列。前端照着成品列表拼一份出来，
    会丢掉 `url` / `entrypoint`（成品里没有它们），写回去就是一份坏声明。

    **它不是第五份事实**：它就是磁盘上那份声明，只是过了一道 JSON。
    """
    if loaded is None:
        return []
    current = loaded() if callable(loaded) else loaded
    return [{
        "id": package.id,
        "enabled": package.enabled,
        "name": package.name,
        "tools": [asdict(item) for item in package.tools],
        "executors": [asdict(item) for item in package.executors],
    } for package in current.packages]


# ── 注册表：四个列表

def _registry(registry: Registry) -> dict[str, Any]:
    return {
        # 能力列表是**供给**级的：一个关着的包只知道它声明了哪几台供给，
        # 里面的函数要跑起来才问得出来（`directory/capabilities.py`）。
        "capabilities": [
            {"name": item.name, "package": item.package, "enabled": item.enabled,
             "loaded": item.loaded, "problem": item.problem, "usable": item.usable,
             "status": item.status, "detail": item.detail,
             "approval_required": item.approval_required, "idempotency": item.idempotency,
             "tools": [{"tool_id": spec.name, "description": spec.description,
                        "input_schema": spec.input_schema} for spec in item.tools]}
            for item in registry.capabilities.all()
        ],
        "executors": [
            {"name": item.name, "package": item.package, "based_on": item.based_on,
             "enabled": item.enabled, "problem": item.problem, "runnable": item.runnable,
             "why_not": item.why_not, "needs_llm": item.needs_llm,
             "model": dict(item.model or {}) or None,
             "tools_from": list(item.tools_from), "tighten": list(item.tighten)}
            for item in registry.executors.all()
        ],
        "providers": [
            {"name": item.name, "base_url": item.base_url, "enabled": item.enabled,
             "models": [dict(model) for model in item.models]}
            for item in registry.providers.all()
        ],
        "schedules": [
            {"name": item.name, "cron": item.cron, "timezone": item.timezone,
             "task_ref": item.task_ref, "executor_ref": item.executor_ref,
             "enabled": item.enabled,
             "executor": _ref(registry, "executor", item.executor_ref)}
            for item in registry.schedules.all()
        ],
        "packages": [
            {"id": item.id, "enabled": item.enabled, "name": item.name,
             "description": item.description, "version": item.version}
            for item in registry.packages
        ],
    }


# ── Task：状态 + 最近事件 + 引用还读不读得回来

def _task(task, kernel, registry: Registry) -> dict[str, Any]:
    return {
        "task_id": task.task_id,
        "summary": task.summary,
        "task_ref": task.task_ref,
        "status": task.status,
        "state_version": task.state_version,
        "session_ref": task.session_ref,
        "checkpoint_ref": task.checkpoint_ref,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
        "executor_ref": task.executor_ref,
        "executor": _ref(registry, "executor", task.executor_ref),
        # 归档：**它跑完了、我不再管它了**。它不改状态，所以单独一栏说
        "archived": bool(task.archived),
        "pending": _pending(task),
        # 事件走内核那扇门读（`kernel.events`），**不碰它的存储**。
        "events": [_event(item) for item in kernel.events(task.task_id)[-RECENT_EVENTS:]],
    }


def _pending(task) -> dict[str, Any] | None:
    if not task.has_pending:
        return None
    return {"tool_id": task.pending_tool_id, "reason_ref": task.pending_reason_ref,
            "decision": task.pending_decision}


def _event(item) -> dict[str, Any]:
    return {"event_id": item.event_id, "event_type": item.event_type,
            "tool_id": item.tool_id, "external_ref": item.external_ref,
            "occurred_at": item.occurred_at, "payload": dict(item.payload)}


def _ref(registry: Registry, kind: str, name: str) -> dict[str, Any] | None:
    if not name:
        return None
    found = references.resolve(kind, name, registry=registry)
    return {"kind": found.kind, "name": found.name, "state": found.state,
            "detail": found.detail, "readable": found.readable,
            "referable": found.referable}


# ── 配置舱：同一份事实，另一种组织

def _console(registry: Registry, root: str = "") -> list[dict[str, Any]]:
    """`extensions/` **那棵树**：目录 + 声明文件。

    注册表按**类型**排（判决要那样：给我一个 tool_id，答它在不在）；
    这里按**文件**排（人要这个：我改的是哪个文件）。

    **它就是一层投影**——节点全部由注册表那四个列表现算，没有第五份数据，
    所以两者不可能漂移。前端照着画即可：**它提供渲染器，不提供结构**。

    路径**读出来、不推出来**：文件名和声明里的名字可以不同
    （`_schedules/weather-daily.yaml` 里写着 `name: weather.daily`），
    推出来的路径会指向一个不存在的文件——而界面上写着"这份声明在这儿"，
    用户照着去找，找不到。
    """
    def shown(raw: str) -> str:
        """相对**扩展根**说。绝对路径在这台机器上是对的、给别人看是噪音。"""
        if not raw:
            return ""
        path = Path(raw)
        if not root:
            return path.as_posix()
        try:
            return path.relative_to(root).as_posix()
        except ValueError:
            return path.as_posix()          # 不在这个根下：如实说它在哪

    return [
        _directory(PROVIDERS_DIR, [_provider_file(item, shown) for item in registry.providers.all()]),
        _directory(SCHEDULES_DIR, [_schedule_file(item, shown) for item in registry.schedules.all()]),
        *[_package_dir(item, registry, shown) for item in registry.packages],
    ]


def _directory(name: str, nodes: list[dict[str, Any]]) -> dict[str, Any]:
    """一个目录。**下划线开头的那两个是宿主自己的约定**（`loader.py` 里那两条常量），
    所以它们由后端说——前端不该知道 `_providers` 这个名字。"""
    return {"kind": "directory", "name": name, "path": name, "nodes": nodes}


def _provider_file(provider, shown) -> dict[str, Any]:
    return {"kind": "provider", "name": provider.name, "enabled": provider.enabled,
            "path": shown(provider.path), "base_url": provider.base_url,
            "nodes": [{"kind": "model", "name": str(model.get("name") or ""),
                       "owned_by": str(model.get("owned_by") or ""), "nodes": []}
                      for model in provider.models]}


def _schedule_file(schedule, shown) -> dict[str, Any]:
    return {"kind": "schedule", "name": schedule.name, "enabled": schedule.enabled,
            "path": shown(schedule.path),
            "cron": schedule.cron, "timezone": schedule.timezone,
            "task_ref": schedule.task_ref, "executor_ref": schedule.executor_ref,
            "nodes": []}


def _package_dir(package, registry: Registry, shown) -> dict[str, Any]:
    """一个包 → 它清单里声明的那些条目。

    **名字相同的那两条合成一个节点**（工具的全名 = 执行者的名字）：那是同一个函数的
    两个身份，分成两个节点反而看不出它们是同一个东西。

    `full` 是**全名**——前端拿它去注册表里查这一条的详情（要不要批、能不能跑）。
    没有它，前端就只能拿短的显示名去猜，而短名天生会撞。
    """
    nodes: dict[str, dict[str, Any]] = {}

    def node(short: str, full: str) -> dict[str, Any]:
        # `kind` 说的是**它在清单里是什么**（`manifest.yaml` 的一条条目），
        # `entries` 说它出现在哪几个列表里——**同一个名字可以既是工具又是执行者**，
        # 那是同一个东西的两个身份，所以它仍然是一个节点。
        return nodes.setdefault(short, {"kind": "entry", "name": short, "full": full,
                                        "entries": [], "nodes": []})

    for supply in registry.capabilities.all():
        if supply.package != package.id:
            continue
        for spec in supply.tools:
            node(spec.name.split(".", 1)[-1], spec.name)["entries"].append("tool")
    for item in registry.executors.all():
        if item.package != package.id:
            continue
        node(item.name.split(".", 1)[-1], item.name)["entries"].append("executor")
    return {"kind": "package", "name": package.id, "enabled": package.enabled,
            # `name` 是**身份**（目录名，引用用它），`label` 是**给人看的那个名字**
            # （清单里的 `name:`）。两者都在，因为一个都不能少：引用要稳定，
            # 而人认的是自己写的那个名字。
            "label": package.name or package.id,
            "path": shown(str(Path(package.path) / MANIFEST_NAME)) if package.path else "",
            # 清单里那句说明：它是**描述**，不是诊断——界面上要分得清这两件事
            "description": package.description,
            "nodes": [nodes[key] for key in sorted(nodes)]}


def _dispatches(dispatches: Any) -> list[dict[str, Any]]:
    if dispatches is None:
        return []
    return [{"occurrence_key": item.occurrence_key, "schedule_id": item.schedule_id,
             "task_id": item.task_id, "status": item.status, "detail": item.detail,
             "updated_at": item.updated_at}
            for item in dispatches.recent(limit=50)]
