"""HTTP 路由。

每个路由只做三件事：**解析请求 → 翻译成网关命令 → 映射错误码**。业务流程一条都没有——
有的话它就该在网关或内核里。

## 权限**挂成 router 级依赖，不是中间件**

依赖跑在路由之后，所以不存在的路径仍然是 404。中间件会把它变成 401——那既改变了对
"这个接口不存在"的答复，也让故意不存在的路由看起来像认证问题。

`deny` 翻译成 **401 + `WWW-Authenticate`**：浏览器不看到那个头就不会弹登录框。

## 错误码按类型映射，不按"是不是异常"

旧代码的兜底是"其余一切 → 400"，于是**服务端的 bug 会被说成客户端的错**
（`sqlite3.OperationalError` 也被判成 400，前端于是去改它自己的请求）。
所以这里只映射内核那几种**说得清**的错，其余一律 500。

← 来自 web.py
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..core.errors import CommandRejected, Conflict, NotFound, OCCError
from . import references as references_module
from ..gateway.access.policy import Caller, judge_caller
from ..gateway.permission.principal import Principal, external
from . import snapshot as snapshot_module
from . import streaming


class CommandBody(BaseModel):
    """前端发来的那一条。**命令名和它的载荷**，别的什么都不带。"""

    command: str
    payload: dict[str, Any] = Field(default_factory=dict)


class WorkspaceFileBody(BaseModel):
    """一份正文：**文件名 + 正文本身**（见 `save_workspace_file` 那段说明）。"""

    name: str
    text: str


def create_app(*, facade: Any, kernel: Any, registry: Any, audit: Any,
               token: str = "", dispatches: Any = None, workers: Any = None,
               declarations: Any = None, executor_data: str = "",
               last_tool_result: Any = None,
               extensions_root: str = "", web_dir: str = "",
               save_task_input: Any = None,
               stop: Any = None, title: str = "OCC") -> FastAPI:
    app = FastAPI(title=title)

    def guard(request: Request) -> Principal:
        caller = Caller(host=request.client.host if request.client else "",
                        token=_presented(request))
        decision = judge_caller(caller, token=token)
        if not decision.allowed:
            raise HTTPException(status_code=401, detail=decision.reason,
                                headers={"WWW-Authenticate": 'Bearer realm="occ"'})
        return external(detail=f"{caller.level}@{caller.host}")

    router = APIRouter(dependencies=[Depends(guard)])

    @router.get("/api/state")
    def state() -> dict[str, Any]:
        """**前端唯一的事实入口。** 它读这个，不拼事实。"""
        return snapshot_module.snapshot(kernel=kernel, registry=registry, audit=audit,
                                        dispatches=dispatches, workers=workers,
                                        declarations=declarations, extensions=extensions_root)

    @router.post("/api/command")
    def command(body: CommandBody, who: Principal = Depends(guard)) -> dict[str, Any]:
        payload = dict(body.payload)
        if body.command in ("approve", "deny") and not payload.get("decision_ref"):
            # **"谁批的"这句该由接入面填**：内核那条命令要求它（它是审批的证据，
            # 进事件链的 `external_ref`），而前端自称"我批的"不算证据——
            # 它对调用方的身份一无所知。这里用**已经认证过的那个主体**。
            payload["decision_ref"] = f"web:{who.detail or who.kind}"
        outcome = facade.submit(body.command, payload, principal=who)
        return {"ok": True, "dirty": outcome.dirty, "decision": outcome.decision,
                "data": outcome.data}

    @router.get("/api/tasks/{task_id}")
    def read_task(task_id: str) -> dict[str, Any]:
        """一个 Task **现在是什么**，外加**它的结果**。

        结果不在内核里（ADR-008 只存 `result_ref`）：它归**执行者的包**，靠那个包的
        adapter 读回来。

        ## 没有 adapter 的执行者：两级回落

        **① 宿主手里那份工具返回值**（`tasks/controller.py` 的 `_tool_results`）。
        工具的返回值和执行者报上来的 `result_ref` **不是一回事**：`weather.collect`
        拿到的是整个 dict（城市/经纬度/温度/体感/湿度/风速/描述/图标…），而 worker
        只把它压成"杭州 阴 21.8°"一句话。那份细的一直在宿主手里（`pipeline.py`
        调用、`_answer_tool` 转给 worker），以前**转完就丢**。它最细，所以排第一。
        **但它活不过重启**——那是宿主的运行时记忆，不是台账。

        **② 链上那条 `COMPLETED` 的 `result_ref`**（`_declared_result`）。那是执行者
        **自己声明**的结果，经由 Task 的生命周期送进来的（收尾那一刻
        `_finish(Complete(result_ref=…))`）。重启之后 ① 就没了，靠它还有东西可看。
        代价是它按 ADR-008 是**不透明引用**——weather 恰好让它等于结果文本，别的包
        可能放一个 checkpoint id。这里**照原样交出去**，不替它解释。
        """
        task = kernel.get_task(task_id)
        payload: dict[str, Any] = {
            "task_id": task.task_id, "status": task.status, "summary": task.summary,
            "executor_ref": task.executor_ref, "state_version": task.state_version,
            "checkpoint_ref": task.checkpoint_ref,
            "output": None, "reason": "",
        }

        definition = registry.executors.get(task.executor_ref)
        if definition is None or definition.worker is None:
            payload["reason"] = f"没有这个执行者的定义: {task.executor_ref}"
        else:
            try:
                from ..extensions.executors import open_adapter

                adapter = open_adapter(definition.worker,
                                       registry.executor_config(definition), executor_data)
            except Exception as exc:                # noqa: BLE001 — 读不到就说原因
                adapter = None
                payload["reason"] = f"这个执行者的 adapter 用不了: {exc}"
            if adapter is None:
                payload["reason"] = payload["reason"] or (
                    "这个执行者不提供结果查询——结果归它的包，而它没有 adapter")
            else:
                try:
                    payload["output"] = adapter.read_result(task, executor_data)
                except Exception as exc:            # noqa: BLE001 — 包自己的错，原样带出去
                    payload["reason"] = f"读结果失败: {type(exc).__name__}: {exc}"

        if payload["output"] is None:
            # ① 宿主手里那份**原始**返回值——最细，但活不过重启
            value = last_tool_result(task_id) if last_tool_result else None
            if value is not None:
                payload["output"] = {"ok": True, "result": value}
                payload["reason"] = ""
            else:
                # ② 执行者自己在收尾时声明的那个结果引用——重启之后只剩它
                declared = _declared_result(kernel, task_id)
                if declared:
                    payload["output"] = {"ok": True, "text": declared}
                    payload["reason"] = ""
        return payload

    @router.get("/api/tasks/{task_id}/agent-audit")
    def read_agent_audit(task_id: str) -> dict[str, Any]:
        """这个 Task 的**执行过程**：模型说了什么、要了哪些工具、成没成。

        和结果一样**按需读**——它是执行者外围的一份消息序列，塞进每次刷新都重拉的
        快照不合适。

        `read_audit` 是 adapter 上**可选**的那一格（必填只有 `checkpoint_exists` /
        `read_result`），所以"读不到"有两种，**必须分开说**，不拿空数组冒充
        "没有调用过工具"：

        | 什么样的执行者 | 答什么 |
        | --- | --- |
        | 智能体（adapter 实现了 `read_audit`） | `kind: "agent"` + 逐条调用与轮次 |
        | 固定代码（根本没有 adapter） | `kind: "plain"` + "它只有一次输入一次输出" |

        ## `kind` 为什么由这里算，不让前端自己推

        前端手里另有一份执行者列表（快照里的 `executors[].type`），它**推得出**同样的
        结论——但那是**第二条推导路径**，而两条路径会漂开：`mock/snapshot.ts` 里所有
        执行者都写着 `type: 'worker'`（没有一个是智能体），于是前端推出来的答案是
        "全都是固定代码"，多卡审计一次都画不出来。这里查的就是同一个注册表，
        **判的人就是知道的人**，没有第二份可能漂开的说法。

        `plain` 说的是"画单卡（输入 → 输出）"，**不是**"这个执行者是固定代码"的断言：
        执行者的定义都找不到时也答 `plain`——那会儿我们确实只有一次输入一次输出可看。
        """
        task = kernel.get_task(task_id)
        definition = registry.executors.get(task.executor_ref)
        if definition is None or definition.worker is None:
            return _no_audit(f"没有这个执行者的定义: {task.executor_ref}")
        try:
            from ..extensions.executors import open_adapter

            adapter = open_adapter(definition.worker,
                                   registry.executor_config(definition), executor_data)
        except Exception as exc:                    # noqa: BLE001 — 读不到就说原因
            return _no_audit(f"这个执行者的 adapter 用不了: {exc}")
        if adapter is None:
            # **固定代码的那一种**：跑完就是一次输入一次输出，没有"过程"可读
            return _no_audit("这个执行者是固定代码，没有可读的执行过程——它只有一次输入一次输出")
        reader = getattr(adapter, "read_audit", None)
        if reader is None:
            # 有 adapter 但没有这一格：读结果读得到，读过程读不到——仍旧只有单卡
            return _no_audit("这个执行者的 adapter 没有提供审计读取")
        try:
            payload = dict(reader(task, executor_data))
        except Exception as exc:                    # noqa: BLE001 — 包自己的错，原样带出去
            # **它是智能体**（有 `read_audit`），只是这一次没读成——这和"没有过程"
            # 是两件事，`kind` 要说对，界面才会去说"读不到"而不是画一张单卡
            return _no_audit(f"读审计失败: {type(exc).__name__}: {exc}", kind="agent")
        payload["kind"] = "agent"
        return payload

    @router.post("/api/workspace/files")
    def save_workspace_file(body: WorkspaceFileBody) -> dict[str, Any]:
        """把一份正文放进工作区，**返回它的相对路径**——表单上那个「选择文件」。

        ## 为什么是"存进来"而不是"报个路径"

        浏览器里的系统对话框**只给文件内容和名字，不给路径**（`File.path` 只有
        桌面壳里才有），而 `task_ref` 要的正是**工作区里的相对路径**。所以这条路的
        形状只能是：你选一份 → 它进工作区 → 把落点填回那一格。

        正文是**文本**（`read` 读的就是 utf-8），所以走 JSON 而不走 multipart：
        不必为此多一个依赖，而"这里放的是文本"也因此是个说得清的契约（超了会说）。

        **不覆盖**：重名加序号，答回来的 `path` 就是真实落点——界面上那一格填的是
        它，用户看得见自己拿到的是哪一份。

        ## 那只手是**递进来的**（`save_task_input`）

        写工作区的函数住在 `tasks/inputs.py`，而 **`web/` 不许 import `tasks/`**
        （`tests/test_layering.py` 那条边界：起进程、终止进程是那边的事）。
        所以装配期把它递进来，和 `last_tool_result` 同一条规矩——接入面只管把它
        端出去，不自己伸手去够。
        """
        if save_task_input is None:
            raise CommandRejected("这个宿主没有接上工作区写入")
        return {"path": save_task_input(body.name, body.text)}

    @router.get("/api/objects/{ref:path}")
    def resolve_object(ref: str) -> dict[str, Any]:
        """**一个引用还读得回来吗**——三态（ADR-024）。

        `ref` 形如 `executor:weather.collect` / `supply:echo` / `provider:deepseek`。
        认不出来的引用**不报错**：`unknown` 就是那个问题的答案（系统不知道它是什么）。
        """
        kind, _, name = ref.partition(":")
        found = references_module.resolve(kind, name or ref, registry=registry)
        return {"kind": found.kind, "name": found.name, "state": found.state,
                "detail": found.detail, "readable": found.readable,
                "referable": found.referable}

    @router.get("/api/events")
    def events(request: Request) -> StreamingResponse:
        """事实流：**只标记谁脏了**，状态一律来自 `GET /api/state`（ADR-031）。"""
        cursor = streaming.cursor_from(request.headers, request.query_params)
        return StreamingResponse(
            streaming.frames(audit, cursor, stop=stop),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                     "Connection": "keep-alive"},
        )

    app.include_router(router)

    for error, status in ((NotFound, 404), (Conflict, 409),
                          (CommandRejected, 400), (OCCError, 400),
                          (ValueError, 400), (KeyError, 404)):
        app.add_exception_handler(error, _handler(status))

    _mount_web(app, web_dir)
    return app


def _mount_web(app: FastAPI, web_dir: str) -> None:
    """把前端构建产物挂在 `/` 上——**发布形态就是一个进程**。

    ## 为什么是同源、为什么挂在这儿

    后端**一条 CORS 头都不加**（`web/README` 那条："前端必须和 `/api` 同源"），
    所以两种形态里选一个：反代，或者这里挂。本机单用户 ⇒ 挂在这儿。

    **挂在 API 路由之后**——Starlette 按注册顺序匹配，`/api/*` 先注册就先命中；
    反过来的话 `Mount("/")` 会把所有请求都吃掉，接口全成 404。

    ## 只挂一个静态目录，不做 history fallback

    这个前端**只有一个页面**（没有 router，"在哪个场景"是内存里的状态，不是 URL），
    所以 `html=True`（目录请求给 `index.html`）就够了。加一条"任何未知路径都回
    index.html"的兜底反而会把打错的 `/api/xxx` 变成一页 HTML——那比 404 难查得多。

    `web_dir` 空或者目录不在时**什么都不挂**：开发形态（vite dev:5173）就是这个
    样子，`/` 是 404，接口照常。设了但目录不在要说出来，不然"我明明设了"会变成一个
    查不出原因的空白页。
    """
    if not web_dir:
        return
    directory = Path(web_dir)
    if not directory.is_dir():
        print(f"[接入] 前端目录不在，没有挂：{directory}", file=sys.stderr)
        return
    app.mount("/", StaticFiles(directory=str(directory), html=True), name="web")


def _declared_result(kernel: Any, task_id: str) -> str:
    """执行者**自己声明**的结果引用：链上那条 `COMPLETED` 的 `result_ref`；没有就是空串。

    **是"声明"，不是"内容"**——ADR-008 说内核只存引用，所以这里拿到的可能就是一个
    不透明字符串（`weather.collect` 恰好让它等于结果文本）。调用方要说清这一点，
    别把它当成"内核知道结果是什么"。

    取**最后一条**：状态机保证一个 Task 只完成一次，但按顺序取最后一条比"假设只有
    一条"稳，而且不多花什么。
    """
    try:
        events = kernel.events(task_id)
    except Exception:                              # noqa: BLE001 — Task 没了就是没有
        return ""
    for event in reversed(events):
        if event.event_type == "COMPLETED":
            return str(event.payload.get("result_ref") or "")
    return ""


def _no_audit(reason: str, *, kind: str = "plain") -> dict[str, Any]:
    """读不到审计时的答复。

    **形状和读得到时一样**（`available` / `kind` / `source` / `read_at` / `calls`
    一个不少），所以前端不必为"读不到"另写一套解析；差别只在 `available` 和那句
    `reason`。

    `calls` 给空数组而不是省略：**"没有调用过"和"读不到"是两件事**，
    少一个键会让前端把两者混起来。
    """
    return {"available": False, "kind": kind, "source": "",
            "read_at": datetime.now(timezone.utc).isoformat(),
            "calls": [], "reason": reason}


def _presented(request: Request) -> str:
    """凭据从哪来：`Authorization: Bearer`，或者查询参数（SSE 带不了头）。"""
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return str(request.query_params.get("token") or "")


def _handler(status: int):
    async def handler(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=status,
                            content={"ok": False, "error": str(exc),
                                     "error_type": type(exc).__name__})
    return handler
