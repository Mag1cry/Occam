"""接入面：**前端只有这几个口**。

- `GET /api/state` 是**唯一的事实入口**——它读这个，不拼事实
- `POST /api/command` 是**唯一能改变什么的口**——命令面之外没有别的路
- `GET /api/events` 只标记**谁脏了**，状态一律来自重读

边界钉在这里：权限挂成 **router 级依赖**（所以不存在的路径仍然是 404），
拒绝答 **401 + `WWW-Authenticate`**（浏览器看不到那个头就不会弹登录框），
错误码**按类型映射**（不是"其余一切 → 400"）。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.web import streaming
from tests.support.newtree import application

LOCAL = ("127.0.0.1", 51234)
REMOTE = ("8.8.8.8", 51234)   # 真的公网地址（203.0.113.x 在 ipaddress 里算"私有"）


@pytest.fixture
def app(tmp_path: Path, monkeypatch):
    # 事实流是"一直读下去"的那种响应，而它的心跳是 15 秒一次——测试里把它调快，
    # 不然读两条就得等一个心跳周期。
    monkeypatch.setattr("src.web.streaming.HEARTBEAT_SECONDS", 0.05)
    application_ = application(tmp_path)
    yield application_
    application_.shutdown()


@pytest.fixture
def client(app):
    with TestClient(app.app, client=LOCAL) as made:
        yield made


@pytest.fixture
def remote_client(app):
    with TestClient(app.app, client=REMOTE) as made:
        yield made


def auth(app) -> dict[str, str]:
    return {"Authorization": f"Bearer {app.token}"}


# ── 谁能进来

def test_局域网直接读得到状态(client):
    assert client.get("/api/state").status_code == 200


def test_外网没有凭据就是_401(remote_client):
    response = remote_client.get("/api/state")

    assert response.status_code == 401
    assert "Bearer" in response.headers.get("www-authenticate", ""), \
        "没有这个头，浏览器不会弹登录框"


def test_外网带了凭据就同权(app, remote_client):
    assert remote_client.get("/api/state", headers=auth(app)).status_code == 200


def test_凭据不对还是_401(app, remote_client):
    # 头里只能是 ASCII，所以"错的凭据"也得是 ASCII
    assert remote_client.get("/api/state",
                             headers={"Authorization": "Bearer nope"}).status_code == 401


def test_不存在的路径是_404_不是_401(remote_client):
    """**权限是 router 级依赖，不是中间件。** 中间件会把它变成 401——
    那既改变了对"这个接口不存在"的答复，也让故意不存在的路由看起来像认证问题。
    """
    assert remote_client.get("/api/没有这个").status_code == 404


# ── 事实入口

def test_快照里有四个列表(client):
    state = client.get("/api/state").json()

    # 能力列表是**供给**级的：一台供给挂着它的工具。
    supplies = {item["name"]: item for item in state["registry"]["capabilities"]}
    assert {spec["tool_id"] for spec in supplies["echo"]["tools"]} == {"echo.say", "echo.boom"}
    assert {item["name"] for item in state["registry"]["executors"]} >= {"echo.run", "guard.run"}
    assert [item["name"] for item in state["registry"]["providers"]] == ["deepseek"]
    assert [item["name"] for item in state["registry"]["schedules"]] == ["echo.daily"]
    assert [item["id"] for item in state["registry"]["packages"]] == \
        ["echo", "guard", "pigeon", "slow"]


def test_配置舱是声明文件那棵树(client):
    """**同一份事实的另一种组织**：注册表按类型排（判决要那样），这一份按文件排。

    **前端只出渲染器，结构全从这儿来**——所以形状要钉死：目录、声明文件、
    以及每个节点"我是哪个文件里的哪一条全名"。
    """
    console = client.get("/api/state").json()["console"]

    # 两个下划线目录由**后端**说（`loader.py` 里那两条常量）：前端不该知道
    # `_providers` 这个名字，更不该自己拼路径
    assert [node["name"] for node in console] == \
        ["_providers", "_schedules", "echo", "guard", "pigeon", "slow"]

    providers, schedules, echo = console[0], console[1], console[2]
    assert providers["kind"] == "directory" and providers["path"] == "_providers"
    assert providers["nodes"][0]["path"] == "_providers/deepseek.yaml"
    assert [model["name"] for model in providers["nodes"][0]["nodes"]] == ["deepseek-v4-pro"]

    # **文件名和声明里的名字可以不同**：`echo-daily.yaml` 里写着 `name: echo.daily`。
    # 路径是**读出来**的，不是按名字拼的——拼出来的是个不存在的文件，
    # 而界面上会写着"这份声明在这儿"，用户照着去找，找不到
    assert schedules["nodes"][0]["path"] == "_schedules/echo-daily.yaml"
    assert schedules["nodes"][0]["name"] == "echo.daily"
    assert schedules["nodes"][0]["cron"] == "0 8 * * *"

    assert echo["kind"] == "package" and echo["path"] == "echo/manifest.yaml"
    # **每个节点都有 `kind`**：前端靠它挑渲染器，一个例外都要在那边写一个 if。
    # 短名给人看，`full` 给程序用——拿它去四个列表里查这一条的详情（要不要批、能不能跑）
    assert [(node["kind"], node["name"], node["full"], node["entries"])
            for node in echo["nodes"]] == [
        ("entry", "boom", "echo.boom", ["tool"]),
        ("entry", "run", "echo.run", ["executor"]),
        ("entry", "say", "echo.say", ["tool"]),
    ]
    # 叶子也得有 `nodes`：前端遍历不用到处判"有没有这一格"
    assert all(node["nodes"] == [] for node in echo["nodes"])


def test_一台好好的供给_那一格是空的(client):
    """`detail` 答的是**"为什么不能用"**，所以能用的时候必须是空的。

    它会一路印到界面上：前端拿它当扩展节点的描述（`gateway.ts` 里 `supply.detail`）。
    少写一个判断的代价不是"多一句话"，是**一台好好的供给挂着一句"它起不来"**——
    一句假话，而且长得像真的。
    """
    state = client.get("/api/state").json()

    healthy = [item for item in state["registry"]["capabilities"] if item["usable"]]
    assert healthy, "夹具里至少该有一台好供给"
    assert [item["name"] for item in healthy if item["detail"]] == []


def test_关着的包也在列表里_答已下线(client, app):
    """**列表是前端渲染的唯一依据。** 滤掉关着的，前端就只能自己另编一套概念。"""
    path = app.settings.extensions / "echo" / "manifest.yaml"
    path.write_text(path.read_text(encoding="utf-8") + "\nenabled: false\n", encoding="utf-8")
    app.facade.submit("set_enabled", {"name": "echo", "enabled": False})

    state = client.get("/api/state").json()

    offline = [item for item in state["registry"]["capabilities"]
               if item["package"] == "echo" and item["status"] == "offline"]
    assert offline, "它该以「已下线」的样子留在列表里"
    assert offline[0]["detail"] == "它关着"
    console = [group for group in state["console"] if group["name"] == "echo"]
    assert console and console[0]["enabled"] is False


def test_快照里带得回历史的引用(app):
    """**一条历史引用读不回来，不该让整个界面打不开。** 它答三态里的一种。"""
    created = app.facade.submit("create_task", {"summary": "x", "executor_ref": "echo.run"})
    with TestClient(app.app, client=LOCAL) as client:
        state = client.get("/api/state").json()

    task = [item for item in state["tasks"] if item["task_id"] == created.data["task_id"]][0]
    assert task["executor"]["state"] == "resolvable"
    assert task["executor"]["readable"] is True


def test_快照里的事件是有限的(client):
    """**"每个 Task 的全部事件装进响应"会大到前端接不住**，所以有条上限。"""
    from src.web.snapshot import RECENT_EVENTS

    assert RECENT_EVENTS > 0


# ── 命令面

def test_命令改状态_回的是谁脏了(client):
    response = client.post("/api/command", json={
        "command": "create_task",
        "payload": {"summary": "跑一次", "executor_ref": "echo.run", "task_ref": "hello.txt"}})

    body = response.json()
    assert response.status_code == 200
    assert body["dirty"].startswith("task:")
    assert body["data"]["task_id"]


def test_不认识这条命令_当场拒(client):
    response = client.post("/api/command", json={"command": "飞", "payload": {}})

    assert response.status_code == 400
    assert "没有这条命令" in response.json()["error"]


def test_引用了不存在的_Task_是_404(client):
    response = client.post("/api/command", json={"command": "start_task",
                                                 "payload": {"task_id": "task-没有"}})

    assert response.status_code == 404


def test_缺必填那一栏_是_400(client):
    response = client.post("/api/command", json={"command": "create_task",
                                                 "payload": {"summary": "x"}})

    assert response.status_code == 400


def test_改开关是改声明_不是改库(client, app):
    """**没有配置状态库。** 关掉一个东西 = 把它那张声明里那行改成 `enabled: false`。"""
    response = client.post("/api/command", json={
        "command": "set_enabled", "payload": {"name": "guard", "enabled": False}})

    assert response.status_code == 200
    text = (app.settings.extensions / "guard" / "manifest.yaml").read_text(encoding="utf-8")
    assert "enabled: false" in text
    definition = app.registry.executors.get("guard.run")
    assert definition is not None, "关着的也要登记——**登记 ≠ 可用**"
    assert definition.enabled is False
    assert app.registry.executors.can_run("guard.run") is False
    assert "关着" in app.registry.executors.why_not("guard.run")


def test_写声明要过校验_写坏了的东西落不了盘(client, app, tmp_path: Path):
    response = client.post("/api/command", json={
        "command": "manifest.write",
        "payload": {"target": "schedule", "name": "echo-daily", "field": "cron",
                    "value": "每天八点"}})

    assert response.status_code == 400
    before = (app.settings.extensions / "_schedules" / "echo-daily.yaml").read_text("utf-8")
    assert "每天八点" not in before, "校验没过的东西不许落盘"


def test_删包之前先看有没有历史引用(client, app):
    """**删包 = 删目录，不可撤销。** 有 Task 指着它就不许删，并把那几个 Task 列出来。"""
    client.post("/api/command", json={
        "command": "create_task",
        "payload": {"summary": "x", "executor_ref": "echo.run", "task_ref": "hello.txt"}})

    response = client.post("/api/command", json={
        "command": "manifest.delete", "payload": {"target": "package", "name": "echo"}})

    assert response.status_code == 400
    assert "引用" in response.json()["error"]
    assert (app.settings.extensions / "echo" / "manifest.yaml").is_file()


def test_按批准不用自己送决策依据(client, app):
    """**"谁批的"这句由接入面填。**

    内核那条命令要求 `decision_ref`（它是审批的证据，进事件链的 `external_ref`），
    而前端对它一无所知——它对调用方的身份没有概念。从前旧后端在路由上默认
    `"web-decision"` 兜着，新后端没有这一手，于是**批准按钮按下去是 400**。
    """
    from tests.support.newcore import ask_for_tool, start, stop_for_approval

    task = start(app.kernel, executor="echo.run")
    ask_for_tool(app.kernel, task)
    stop_for_approval(app.kernel, task)

    response = client.post("/api/command", json={"command": "approve",
                                                 "payload": {"task_id": task}})

    assert response.status_code == 200, response.text
    approved = [item for item in app.kernel.events(task) if item.event_type == "APPROVED"]
    assert approved, "批准这件事要落在链上"
    assert approved[-1].external_ref.startswith("web:"), "证据要说清是谁批的"


def test_前端自己送的那句证据不被覆盖(client, app):
    """前端真要自己说一句（脚本、别的客户端），就听它的。"""
    from tests.support.newcore import ask_for_tool, start, stop_for_approval

    task = start(app.kernel, executor="echo.run")
    ask_for_tool(app.kernel, task)
    stop_for_approval(app.kernel, task)

    client.post("/api/command", json={
        "command": "deny", "payload": {"task_id": task, "decision_ref": "脚本: 巡检结论"}})

    denied = [item for item in app.kernel.events(task) if item.event_type == "DENIED"]
    assert denied[-1].external_ref == "脚本: 巡检结论"


def test_重试恢复_再问一次但不重复记账(client, app):
    """「重试恢复」那一格提交的**也是 `approve`**（它的 type 就是 approve）。

    它存在的场合是：批准记下了，但控制侧那次自动恢复没成，任务卡在 `paused`。
    再按一次 = 再问一次恢复；**决定不会重复记**——内核那条命令在"已经是目标值"
    时是空转（`core/capability.py`），链上只有一条 APPROVED。
    """
    from src.core.capability import Approve
    from tests.support.newcore import ask_for_tool, start, stop_for_approval

    task = start(app.kernel, executor="echo.run")
    ask_for_tool(app.kernel, task)
    stop_for_approval(app.kernel, task)
    # 直接在内核里记下"批准"：**不经过门面**，模拟"恢复那一步没做成"
    app.kernel.approve(Approve(task_id=task, decision_ref="先前那次"))

    response = client.post("/api/command", json={"command": "approve",
                                                 "payload": {"task_id": task}})

    assert response.status_code == 200, response.text
    events = [item.event_type for item in app.kernel.events(task)]
    assert events.count("APPROVED") == 1, "重试不追加第二个决定"
    # 而它**真的又试了一次恢复**（这就是这一格存在的理由）
    assert response.json()["data"]["auto_resume"]["status"] in {"resumed", "failed", "skipped"}


def test_没有待处理的审批_当场说清楚(client, app):
    """在**不该按**的时候按（任务已经跑起来了），要答一句人话，不是静默成功。"""
    from tests.support.newcore import start

    task = start(app.kernel, executor="echo.run")

    response = client.post("/api/command", json={"command": "approve",
                                                 "payload": {"task_id": task}})

    assert response.status_code == 400
    assert "审批" in response.json()["error"]


def test_删一个没人用的包_删掉了(client, app):
    client.post("/api/command", json={
        "command": "manifest.create",
        "payload": {"target": "package", "name": "temp",
                    "data": {"id": "temp", "name": "临时的"}}})

    response = client.post("/api/command", json={
        "command": "manifest.delete", "payload": {"target": "package", "name": "temp"}})

    assert response.status_code == 200
    assert not (app.settings.extensions / "temp").exists()


# ── 事实流
#
# **它的身体是"一直读下去"的**，而两种测试客户端都要等整个响应体收完才回话
# （同步 `TestClient` 直接把它收进一个 BytesIO）。所以分两层测：
# 身体直接读生成器（游标、心跳、配对都在那里），路由那一层用一个**已经关停的流**
# 证明它挂上了、要鉴权、且答的是 `text/event-stream`。

def _take(generator, count: int) -> list[str]:
    from itertools import islice

    return list(islice(generator, count))


def test_没事件的时候发心跳(app):
    """**没有事件也要说话，而且必须是看得见的一帧。**

    注释行（`: 心跳`）浏览器按 SSE 的规矩**不交给 JS**，所以它挡得住代理超时，
    却让前端那条"多久没听见后端说话"的看门狗一直判你断线——**空闲的流会被
    无休止重连**。心跳也不能带 `id:`：带了就是推进游标，把该读的那段跳过去。
    """
    moments = _take(streaming.frames(app.audit, app.audit.latest(), heartbeat=0.0), 2)

    assert all(item == f"data: {streaming.HEARTBEAT_FRAME}\n\n" for item in moments)
    assert all(_payload(item)["heartbeat"] is True for item in moments)


def test_流里带的是游标和谁脏了(app):
    app.audit.record(command="create_task", principal="external", outcome="ok",
                     subject_ref="task:abc")

    frame = _take(streaming.frames(app.audit, 0, heartbeat=0.0), 1)[0]

    assert _seq(frame) > 0, "带 `id:` 是**下一次重连要带回来的游标**"
    payload = _payload(frame)
    assert payload["subject_ref"] == "task:abc"
    assert "status" not in payload, "推的是「脏了」，不是「它现在是什么」"


def test_带了游标就从它之后接着读(app):
    app.audit.record(command="a", principal="external", outcome="ok", subject_ref="task:1")
    first = _seq(_take(streaming.frames(app.audit, 0, heartbeat=0.0), 1)[0])
    app.audit.record(command="b", principal="external", outcome="ok", subject_ref="task:2")

    later = _take(streaming.frames(app.audit, first, heartbeat=0.0), 1)[0]

    assert _seq(later) > first


def _seq(frame: str) -> int:
    head = frame.splitlines()[0]
    assert head.startswith("id: "), frame
    return int(head[len("id: "):])


def _payload(frame: str) -> dict:
    for line in frame.splitlines():
        if line.startswith("data: "):
            return json.loads(line[len("data: "):])
    raise AssertionError(frame)


def test_重连认的是_Last_Event_ID_那个头():
    """`EventSource` 自动重连带的是**请求头**。只认查询参数的话，
    前端第一次重连就会**从 0 全量重放**。
    """
    assert streaming.cursor_from({"Last-Event-ID": "7"}, {}) == 7
    assert streaming.cursor_from({"last-event-id": "9"}, {}) == 9
    assert streaming.cursor_from({}, {"cursor": "3"}) == 3, "手动指定游标仍然算"
    assert streaming.cursor_from({"Last-Event-ID": "5"}, {"cursor": "3"}) == 5, "头优先"
    assert streaming.cursor_from({}, {}) == 0
    assert streaming.cursor_from({"Last-Event-ID": "不是数字"}, {}) == 0


def test_事实流那条路由挂上了_而且也要鉴权(app):
    app.stop.set()                       # 让它当场收尾，不然它永远不结束
    try:
        local = _local(app).get("/api/events")
        assert local.status_code == 200
        assert local.headers["content-type"].startswith("text/event-stream")

        remote = _remote(app).get("/api/events")
        assert remote.status_code == 401
    finally:
        app.stop.clear()


# ── 把一份正文放进工作区（表单上那个「选择文件」）

def test_选中的文件进工作区_答回来的是相对路径(client, tmp_path: Path):
    """浏览器只给内容和名字、**不给路径**，而 `task_ref` 要的正是相对路径——
    所以这一条的形状就是"存进来 + 把落点答回去"。"""
    response = client.post("/api/workspace/files",
                           json={"name": "周报.md", "text": "# 这周的活\n"})

    assert response.status_code == 200
    assert response.json()["path"] == "周报.md"
    # 正文真的落地了，而且 `read` 读得到（同一个目录、同一套规矩）
    assert (tmp_path / "workspace" / "周报.md").read_text(encoding="utf-8") == "# 这周的活\n"


def test_重名不覆盖_加序号(client, tmp_path: Path):
    """用户点的是"选一份正文"，不是"覆盖那份正文"——被盖掉的可能是某条日程正指着的东西。"""
    first = client.post("/api/workspace/files", json={"name": "a.md", "text": "第一份"})
    second = client.post("/api/workspace/files", json={"name": "a.md", "text": "第二份"})

    assert first.json()["path"] == "a.md"
    assert second.json()["path"] == "a-2.md"
    assert (tmp_path / "workspace" / "a.md").read_text(encoding="utf-8") == "第一份"


def test_文件只取名字_不落进别处(client, tmp_path: Path):
    """浏览器给的就是个文件名，但"防手滑"在这棵树上是一贯的。"""
    body = client.post("/api/workspace/files",
                       json={"name": "../../跑到外面.md", "text": "x"}).json()

    assert body["path"] == "跑到外面.md"
    assert not (tmp_path.parent / "跑到外面.md").exists()


def test_太大的东西不收(client):
    """这里放的是**文本**——几十兆从这儿进来只说明选错了文件，早点说比晚点说好。"""
    response = client.post("/api/workspace/files",
                           json={"name": "big.md", "text": "x" * 1_000_001})

    assert response.status_code == 400
    assert "上限" in response.json()["error"]


def test_这个口也要鉴权(remote_client):
    assert remote_client.post("/api/workspace/files",
                              json={"name": "a.md", "text": "x"}).status_code == 401


# ── 发布形态：界面和接口同一个进程端出来

def test_没设前端目录时根路径就是_404(app):
    """开发形态：界面归 vite dev（5173），后端一棵多余的路由都不多。"""
    assert _local(app).get("/").status_code == 404


def test_设了前端目录就把界面挂到根上_接口照旧(tmp_path: Path):
    """发布形态：**一个进程、一个端口**。

    后端一条 CORS 头都不加（"前端必须和 `/api` 同源"），所以要么反代、要么挂这儿。
    这一条钉三件事：静态目录出得来、`/api/*` **仍然先命中**（挂载排在路由之后）、
    打错的接口**不会**被兜底成一页 HTML。
    """
    web = tmp_path / "dist"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><title>OCC</title>", encoding="utf-8")
    (web / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")

    application_ = application(tmp_path, web_dir=web)
    try:
        client = _local(application_)
        page = client.get("/")
        assert page.status_code == 200
        assert "OCC" in page.text
        assert client.get("/assets/app.js").status_code == 200

        # 接口照旧：`/api/*` 先注册就先命中
        assert client.get("/api/state").status_code == 200
        # 不存在的接口仍是 404——兜底成一页 HTML 会比 404 难查得多
        assert client.get("/api/nope").status_code == 404
    finally:
        application_.shutdown()


def test_前端目录写错了不挡启动_但要说出来(tmp_path: Path, capsys):
    """设了但目录不在：**不挂，也不静默**——"我明明设了"查不出原因最难受。"""
    application_ = application(tmp_path, web_dir=tmp_path / "并没有这个目录")
    try:
        assert _local(application_).get("/").status_code == 404
        assert "前端目录不在" in capsys.readouterr().err
    finally:
        application_.shutdown()


def _local(app):
    return TestClient(app.app, client=LOCAL)


def _remote(app):
    return TestClient(app.app, client=REMOTE)


# ── 手写的配置：`config/.env`

def test_config_里的_env_读得进来(tmp_path: Path, monkeypatch):
    """**人写的东西放 config、程序写的放 data**（`settings.py` 那两张表）。

    这个函数会改进程的环境，所以它只在**入口**（`serve.py::_assembly`）被调——
    塞进 `Settings.from_env()` 的话，任何跑测试的手一抖就会把开发机上真实的凭据
    灌进来。
    """
    from src.app.settings import load_env_file

    (tmp_path / "config").mkdir()
    (tmp_path / "config" / ".env").write_text(
        "OCC_PROBE=from-config\n# 注释不算\nOTHER=1\n", encoding="utf-8")
    monkeypatch.delenv("OCC_PROBE", raising=False)
    monkeypatch.delenv("OTHER", raising=False)

    added = load_env_file(tmp_path)

    assert sorted(added) == ["OCC_PROBE", "OTHER"]
    assert os.environ["OCC_PROBE"] == "from-config"


def test_环境变量优先_文件不覆盖它(tmp_path: Path, monkeypatch):
    """`$env:OCC_NEXT_HOST='0.0.0.0'; uv run …` 这种临时覆盖**必须永远赢**——
    不然调试的时候你会怀疑自己在改哪个值。"""
    from src.app.settings import load_env_file

    (tmp_path / "config").mkdir()
    (tmp_path / "config" / ".env").write_text("OCC_PROBE=from-file\n", encoding="utf-8")
    monkeypatch.setenv("OCC_PROBE", "from-env")

    added = load_env_file(tmp_path)

    assert added == []
    assert os.environ["OCC_PROBE"] == "from-env"


def test_没有那个文件也不算错(tmp_path: Path):
    from src.app.settings import load_env_file

    assert load_env_file(tmp_path) == []
