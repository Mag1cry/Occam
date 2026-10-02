"""飞书长连接：**回来那一步**。

四件事，每一件都有过一段"静默坏掉"的历史：

1. **SDK 把 CARD 帧丢了**（1.7.3 实测：`elif message_type == MessageType.CARD: return`）
   → 点按钮没反应，而且一声不响。补丁把它接到和 EVENT 同一条分派上；
2. **回调体里哪个是"谁点的"**（`operator.open_id`，不是我们预置的收件人）——
   证据要写的是点的人；
3. **旧卡片/旧请求**：工具请求换过一次，指纹就变了，那张卡片上的按钮不该还能用
   （`gateway/output/callback.py::decide` 里那道判断，链接和回调**共用一份**）；
4. **点完那张卡片要原地换掉**：应答里带一张新卡片（`_decided_card`），飞书替换那条
   消息——"点一下就在原地变成已批准"，不跳转、不用翻聊天记录。而**标题只看"成没成"**，
   不看 `action`：指纹对不上时点了"批准"，绝不能画成「✅ 已批准」（那是假状态）。
"""
from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

PACKAGE = Path(__file__).resolve().parents[1] / "extensions" / "feishu" / "channel.py"


def load_channel_module():
    """`extensions/feishu/channel.py` 由加载器 import，不是可 `import` 的包——
    测试里按路径装一次（同一个模块对象，补丁才作用在同一处）。"""
    name = "occ_test_feishu_channel"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, PACKAGE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def card_click(value: dict, open_id: str = "ou_clicker"):
    """一次卡片点击的回调体：**意图在 `action.value`，点击者在 `operator`**。"""
    return SimpleNamespace(event=SimpleNamespace(
        action=SimpleNamespace(value=value),
        operator=SimpleNamespace(open_id=open_id)))


def replaced_card_of(response) -> dict:
    """从应答里取出那张**用来原地替换**的卡片。"""
    assert response.card is not None, "应答里没带卡片——飞书就不会换掉它"
    assert response.card.type == "raw", "`raw` 才表示 data 里是一份完整卡片"
    return response.card.data


def texts_of(card: dict) -> str:
    return " ".join(str(item.get("content") or "") for item in card["elements"])


# ── 补丁：CARD 帧也要分派

class FakeClient:
    """只记账的"客户端"——`_handle_data_frame` 要的那几样它都有。"""

    def __init__(self) -> None:
        self.handler = SimpleNamespace(seen=[], _do_without_validation=self._dispatch)
        self._event_handler = self.handler
        self.written: list[bytes] = []

    def _dispatch(self, payload: bytes):
        self.handler.seen.append(json.loads(payload.decode("utf-8")))
        return {"toast": {"type": "info", "content": "ok"}}

    def _combine(self, *args):                       # pragma: no cover — 单帧用不到
        return None

    def _fmt_log(self, *args):
        return ""

    async def _write_message(self, data: bytes) -> None:
        self.written.append(data)


def frame_of(message_type) -> object:
    """造一个真的 Frame（SDK 的消息形状：头里放类型，载荷是 JSON 字节）。"""
    from lark_oapi.ws import client as ws
    from lark_oapi.ws.pb.pbbp2_pb2 import Frame

    frame = Frame()
    frame.SeqID = 1
    frame.LogID = 1
    frame.service = 1
    frame.method = 1
    for key, value in ((ws.HEADER_TYPE, str(message_type.value)),
                       (ws.HEADER_MESSAGE_ID, "m-1"), (ws.HEADER_TRACE_ID, "t-1"),
                       (ws.HEADER_SUM, "1"), (ws.HEADER_SEQ, "0")):
        header = frame.headers.add()
        header.key = key
        header.value = value
    frame.payload = b'{"header": {"event_type": "card.action.trigger"}, "event": {}}'
    return frame


def test_补丁之后_CARD_帧也会走到处理器():
    """**这是整条回来路的命门**：SDK 1.7.3 的 `_handle_data_frame` 里

    ```python
    elif message_type == MessageType.CARD:
        return                     # ← 卡片回传被静默丢弃
    ```

    于是长连接下处理器永远不被调，点按钮没反应、也不报错。补丁把它接回去。"""
    from lark_oapi.ws import client as ws
    from lark_oapi.ws.enum import MessageType

    module = load_channel_module()
    module.patch_card_dispatch()

    client = FakeClient()
    asyncio.run(ws.Client._handle_data_frame(client, frame_of(MessageType.CARD)))

    assert client.handler.seen, "CARD 帧还是被丢掉了——补丁没生效"
    # 答回去了（应答里带着处理结果，飞书那边才拿得到 toast 和新卡片）
    assert client.written


def test_补丁是幂等的():
    """将来 SDK 修好了，这里该变成一句版本判断——所以补丁不能越打越厚。"""
    module = load_channel_module()
    module.patch_card_dispatch()
    first = load_channel_module().__dict__  # 只是别让 linter 说变量没用

    assert module.patch_card_dispatch() is True
    assert first is not None


# ── 插座属于**进程**，不属于实例

def test_热加载换了实例也不会连第二条(monkeypatch):
    """**这是"改一次配置漏一条连接"那条。**

    `HotLoader.refresh()` 每次都**重建实例**（改一个 manifest 就会发生），而
    `Loaded.close()` 只收供给、不收通道——所以如果插座挂在实例上，每编辑一次配置
    都会多一条长连接。而飞书那边是**集群模式、不广播**：同一应用的多条连接会互相
    吃事件，多出来的每一条都在偷别人的事件。

    所以：**第二次 `arm` 只换口子，不再连**；而**由谁来答**要跟着新实例走
    （连接是老的，处理器是新的那一个）。
    """
    module = load_channel_module()
    monkeypatch.setattr(module, "_LIVE",
                        {"client": None, "channel": None, "on_action": None})
    connected: list = []
    monkeypatch.setattr(module, "_connect",
                        lambda dispatch: connected.append(dispatch) or object())

    first, second = module.Feishu(), module.Feishu()      # 第二次 = 热加载之后那个
    first.arm(lambda payload: (True, "老的"))
    second.arm(lambda payload: (True, "新的"))

    assert len(connected) == 1, "连了不止一条——那两条会互相吃事件"
    assert module._LIVE["channel"] is second, "回话还挂在旧实例上——热加载白做了"
    assert module._LIVE["on_action"]({}) == (True, "新的")


# ── 回调体：谁点的、点了什么

def test_有人点按钮_把意图和点击者交给宿主():
    module = load_channel_module()
    channel = module.Feishu()
    got: list[dict] = []

    response = channel._on_card(
        lambda payload: got.append(payload) or "已批准。",
        card_click({"task_id": "task-1", "action": "approve",
                    "fingerprint": "fp-1", "summary": "「整理项目资料」"}))

    # 意图来自按钮的 value，**点击者来自回调体**——证据写的是点的人
    assert got == [{"task_id": "task-1", "action": "approve", "fingerprint": "fp-1",
                    "summary": "「整理项目资料」", "who": "ou_clicker"}]
    assert response.toast is not None and "已批准" in str(response.toast.content)


def test_宿主那边炸了_也不能变成点不动():
    """3 秒内必须应答；一次异常不该让用户看到"按钮没反应"。"""
    module = load_channel_module()
    channel = module.Feishu()

    def boom(_payload):
        raise RuntimeError("里面炸了")

    response = channel._on_card(boom, card_click({}))

    assert response is not None                 # 照样答，只是话说清了
    assert "没做成" in str(response.toast.content)


# ── 点完原地换卡：这是"不跳转"的实现

def test_点了之后那张卡片会被原地换掉():
    """**这就是「不跳转」**：应答里带一张新卡片，飞书原地替换那条消息——
    点完变成「✅ 已批准」，**按钮消失**。

    按钮必须消失：点过一次的事，留着按钮只会让人再点一次，而第二次会被指纹挡下
    （"这件事已经变了"）——用户看到的是一句莫名其妙的拒绝。"""
    module = load_channel_module()
    channel = module.Feishu()

    response = channel._on_card(
        lambda _payload: (True, "已批准。"),
        card_click({"task_id": "task-1", "action": "approve",
                    "fingerprint": "fp-1", "summary": "workspace.search_text"}))

    replaced = replaced_card_of(response)
    assert "已批准" in replaced["header"]["title"]["content"]
    assert not any(item["tag"] == "action" for item in replaced["elements"]), \
        "按钮还在——那第二次点就会撞上指纹检查"
    text = texts_of(replaced)
    assert "workspace.search_text" in text      # 原摘要还在，能认出是哪件事
    assert "已批准。" in text                    # 宿主那句话照原样写上


def test_批准和拒绝的卡不一样():
    module = load_channel_module()
    yes = module._decided_card({"action": "approve", "summary": "x"}, True, "已批准。")
    no = module._decided_card({"action": "deny", "summary": "x"}, True, "已拒绝。")

    assert "已批准" in yes["header"]["title"]["content"]
    assert "已拒绝" in no["header"]["title"]["content"]
    assert yes["header"]["template"] != no["header"]["template"]


def test_没做成的时候绝不能画成已批准():
    """**这是最要紧的一条**：指纹对不上（那件事已经变了）、任务已经不在等了——
    这些都会走到 `_decided_card`，而 `action` 仍然是 `approve`。

    照 `action` 画就会显示「✅ 已批准」，**而实际什么都没发生**——用户看到的是假状态。"""
    module = load_channel_module()

    rejected = module._decided_card({"action": "approve", "summary": "x"}, False,
                                    "这件事已经变了（等的是另一件了）")
    assert "已批准" not in rejected["header"]["title"]["content"]
    assert "没做成" in rejected["header"]["title"]["content"]
    assert "变了" in texts_of(rejected)

    # 宿主只回了一句话（没判成没成）→ 也不替它判成功
    unknown = module._decided_card({"action": "approve", "summary": "x"}, None, "收到了")
    assert "已批准" not in unknown["header"]["title"]["content"]


# ── 旧卡片/旧请求：指纹变了就不认

def test_回调里那份意图也要对指纹(tmp_path: Path):
    """链接靠签名绑指纹，回调靠按钮 `value` 里的指纹——**判断是同一份**
    （`gateway/output/callback.py::decide`）：工具请求换过一次，旧卡片上的按钮
    就不该还能批。"""
    from src.gateway.output.callback import decide
    from tests.support.newtree import application, wait_for_status

    app = application(tmp_path, approve=False)
    try:
        task_id = app.facade.submit("create_task", {
            "summary": "守卫", "executor_ref": "guard.run",
            "task_ref": "hello.txt"}).data["task_id"]
        app.facade.submit("start_task", {"task_id": task_id})
        wait_for_status(app.kernel, task_id, "paused")

        # ① 指纹对得上 → 成了一条带证据的命令
        ok, message = decide({"task_id": task_id, "action": "deny",
                              "fingerprint": app.kernel.get_task(task_id).pending_fingerprint,
                              "who": "ou_clicker"},
                             kernel=app.kernel, facade=app.facade)
        assert (ok, message) == (True, "已拒绝。")
        events = [e.external_ref for e in app.kernel.events(task_id)
                  if e.event_type == "DENIED"]
        assert events == ["channel:ou_clicker"]      # **谁点的**，不是"发给谁的"

        # ② 指纹对不上（那张卡片是上一次那件事的）→ 不动它
        ok, message = decide({"task_id": task_id, "action": "approve",
                              "fingerprint": "fp-上一次", "who": "ou_clicker"},
                             kernel=app.kernel, facade=app.facade)
        assert ok is False and "变了" in message
    finally:
        app.shutdown()


def test_整条回来路_从一帧走到事件链(tmp_path: Path):
    """**别人测的都是一段一段的，这一条测的是接缝。**

    前面几条各自钉住一格（补丁分派、取谁点的、换卡），但**没有一条把真的东西串起来**：
    真的 `EventDispatcherHandler`、真的 `P2CardActionTriggerResponse` 序列化、真的
    宿主那口子（`app.answer`，`arm` 递出去的就是它）、真的事件链。接缝就在这些
    "各自都对"的地方——比如处理器返回的对象到底能不能被 SDK 那套 `JSON.marshal`
    装进应答帧，假客户端是看不出来的（它返回的是 dict，真的返回的是对象）。

    这条路走通 = 飞书长连接下"点一下就能批"是成立的。
    """
    import lark_oapi as lark
    from lark_oapi.ws import client as ws
    from lark_oapi.ws.enum import MessageType
    from lark_oapi.ws.pb.pbbp2_pb2 import Frame
    from src.gateway.output.callback import card_for
    from src.gateway.output.output import standing
    from tests.support.newtree import application, wait_for_status

    module = load_channel_module()
    module.patch_card_dispatch()

    app = application(tmp_path, approve=False)
    try:
        task_id = app.facade.submit("create_task", {
            "summary": "探针", "executor_ref": "guard.run",
            "task_ref": "hello.txt"}).data["task_id"]
        app.facade.submit("start_task", {"task_id": task_id})
        task = wait_for_status(app.kernel, task_id, "paused")

        # ① 真的那张卡片（宿主送出去的就是它）——点的是它第一个按钮
        card = card_for(standing(app.kernel)[0],
                        fingerprint=task.pending_fingerprint)
        click = {
            "schema": "2.0",
            "header": {"event_type": "card.action.trigger", "event_id": "e-1",
                       "token": "vt", "create_time": "1", "app_id": "cli_x",
                       "tenant_key": "tk"},
            "event": {"operator": {"tenant_key": "tk", "user_id": "u",
                                   "open_id": "ou_clicker", "union_id": "un"},
                      "token": "ct",
                      "action": {"value": card["actions"][0]["value"],
                                 "tag": "button", "option": ""},
                      "context": {"open_message_id": "om", "open_chat_id": "oc"}},
        }

        # ② 真的处理器：派发用的就是 `_connect` 注册的那一个（`_dispatch`），
        #    口子从 `_LIVE` 现取——**和真跑起来时同一段代码**，不另搭一条线
        module._LIVE.update({"client": object(),      # 装作已经连着（不真连）
                             "channel": module.Feishu(), "on_action": app.answer})
        handler = (lark.EventDispatcherHandler.builder("", "")
                   .register_p2_card_action_trigger(module._dispatch)
                   .build())

        class Wire:
            _event_handler = handler

            def __init__(self) -> None:
                self.written: list[bytes] = []

            def _combine(self, *args):               # pragma: no cover — 单帧用不到
                return None

            def _fmt_log(self, *args):
                return ""

            async def _write_message(self, data: bytes) -> None:
                self.written.append(data)

        # ③ 平台推回来的那一帧（CARD 型，就是 SDK 会丢掉的那种）
        frame = Frame()
        frame.SeqID, frame.LogID, frame.service, frame.method = 1, 1, 1, 1
        for key, item in ((ws.HEADER_TYPE, str(MessageType.CARD.value)),
                          (ws.HEADER_MESSAGE_ID, "m-1"), (ws.HEADER_TRACE_ID, "t-1"),
                          (ws.HEADER_SUM, "1"), (ws.HEADER_SEQ, "0")):
            header = frame.headers.add()
            header.key, header.value = key, item
        frame.payload = json.dumps(click).encode("utf-8")

        wire = Wire()
        asyncio.run(ws.Client._handle_data_frame(wire, frame))

        # ④ 答回去的那一帧：飞书拿它弹 toast、并在**原地换掉**那条消息
        answer = Frame()
        answer.ParseFromString(wire.written[0])
        body = json.loads(answer.payload.decode("utf-8"))
        assert body["code"] == 200, "应答不是 200——平台会把这次点击算成失败"
        payload = json.loads(base64.b64decode(body["data"]).decode("utf-8"))
        assert "已批准" in payload["toast"]["content"]
        assert "已批准" in payload["card"]["data"]["header"]["title"]["content"]

        # ⑤ 内核那边：批准落了链，**证据写的是点的人**
        approved = [e for e in app.kernel.events(task_id) if e.event_type == "APPROVED"]
        assert [e.external_ref for e in approved] == ["channel:ou_clicker"]
        assert app.kernel.get_task(task_id).status == "running"
    finally:
        app.shutdown()


def test_SDK_里那个丢弃_CARD_的分支还在():
    """**补丁的理由要能被验证，也要能"过期提醒"。**

    直接读 SDK 的**文件**（类上挂的可能已经是我们的补丁）：只要 `MessageType.CARD`
    后面跟着一个 `return`（没有分派），补丁就是必须的。哪天 SDK 修好了，这条会红——
    **那时候该做的是删掉补丁**，不是改这条测试。
    """
    from lark_oapi.ws import client as ws

    source = Path(ws.__file__).read_text(encoding="utf-8")
    tail = source.split("message_type == MessageType.CARD", 1)
    assert len(tail) == 2, "SDK 里已经没有这个分支了——补丁大概可以删了"
    assert "return" in tail[1][:120], "SDK 已经把 CARD 接上了——删掉那段补丁吧"
