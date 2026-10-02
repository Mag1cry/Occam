"""网关的两半判决：**谁能进来**、**这个工具能不能跑**。

两半都是**默认拒绝**：规则只声明允许，没被任何规则允许就是拒绝。这里钉的是那几条
最容易在"顺手放宽一点"时丢掉的边界：

- 来源解析不了一律算外网；外网要凭据；凭据与局域网**同权**
- 审批是**显性声明**的，执行者只能往严的方向收紧
- 跨容器的引用有两个问题：**读得回来吗** / **能新建引用吗**——别合成一个
"""
from __future__ import annotations

from pathlib import Path

import pytest

from src.extensions.manifest import Schedule
from src.gateway.access.policy import (
    EXTERNAL, LAN, LOCAL, Caller, judge_caller, load_or_create_token,
)
from src.gateway.directory import Registry
from src.gateway.permission.decision import ALLOW, DENY, NEEDS_APPROVAL, Decision
from src.gateway.permission.judge import Requirement, classify, judge
from src.web import references
from tests.support.newtree import application


# ── 顺序器：只声明允许

def test_条件全成立就是允许():
    """**它不是"没被允许"**——条件都在、而且都成立，答案就是允许。"""
    assert judge([Requirement(True), Requirement(True)]).outcome == ALLOW


def test_任何一条不成立就用它自己的理由拒():
    decision = judge([Requirement(True), Requirement(False, "没写这一栏")])

    assert decision.outcome == DENY
    assert decision.reason == "没写这一栏"


def test_一条规则都没有就是默认值():
    """**默认拒绝**：没被任何规则允许，不需要有人显式禁止。"""
    assert judge([]).outcome == DENY
    assert judge([], default=ALLOW).outcome == ALLOW


def test_定性是第二步_只有显性声明能让人批():
    assert classify(approval_required=True).outcome == NEEDS_APPROVAL
    assert classify(approval_required=False).outcome == ALLOW


def test_判决只有三种_别的当场拒():
    with pytest.raises(ValueError):
        Decision("approved")


# ── 谁能进来

@pytest.mark.parametrize("host, level", [
    ("127.0.0.1", LOCAL),
    ("::1", LOCAL),
    ("192.168.1.9", LAN),
    ("10.0.3.4", LAN),
    ("8.8.8.8", EXTERNAL),
    ("不是我认识的地址", EXTERNAL),          # 解析不了 → 外网
    ("", EXTERNAL),
])
def test_来源分级(host, level):
    assert Caller(host=host).level == level


def test_局域网直接放行_不用凭据():
    assert judge_caller(Caller(host="127.0.0.1"), token="秘密").outcome == ALLOW


def test_外网必须有凭据():
    assert judge_caller(Caller(host="8.8.8.8"), token="秘密").outcome == DENY
    assert judge_caller(Caller(host="8.8.8.8", token="秘密"), token="秘密").outcome == ALLOW
    assert judge_caller(Caller(host="8.8.8.8", token="猜的"), token="秘密").outcome == DENY


def test_凭据和局域网同权():
    """它是**授权的证明**，不是降级访问——真正的门是"从哪里来"。"""
    allowed = judge_caller(Caller(host="203.0.113.7", token="秘密"), token="秘密")

    assert allowed.outcome == ALLOW
    assert not allowed.needs_approval


def test_令牌生成一次之后一直用同一个(tmp_path: Path):
    """重启一次换一次令牌，等于让所有已经拿到它的人**静默失效**。"""
    path = tmp_path / "access-token.json"

    first = load_or_create_token(path)
    second = load_or_create_token(path)

    assert first and first == second


def test_令牌文件坏了就重新生成(tmp_path: Path):
    """半截写入是可恢复的，而"起不来"不是。"""
    path = tmp_path / "access-token.json"
    path.write_text("{ 这不是 json", encoding="utf-8")

    assert load_or_create_token(path)


# ── 这个工具能不能跑

@pytest.fixture
def app(tmp_path: Path):
    application_ = application(tmp_path)
    yield application_
    application_.shutdown()


def test_工具被声明过_而且这个执行者被允许(app):
    view = app.registry.view

    assert view.allows("echo.run", "echo.say").ok is True


def test_没被允许就是拒绝_默认拒绝(app):
    """`tools_from` 里没有它——**没有"默认谁都能调"这回事**。"""
    view = app.registry.view

    requirement = view.allows("echo.run", "guard.write")

    assert requirement.ok is False
    assert "tools_from" in requirement.reason


def test_没有这个工具_和_工具关着_要分开说(app, tmp_path: Path):
    """**两句话不同**：一个你写错了名字，一个那东西还在、只是关着。"""
    view = app.registry.view

    assert "没有这个工具" in view.allows("echo.run", "没有这个工具").reason

    # 把 echo 关掉：它从"能调"变成"已下线"，而**不是消失**
    path = app.settings.extensions / "echo" / "manifest.yaml"
    path.write_text(path.read_text(encoding="utf-8") + "\nenabled: false\n", encoding="utf-8")
    app.hotloader.refresh()

    assert references.resolve("supply", "echo", registry=app.registry).state == references.OFFLINE
    assert app.registry.capabilities.get("echo.say") is None


def test_审批看的是声明的地板(app, tmp_path: Path):
    assert app.registry.view.approval_for("echo.run", "echo.say") is False


def test_收紧只能更严(app, tmp_path: Path):
    """执行者**只能往严的方向动**：声明说不批的，它可以收紧成要批；反过来不行。"""
    path = app.settings.extensions / "echo" / "manifest.yaml"
    path.write_text(path.read_text(encoding="utf-8").replace(
        "tools_from: [echo]", "tools_from: [echo]\n    tighten: [echo.say]"), encoding="utf-8")
    app.hotloader.refresh()

    assert app.registry.view.approval_for("echo.run", "echo.say") is True


def test_看不见的清单_只给能用的(app, tmp_path: Path):
    """**worker 看得见什么**由 `tools_from` 决定——判决是另一回事（两个都要有）。"""
    specs = app.registry.view.visible_to("echo.run")

    assert [spec.name for spec in specs] == ["echo.boom", "echo.say"]
    assert all(spec.input_schema for spec in specs), "schema 是给模型看的那一份"


# ── 引用：两个问题各答一次

def test_引用三态(app, tmp_path: Path):
    assert references.resolve("executor", "echo.run", registry=app.registry).state == \
        references.RESOLVABLE
    assert references.resolve("executor", "没有这个", registry=app.registry).state == \
        references.UNKNOWN

    path = app.settings.extensions / "echo" / "manifest.yaml"
    path.write_text(path.read_text(encoding="utf-8") + "\nenabled: false\n", encoding="utf-8")
    app.hotloader.refresh()

    gone = references.resolve("executor", "echo.run", registry=app.registry)
    assert gone.state == references.OFFLINE
    assert gone.readable is True, "历史读得回来"
    assert gone.referable is False, "但不该被新建引用"


def test_基座没有模型_是已下线不是未知(tmp_path: Path):
    """**已下线和未知必须分得开**：一个能说清原因，一个只能承认不知道。"""
    from tests.support.newtree import write_package, SILENT_WORKER

    app = application(tmp_path)
    try:
        write_package(app.settings.extensions, "loop", "\n".join([
            "id: loop", "executors:", "  - name: loop.run", "    needs_llm: true",
            '    worker: {entrypoint: "worker.py:run"}', ""]), {"worker.py": SILENT_WORKER})
        app.hotloader.refresh()

        found = references.resolve("executor", "loop.run", registry=app.registry)

        assert found.state == references.OFFLINE
        assert "模型" in found.detail
    finally:
        app.shutdown()


def test_日程关着也答得出来(app):
    app.registry.schedules.replace((
        Schedule(name="x.daily", cron="0 8 * * *", task_ref="hello.txt", enabled=False),))

    found = references.resolve("schedule", "x.daily", registry=app.registry)

    assert found.state == references.OFFLINE
    assert found.readable is True


def test_供应商解析成终值_密钥只传名字(app):
    resolved = app.registry.providers.resolve({"provider": "deepseek", "name": "deepseek-v4-pro"})

    assert resolved["found"] is True
    assert resolved["base_url"] == "https://api.deepseek.com/v1"
    assert resolved["context"] == 128000
    assert "api_key" not in resolved or resolved.get("api_key") is None


def test_建一个空的登记处_什么都答未知():
    """**"只有一份"不是靠全局变量**：测试要一个干净的例子，得拿得到。"""
    empty = Registry()

    assert references.resolve("executor", "echo.run", registry=empty).state == references.UNKNOWN
