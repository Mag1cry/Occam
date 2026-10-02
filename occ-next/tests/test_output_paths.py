"""**输出路径与回来那一步**：通道投递、按钮回传、点回变成命令。

一条输出要送到外面去，外面的动作要变成一条带证据的命令——这条链上有三处最容易
说错，这几条用例钉的就是它们：

- **投递**：送过的不重发（事件每响一次就重发一张卡片，是这套东西最烦人的失败方式）、
  正文里只有引用不搬事实；
- **卡片上带什么**：按钮里是**这一刻的指纹**（旧卡片因此自动作废）——它是回来那一步
  唯一的凭据，**不带签名链接**（那条路已经删了，理由见 `gateway/output/callback.py`）；
- **回来**：证据写的是**谁点的**（`channel:<who>`），不假装是本机操作员。
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from src.gateway.output.output import Output, OutputAction
from src.gateway.output.paths import ChannelPath
from tests.support.newtree import application, wait_for_status

APPROVAL = Output(
    ref="task:task-1:approval", kind="approval", target_ref="task:task-1",
    title="部署生产环境", summary="要调用 `deploy.production`",
    actions=(OutputAction(ref="approve", label="批准", command="approve"),
             OutputAction(ref="deny", label="拒绝", command="deny")),
)


class FakeChannel:
    """一条只记账的通道。**它让"送了几张卡片"变成一件看得见的事。**"""

    def __init__(self) -> None:
        self.cards: list[dict] = []
        self.who = "ou_magic"

    def enabled(self) -> bool:
        return True

    def send_text(self, text: str) -> dict:
        self.cards.append({"text": text})
        return {"ok": True}

    def send_card(self, card: dict) -> dict:
        self.cards.append(card)
        return {"ok": True}


def fake_kernel(fingerprint: str = "fp-1"):
    return SimpleNamespace(get_task=lambda task_id: SimpleNamespace(
        pending_fingerprint=fingerprint, task_id=task_id))


# ── 投递

def test_送过的不重发():
    """事实每响一次就重发一张卡片，是这套东西最烦人的失败方式。"""
    channel = FakeChannel()
    path = ChannelPath(channel, kernel=fake_kernel())

    path.deliver(APPROVAL)
    path.deliver(APPROVAL)                     # 同一条又响了一次

    assert len(channel.cards) == 1


def test_卡片上带的是这一刻的指纹_不是链接():
    """按钮里只有**意图**（动作 + 这一刻的指纹 + 摘要），没有地址、没有令牌——
    回来那条路是**平台把点击推回给我们**（长连接），不靠任何人点开一个链接。"""
    channel = FakeChannel()
    path = ChannelPath(channel, kernel=fake_kernel("fp-9"))

    path.deliver(APPROVAL)

    card = channel.cards[0]
    # 中性卡：没有正文，只有引用和一句话
    assert card["ref"] == APPROVAL.ref
    assert card["lines"] == ["要调用 `deploy.production`"]
    values = [action["value"] for action in card["actions"]]
    assert [value["action"] for value in values] == ["approve", "deny"]
    assert all(value["fingerprint"] == "fp-9" for value in values)
    assert all(value["task_id"] == "task-1" for value in values)
    # **摘要要跟着走**：回调体里不带原卡片，点完原地换卡时要靠它认出是哪件事
    assert all(value["summary"] == "要调用 `deploy.production`" for value in values)
    assert all("url" not in action for action in card["actions"])


def test_结果那一类不主动送():
    """结果归内核，外面要看就去读。今天需要"推"的只有审批：**它卡着整条链**。"""
    channel = FakeChannel()
    path = ChannelPath(channel, kernel=fake_kernel())

    path.deliver(Output(ref="task:t1:result", kind="result", target_ref="task:t1",
                        title="跑完了", summary=""))

    assert channel.cards == []


def test_一条通道炸了_别的照送():
    class Broken(FakeChannel):
        def send_card(self, card: dict) -> dict:
            raise RuntimeError("飞书连不上")

    from src.gateway.output.paths import deliver_all

    good = FakeChannel()
    receipts = deliver_all(
        [ChannelPath(Broken(), kernel=fake_kernel()),
         ChannelPath(good, kernel=fake_kernel())],
        APPROVAL)

    assert [item["ok"] for item in receipts] == [False, True]
    assert "飞书连不上" in receipts[0]["error"]
    assert len(good.cards) == 1


# ── 回来

def 停在待批(app) -> str:
    task_id = app.facade.submit("create_task", {
        "summary": "守卫", "executor_ref": "guard.run",
        "task_ref": "hello.txt"}).data["task_id"]
    app.facade.submit("start_task", {"task_id": task_id})
    wait_for_status(app.kernel, task_id, "paused")
    return task_id


def test_按钮点一下就成了一条带证据的命令(tmp_path: Path):
    """**整条链走一遍**：卡片送出去 → 拿那张卡片上真的按钮 → 当作有人点了 → 命令落链。

    "谁点的"由**回调体**给（宿主把它填进 `who`），不是卡片里写死的——所以这里
    模拟的是"另一个人的 open_id 点了那张卡"。
    """
    app = application(tmp_path, approve=False)
    try:
        task_id = 停在待批(app)
        sent = tmp_path / "extensions" / "pigeon" / "sent.jsonl"
        card = json.loads(sent.read_text(encoding="utf-8").splitlines()[0])
        approve = [action for action in card["actions"]
                   if action["value"]["action"] == "approve"][0]

        ok, message = app.answer({**approve["value"], "who": "ou_someone_else"})

        assert (ok, message) == (True, "已批准。")
        # **证据写的是谁点的**——不假装是本机操作员按的
        approved = [event for event in app.kernel.events(task_id)
                    if event.event_type == "APPROVED"]
        assert [event.external_ref for event in approved] == ["channel:ou_someone_else"]
    finally:
        app.shutdown()


def test_指纹变了的按钮点不动(tmp_path: Path):
    """工具请求换了 → 旧卡片绑定的是上一次那件事，**它不该还能生效**。"""
    app = application(tmp_path, approve=False)
    try:
        task_id = 停在待批(app)

        ok, message = app.answer({"task_id": task_id, "action": "approve",
                                      "fingerprint": "fp-上一次", "who": "ou_magic"})

        assert ok is False and "变了" in message
        assert app.kernel.get_task(task_id).pending_decision == "pending"
    finally:
        app.shutdown()


# ── 回来路**按需**接上（不是开机就接）

def test_口子只在第一次要送的时候递(tmp_path: Path):
    """**这是"只在需要通知时启动长连接"的钉子。**

    宿主开机**不碰**通道的回来路（`Application.start()` 只起轮询）——真正递口子的
    时刻是**第一次要把东西送出去之前**。理由在 `extensions/channels.py::arm`：
    飞书那条长连接占的是独占资源（同一应用多条连接互相吃事件），没东西要送时
    不该连着。

    所以三件事都要成立：**送之前一个都没有、送的那一刻有一次、之后不再重复。**
    """
    app = application(tmp_path, approve=False)
    try:
        armed = tmp_path / "extensions" / "pigeon" / "armed.jsonl"

        app.start()                       # 宿主启动（serve.py 做的就是这一句）
        assert not armed.exists(), "开机就把回来路接上了——那正是要避免的"

        task_id = 停在待批(app)            # 第一次要送：有人可能要拍板了
        assert armed.exists(), "要送了却还没递口子——卡片上的按钮会是死的"
        assert len(armed.read_text(encoding="utf-8").splitlines()) == 1

        app.facade.submit("set_enabled", {"target": "package", "name": "guard",
                                          "enabled": True})
        assert len(armed.read_text(encoding="utf-8").splitlines()) == 1, "递了不止一次"
    finally:
        app.shutdown()


# ── 端到端：一条事实 → 一份输出 → 一张卡片

def test_任务停下来等审批_卡片真的送出去了(tmp_path: Path):
    """**整条链**：worker 停 → `INTERRUPTED` 落链 → 耳朵叫一声 → 派生出输出 →
    交给那条通道 → 卡片上带着那一刻的指纹。

    夹具里那条约会（`pigeon`）只会把收到的卡片写进文件——所以这里看得到"外面到底
    收到了什么"，而那正是这一层存在的意义。
    """
    app = application(tmp_path, approve=False)
    try:
        task_id = 停在待批(app)

        sent = tmp_path / "extensions" / "pigeon" / "sent.jsonl"
        cards = [json.loads(line) for line in sent.read_text(encoding="utf-8").splitlines()]

        assert [card["ref"] for card in cards] == [f"task:{task_id}:approval"]
        values = [action["value"] for action in cards[0]["actions"]]
        assert values[0]["task_id"] == task_id
        assert values[0]["fingerprint"] == app.kernel.get_task(task_id).pending_fingerprint
    finally:
        app.shutdown()


def test_一条通道只会送一次(tmp_path: Path):
    """同一条还悬着，但事实又响了一次（比如别的命令落了链）——不该再发一张卡片。"""
    app = application(tmp_path, approve=False)
    try:
        task_id = 停在待批(app)
        # 再提交一条**别的**命令：它会落链、叫一声，但那条审批不该再送一次
        app.facade.submit("set_enabled", {"target": "package", "name": "guard", "enabled": True})

        sent = tmp_path / "extensions" / "pigeon" / "sent.jsonl"
        lines = sent.read_text(encoding="utf-8").splitlines()

        assert len(lines) == 1
        assert json.loads(lines[0])["ref"] == f"task:{task_id}:approval"
    finally:
        app.shutdown()
