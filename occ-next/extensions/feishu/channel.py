"""飞书通道：**宿主往外送东西的那只手**。

这份的卡片骨架是从 occ-os 的 `occ-extensions/feishu/channel.py` 搬过来的（那套
`config`/`header`/`markdown`/`hr` 是真飞书验过的，不再自己发明），**但回来路是新的**
——occ-os 那个通道是纯单向的：它连 `lark` 都没装，卡片上没有按钮，一行接收代码都没有。

搬过来只适配了三处"管道"：

| 搬过来的 | 适配成 | 为什么 |
| --- | --- | --- |
| pydantic 配置 + `OCCOS_` 前缀 | 直接读 `OCC_NEXT_FEISHU_*` 环境变量 | 新系统没有那套 Settings；**文件不是契约，环境才是**（`config/.env` 只是填环境的一种方式） |
| token 落盘在仓库根 | **只在内存里**（进程活多久算多久） | 包的目录是**用户的 git 工作区**，数据不写那儿；而状态目录的路径**包不该自己去猜**。代价是重启后多取一次 token（一次 HTTP，秒级） |
| 契约只有 `send_text/send_card` | 加 `who` / `why_not` | 前者说"发给谁"（`_send` 的收件人，也是回调里取不到点击者时的兜底）；后者让"装了但没配好"说得清缺哪一格 |

**每日摘要那一套（时间线 / 指标 / 状态三格渲染）已经删掉**：它在我们的系统里没有
生产者，而且"往外送什么"现在归宿主的输出层管——通道只负责**把一张中性卡画成飞书的
形状**，不该自带一套业务渲染。将来要做每日摘要，那也是"一个产出输出的插件"，不是
通道里的一段遗留代码。

凭据只走环境变量：`OCC_NEXT_FEISHU_APP_ID` / `_APP_SECRET` / `_OPEN_ID`。
**密钥不进声明、不进事件、不进界面**——和 `api_key_env` 同一条线。

## 唯一的回来路：长连接 + **原地换卡**

审批按钮是**回调型**（带 `value`）：点了之后飞书把这次点击通过**我们连出去的长连接**
推回来（不需要公网、不需要手机打开任何东西），宿主递进来的那个口子
（`arm(on_action)`）把它变成一条带证据的命令。

应答里还要**带一张新卡片**（`_decided_card`）：飞书会**原地替换**那条消息，于是
点完就变成「✅ 已批准 / ❌ 已拒绝」——**不跳转、不用回聊天记录里翻**。

**签名链接那条路已经不是"次要选项"，是彻底删了**（理由见
`src/gateway/output/callback.py` 的模块说明）——所以按钮**只有 `value` 一种形状**，
`_button` 里那条 `url` 分支跟着一起没了。

## ⚠️ 这占的是**独占资源**

飞书的长连接是**集群模式**：同一个应用的多条连接，事件**随机推给其中一个、不广播**。
所以这个通道和任何别的飞书客户端（比如机器上那个 Hermes 网关）**共用应用就会互相吃
事件**——落到我们这条上而没实现 handler 的（比如 `im.message.receive_v1`）会回 500，
那条事件对另一边就是**永久丢失**。要用它，就给 OCC 单开一个应用。
"""
from __future__ import annotations

import base64
import json
import os
import time
from typing import Any
from urllib.request import Request, urlopen

BASE = "https://open.feishu.cn/open-apis"

#: **这个进程的那一条连接。** 模块级的，不是实例级的——理由是它**只可能有一条**：
#: 飞书那边是集群模式、不广播，同一个应用的多条连接会互相吃事件。而热加载**每次
#: 都换实例**（改一个 manifest 就重建一个 `Feishu`），所以插座挂在实例上就等于
#: "改一次配置漏一条连接"。模块对象在 `sys.modules` 里是复用的一
#: （`extensions/runtime.py::load_entrypoint`），所以挂在这儿才活得比实例长。
_LIVE: dict[str, Any] = {"client": None, "channel": None, "on_action": None}


def _env(name: str) -> str:
    return str(os.environ.get(name, "")).strip()


def _post(path: str, payload: dict, *, token: str = "", timeout: float = 8.0) -> dict:
    """发一次。**出网就两个字：够用就好**——标准库够发一次 POST，不引 HTTP 库。

    （occ-os 走的是它自己的 `platform/http.py`；这里换成等价的 stdlib 实现，
    因为它那个模块属于旧系统。）
    """
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(BASE + path, data=json.dumps(payload).encode("utf-8"),
                      headers=headers, method="POST")
    with urlopen(request, timeout=timeout) as response:      # noqa: S310 — 固定的 https 地址
        body = json.loads(response.read().decode("utf-8"))
    if body.get("code") != 0:
        raise RuntimeError(f"飞书说：{body.get('msg') or body}")
    return body


class Feishu:
    """一条飞书通道。**一个实例管一个包**（token 就缓在它身上）。"""

    def __init__(self) -> None:
        self._cache: tuple[str, float] | None = None    # (token, 过期时刻)

    # ── 契约：凭据齐不齐（宿主据此过滤：没配好就不送，不算失败）

    def enabled(self) -> bool:
        return bool(_env("OCC_NEXT_FEISHU_APP_ID") and _env("OCC_NEXT_FEISHU_APP_SECRET")
                    and self.who)

    @property
    def who(self) -> str:
        """发给谁。**它同时是回来那条链接上的证据**（`channel:<who>`）。"""
        return _env("OCC_NEXT_FEISHU_OPEN_ID")

    def why_not(self) -> str:
        """缺哪一格就说哪一格（`enabled()` 只答"能不能用"，这一格答"为什么不能"）。"""
        missing = [name for name in ("OCC_NEXT_FEISHU_APP_ID", "OCC_NEXT_FEISHU_APP_SECRET",
                                     "OCC_NEXT_FEISHU_OPEN_ID") if not _env(name)]
        if missing:
            return "环境变量里没有 " + " · ".join(missing) + "（写在 config/.env 里）"
        return "配好了"

    # ── token 管理（搬过来的那段，落盘换成了内存）

    def get_token(self, force: bool = False) -> str:
        if not force and self._cache and self._cache[1] > time.time() + 300:
            return self._cache[0]
        data = _post("/auth/v3/tenant_access_token/internal", {
            "app_id": _env("OCC_NEXT_FEISHU_APP_ID"),
            "app_secret": _env("OCC_NEXT_FEISHU_APP_SECRET"),
        })
        token = str(data["tenant_access_token"])
        #: 只活在进程里（见文件头："数据不写进用户的 git 工作区"）
        self._cache = (token, time.time() + int(data.get("expire", 7200)))
        return token

    def _send(self, msg_type: str, content: dict) -> dict:
        if not self.enabled():
            raise RuntimeError(f"飞书通道没配好：{self.why_not()}")
        return _post("/im/v1/messages?receive_id_type=open_id", {
            "receive_id": self.who,
            "msg_type": msg_type,
            "content": json.dumps(content, ensure_ascii=False),
        }, token=self.get_token())

    # ── 契约：发

    def send_text(self, text: str) -> dict:
        return self._send("text", {"text": text})

    def send_card(self, card: dict) -> dict:
        """卡片。宿主给的是一份**中性描述**（`{"title", "lines", "actions"}`），
        这里把它画成飞书的形状——**形状照 occ-os 那份**（config / header /
        elements 的 markdown + hr），加上一个按钮块。"""
        return self._send("interactive", _feishu_card(card))

    # ── 回来路：长连接（**出站**，不占端口、不需要公网）

    def arm(self, on_action) -> None:
        """**收下"回话"的口子，并当场把长连接插上。**

        ## 为什么是"收口子"而不是"宿主叫它启动"

        宿主在**第一次真的要送东西出去之前**叫这一次（`gateway/output/paths.py::
        ChannelPath._arm`），把 `on_action` 递进来——外面发生了什么就调它，拿回
        `(成没成, 那句话)`。**怎么连、连去哪儿、什么时候连，全在这一边**：宿主不该
        知道飞书有个 WebSocket。

        ## 为什么连接**在这一刻**才建（而不是开机就建）

        长连接**占的是独占资源**：飞书那边是**集群模式、不广播**——同一个应用的多条
        连接，每个事件**随机推给其中一个**。所以这玩意儿跟任何别的飞书客户端（比如
        机器上另一个网关）**共用应用就会互相吃事件**：落到我们这条上而没实现 handler
        的（比如 `im.message.receive_v1`）会回 500，那一条对另一边就是**永久丢失**。

        那就别一直连着：**没有东西要送的时候，就不该占着插座。** 第一次送（= 有人
        可能要拍板）之前连上，之后就由 SDK 自己维持重连。

        ## 连上去之后

        - 注册 **`card.action.trigger`**（卡片回传交互）。开放平台「事件与回调」里
          订阅方式也要选**长连接**、并订阅这个事件——没订阅的话点按钮报
          `code: 200340`（点不动，但看起来像卡片坏了）。
        - `patch_card_dispatch()`：SDK 1.7.3 在长连接下**把 CARD 帧静默丢掉**（见那个
          函数的说明），不打这个补丁按钮永远没反应。
        - SDK 的 `ws.Client.start()` 是**阻塞**的（内部自己重连），所以起在后台线程里。

        **幂等**：口子被重递（热加载、重启投递）不会连出第二条——已经连上就只换口子，
        而且**插座挂在模块上**（`_LIVE`），不是挂在自己身上：热加载每次都换实例，
        挂实例上就等于"改一次配置漏一条连接"。
        """
        _LIVE["channel"], _LIVE["on_action"] = self, on_action
        if _LIVE["client"] is None:
            _LIVE["client"] = _connect(_dispatch)

    def _on_card(self, on_action, data):
        """**有人点了卡片按钮。**

        回调体里两样东西要紧：`action.value`（我们放进去的那份意图）和
        `operator.open_id`（**谁点的**——这才是证据）。取出来交给宿主，
        把宿主那句话原样回成飞书的 toast。

        ## 顺带把那张卡片**换掉**

        飞书允许在回调的应答里带一张新卡片，平台会**原地替换**它——这就是
        「点完不用跳转、卡片自己变成已批准」的做法（`card` 那一格的
        `type: "raw"` 表示 `data` 里是一份完整的卡片 JSON）。

        回调体里**不带原卡片**，所以摘要要在按钮的 `value` 里带回来
        （`gateway/output/callback.py::card_for` 放进去的那一格 `summary`）。

        换卡不是装饰：按钮点过一次就该消失——留着它，第二次点会被指纹挡下
        （"这件事已经变了"），而用户看到的是一句莫名其妙的拒绝。

        **三秒内要答完**：宿主那边只是提交一条命令（本机操作，很快），
        所以这一步不会超。
        """
        from lark_oapi.event.callback.model.p2_card_action_trigger import (
            P2CardActionTriggerResponse,
        )

        event = getattr(data, "event", None)
        value = dict(getattr(getattr(event, "action", None), "value", None) or {})
        operator = getattr(event, "operator", None)
        who = str(getattr(operator, "open_id", "") or "") or self.who
        try:
            result = on_action({**value, "who": who})
        except Exception as exc:                       # noqa: BLE001 — 别让它变成"点不动"
            ok: bool | None = False
            message = f"这一步没做成：{type(exc).__name__}: {exc}"
        else:
            # 宿主答 `(成没成, 那句话)`；只答一句话也认——那就**不替它判成功**
            # （卡片标题写错，用户看到的就是个假状态）。
            if isinstance(result, tuple):
                ok = bool(result[0])
                message = str(result[1]) if len(result) > 1 else ""
            else:
                ok, message = None, str(result)
        return P2CardActionTriggerResponse({
            "toast": {"type": "info", "content": message or "收到了"},
            "card": {"type": "raw", "data": _decided_card(value, ok, message)},
        })

    def close(self) -> None:
        """**收不掉。** 宿主关停时会叫它，而这里什么都不做——因为 SDK 没给这个动作。

        ## 为什么是空的（1.7.3 实测）

        `lark_oapi.ws.Client` 只有 `start()`（阻塞跑一个模块级事件循环）和
        `_connect` / `_disconnect` / `_reconnect`（私有的协程）——**没有 `stop()`**。
        连接活在那条 **daemon 线程**里，唯一的终点是**进程退出**（OS 关掉 socket）。

        所以：
        - **不能**把 `_LIVE["client"]` 清掉——那条连接还活着，清掉之后下一次 `arm`
          会以为没连过、再连一条，于是**同一个进程两条连接互相吃事件**（最坏的写法）；
        - 想真收，得 `asyncio.run_coroutine_threadsafe(client._disconnect(), ws.loop)`
          ——那要动 SDK 私有的东西；今天不做，但**写清楚它没收**，比写一句假装收掉的
          代码强。
        """


def _dispatch(data: Any) -> Any:
    """**一帧卡片回传 → 当前那个实例的回答。**

    每次都**现取**（`_LIVE`）：热加载之后实例是新的、而连接还是原来那条，所以
    "谁来处理"必须跟着 `_LIVE` 走，不能在注册处理器那一刻绑死。
    """
    channel = _LIVE.get("channel")
    if channel is None:
        return None
    return channel._on_card(_LIVE.get("on_action"), data)     # noqa: SLF001 — 同一条通道


def _connect(dispatch: Any) -> Any:
    """**把连接建起来**（起在自己的线程里，`ws.Client.start()` 是阻塞的）。

    单独一个函数，因为它是**唯一会碰网络的地方**：测试要问的是"它有没有被叫第二次"
    （热加载漏连接那条），而不是真的连上去——所以那一处打个桩就够了。
    """
    import threading

    import lark_oapi as lark

    patch_card_dispatch()
    handler = (lark.EventDispatcherHandler.builder("", "")
               .register_p2_card_action_trigger(dispatch).build())
    client = lark.ws.Client(_env("OCC_NEXT_FEISHU_APP_ID"),
                            _env("OCC_NEXT_FEISHU_APP_SECRET"),
                            event_handler=handler, log_level=lark.LogLevel.INFO)
    threading.Thread(target=client.start, name="feishu-ws", daemon=True).start()
    return client


def patch_card_dispatch() -> bool:
    """**让长连接也分派 `CARD` 帧。**

    SDK（1.7.3，实测）的 `Client._handle_data_frame` 长这样：

    ```python
    if message_type == MessageType.EVENT:
        result = self._event_handler._do_without_validation(pl)
    elif message_type == MessageType.CARD:
        return                     # ← 卡片回传被**静默丢弃**
    ```

    于是在长连接下，`register_p2_card_action_trigger` 注册的处理函数**永远不会被调**——
    点按钮没反应，而且一声不响（webhook 模式没这个问题）。这是 SDK 的锅，不是飞书的：
    平台确实把卡片回传发过来了（`MessageType.CARD` 那个分支就是为它留的）。

    这里照抄那个方法、只改一处：CARD 和 EVENT 走同一条分派。**补丁打在 SDK 的类上**
    （而不是 fork 一份 SDK），因为它是这个版本的已知缺陷，将来 SDK 修好了这里应当变成
    一句版本判断——所以补丁是**幂等**的，且**只在真的要用长连接时**才打（`start()` 里调）。
    """
    from lark_oapi.core.json import JSON
    from lark_oapi.core.const import UTF_8
    from lark_oapi.core.log import logger
    from lark_oapi.ws import client as ws
    from lark_oapi.ws.enum import MessageType
    from lark_oapi.ws.model import Response
    import http
    import time

    if getattr(ws.Client._handle_data_frame, "_occ_patched", False):
        return True

    async def _handle_data_frame(self, frame) -> None:          # noqa: ANN001 — 照抄 SDK
        hs = frame.headers
        msg_id = ws._get_by_key(hs, ws.HEADER_MESSAGE_ID)
        trace_id = ws._get_by_key(hs, ws.HEADER_TRACE_ID)
        sum_ = ws._get_by_key(hs, ws.HEADER_SUM)
        seq = ws._get_by_key(hs, ws.HEADER_SEQ)
        type_ = ws._get_by_key(hs, ws.HEADER_TYPE)

        pl = frame.payload
        if int(sum_) > 1:
            pl = self._combine(msg_id, int(sum_), int(seq), pl)
            if pl is None:
                return

        message_type = MessageType(type_)
        resp = Response(code=http.HTTPStatus.OK)
        try:
            started = int(round(time.time() * 1000))
            if message_type in (MessageType.EVENT, MessageType.CARD):
                # **这一行就是补丁**：CARD 原本在这里被丢掉
                result = self._event_handler._do_without_validation(pl)
            else:
                return
            ended = int(round(time.time() * 1000))
            header = hs.add()
            header.key = ws.HEADER_BIZ_RT
            header.value = str(ended - started)
            if result is not None:
                resp.data = base64.b64encode(JSON.marshal(result).encode(UTF_8))
        except Exception as exc:                                # noqa: BLE001 — 照抄 SDK
            logger.error(self._fmt_log(
                "handle message failed, message_type: {}, message_id: {}, trace_id: {}, err: {}",
                message_type.value, msg_id, trace_id, exc))
            resp = Response(code=http.HTTPStatus.INTERNAL_SERVER_ERROR)

        frame.payload = JSON.marshal(resp).encode(UTF_8)
        await self._write_message(frame.SerializeToString())

    _handle_data_frame._occ_patched = True                       # type: ignore[attr-defined]
    ws.Client._handle_data_frame = _handle_data_frame
    return True


def _decided_card(value: dict, ok: bool | None, message: str) -> dict:
    """**点完之后那张卡片长什么样**：结论 + 原摘要，**按钮去掉**。

    ## 标题靠"成没成"判，**不靠 `action`**

    点了"批准"但被指纹挡下（那件事已经变了）、或者任务已经不在等了——这些都会走到
    这儿，而 `action` 仍然是 `approve`。照它画，用户看到的就是「✅ 已批准」，
    **而实际什么都没发生**。所以：

    - `ok is True` 且动作认得 → 「✅ 已批准」/「❌ 已拒绝」；
    - `ok is False` → 「⚠️ 没做成」（原因在下面那行，宿主怎么说就怎么写）；
    - `ok is None`（宿主只回了一句话，没判）→ 「已处理」——**不替它判成功**。

    形状和 `_feishu_card` 对齐（`config` / `header` / `markdown` / `hr` 尾巴）——
    换卡不该让这条消息看起来变成另一个东西，只是字换了、按钮没了。

    字从哪来：`summary` 是原摘要（`gateway/output/callback.py::card_for` 放进
    `value` 的），`message` 是宿主那句话——**它才是真正发生了什么**，照原样写上。
    """
    action = str(value.get("action") or "")
    decided = {"approve": ("✅ 已批准", "green"), "deny": ("❌ 已拒绝", "red")}
    if ok is True and action in decided:
        title, template = decided[action]
    elif ok is False:
        title, template = "⚠️ 没做成", "grey"
    else:
        title, template = "已处理", "grey"
    lines = [str(value.get("summary") or ""), str(message or "")]
    return {
        "config": {"wide_screen_mode": True},
        "header": {"title": {"tag": "plain_text", "content": title},
                   "template": template},
        "elements": [{"tag": "markdown", "content": line} for line in lines if line]
                    + [{"tag": "hr"}, {"tag": "markdown", "content": "via **OCC**"}],
    }


def _button(action: dict, index: int) -> dict:
    """一个按钮。**只有回调型一种**（带 `value`：点了平台把这次点击推回给我们）。

    回调体里带着**点击者的 open_id**——证据是"谁点的"，比"发给谁的"硬。链接型
    （带 `url`）那条路已经删了，所以这里连分支都不留：**按钮按不动的时候要一眼看得
    出来**（宿主不发没有 `command` 的动作，见 `gateway/output/callback.py::card_for`），
    而不是画一个点开是个死页面的按钮。
    """
    return {
        "tag": "button",
        "text": {"tag": "plain_text", "content": str(action.get("label") or "打开")},
        "type": "primary" if index == 0 else "default",
        "value": dict(action.get("value") or {}),
    }


def _feishu_card(card: dict) -> dict:
    """**中性卡 → 飞书的卡片**（`{"title", "lines", "actions"}`）。

    骨架照 occ-os 那份（`config` + `header` + `markdown` 元素 + `hr` 尾巴），
    只是把"正文几行"换成宿主给的那几行，末尾多一个按钮块。

    按钮只认带 `value` 的动作——**没带的不画**：画一个按不动的按钮，比不画更糟。
    宿主那份描述里本来也只有这一种（`gateway/output/callback.py::card_for`）。
    """
    lines = [str(line) for line in card.get("lines") or []] or ["（没有正文）"]
    elements: list[dict] = [{"tag": "markdown", "content": line} for line in lines]
    actions = [action for action in card.get("actions") or [] if action.get("value")]
    if actions:
        elements.append({
            "tag": "action",
            "actions": [_button(action, index) for index, action in enumerate(actions)],
        })
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": str(card.get("title") or "OCC")},
            "template": "orange",
        },
        "elements": elements + [{"tag": "hr"},
                                {"tag": "markdown", "content": "via **OCC**"}],
    }
