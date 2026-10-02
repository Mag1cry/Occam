"""**输出路径**：同一条输出，送到不同的地方去。

## 内建的那条（前端）不需要投递

前端的"事实入口"是快照（`GET /api/state`），而 `standing()` 是无状态的派生——
所以**前端那条路的"送到"就是"出现在快照里"**：它不需要一个类、不需要一本账、
不需要在这里注册任何东西。这就是"输出是投影"的直接后果，也是这一层最小的证明：
一条路径要存在，必须真的有个"外面"要够。

真正需要一个类的是**主动往外送**的那些（飞书那种）：它们得自己记住"这一条送过了"
（否则事件每响一次就重发一张卡片），而那本账归**路径自己**——不是输出的属性。

## 逐条隔离

一条路径炸了不拖累别的（occ-os 的通道门面就是这么干的），所以这里返回的是
**逐条的回执**，不是一个成功/失败。调用方看回执决定要不要说一句——
**别把它吞掉**："飞书没送到"是用户要知道的事，静默等于假装送到了。
"""
from __future__ import annotations

from collections import OrderedDict
from typing import Any, Protocol

from . import callback as callback_module
from .output import Output

#: 每条通道记住多少条"送过了"。**它是一本账，不是一个状态**——只用来挡住重发，
#: 满了就丢最旧的（真丢了就重发一次，那张卡片上写着"这一件还悬着"，无害）。
SENT_MEMORY = 500


class OutputPath(Protocol):
    """一条能主动把输出送出去的路。

    `name` 只用来回报和排查（"哪条路没送到"）。
    """

    name: str

    def deliver(self, output: Output) -> None:
        """把这一条送出去。**送过了就什么都别做**——去重是这条路自己的账。"""
        ...


class ChannelPath:
    """**一条消息通道当成一条输出路径用。**

    它做三件事，别的什么都不做：

    1. **把输出变成一张中性卡**（正文里只有引用和一句话，见 `callback.card_for`）；
       `kind` 是 `result` 的那些**不主动送**——结果归内核，外面要看就去读（今天只有
       审批需要"推"：它卡着整条链）。
    2. **按钮上带这个"此刻的指纹"**（`_fingerprint_of`）：回来那一步靠它对上"就是
       这一刻这一件"（`callback.decide`），旧卡片因此自动作废。
    3. **第一次要送的时候，把"回话"的口子递给通道一次**（`arm`）——**回来路是通道
       自己的事**，而它可能有前提（飞书那条长连接占的是独占资源：同一应用的多条
       连接会互相吃事件，所以没东西要送时不该连着）。这一刻就是"有人可能要拍板了"，
       也就是唯一该把插座插上的时候。
    4. **自己记住送过没有**：事件每响一次就重发一张卡片，是这套东西最烦人的失败方式。

    **不落盘**（`SENT_MEMORY` 那本账住在内存里）：重启之后同一条还悬着的输出会再送
    一次。这是有意的取舍——多一张卡片 vs 多一张表要维护，而"它还悬着"这句话再送一遍
    并不假。
    """

    def __init__(self, channel: Any, *, kernel: Any, name: str = "",
                 answer: Any = None) -> None:
        self.channel = channel
        self.kernel = kernel
        self.name = name or f"channel:{getattr(channel, 'name', 'channel')}"
        #: "外面点了什么"该怎么答（宿主给的）。**在这一层只是转手**，判断不在这儿。
        self._answer = answer
        self._armed = False
        self._sent: OrderedDict[str, None] = OrderedDict()

    def deliver(self, output: Output) -> None:
        if output.kind != "approval":
            return                                   # 见类说明第 1 条
        if output.ref in self._sent:
            return                                   # 见类说明第 4 条
        self._arm()                                  # 见类说明第 3 条——**先接上再送**
        card = callback_module.card_for(
            output, fingerprint=self._fingerprint_of(output))
        self.channel.send_card(card)
        self._sent[output.ref] = None
        while len(self._sent) > SENT_MEMORY:
            self._sent.popitem(last=False)

    def _arm(self) -> None:
        """把口子递给通道**一次**。递不了就什么都不做——纯推送的通道是常态。

        **递在送之前**：卡片一出去就可能被点，而回来路（长连接）要花几百毫秒才连上，
        顺序反了那一会儿的点击就是白点的。
        """
        if self._armed or self._answer is None:
            return
        self._armed = True
        self.channel.arm(self._answer)

    def _fingerprint_of(self, output: Output) -> str:
        """这一件**此刻**的审批指纹。**发送时才取**——它绑的是"现在等的那一件"，
        而不是发送器启动时的那一件。"""
        task_id = output.target_ref.partition(":")[2] or output.target_ref
        try:
            return str(self.kernel.get_task(task_id).pending_fingerprint or "")
        except Exception:                            # noqa: BLE001 — 读不到就没有绑定
            return ""


class ChannelPaths:
    """**装了多少条通道，就有多少条输出路径。**

    它是装配期那个"加载期写入面"的一部分：包一多一条通道，这里就多一条路——
    加一条输出路径**只需要装一个包**，不改任何代码。

    内建的前端那条**不在这里**：它出现在快照里就是送到了（见文件头）。
    """

    def __init__(self, *, kernel: Any, answer: Any = None) -> None:
        self.kernel = kernel
        self.answer = answer
        self._paths: list[Any] = []

    def replace(self, channels: Any) -> None:
        """把通道清单换一份（加载期和热加载都走这儿，同 `Registry.replace`）。

        **只是换清单，不碰回来路**（`answer` 原样带着）：热加载之后那条长连接照旧，
        下一次投递会把口子递给新的那批通道。
        """
        self._paths = [ChannelPath(channel, kernel=self.kernel, answer=self.answer)
                       for channel in channels]

    @property
    def names(self) -> list[str]:
        return [path.name for path in self._paths]

    @property
    def enabled_paths(self) -> list[Any]:
        """**凭据齐了的那些**（照 occ-os 的通道门面：`enabled()` 说的算）。

        没凭据的通道不送，也不算失败——一条没配好的通道每次都说"我送不出去"，
        只会把真正要看的错误淹掉。
        """
        return [path for path in self._paths if path.channel.enabled()]

    def deliver(self, output: Output) -> list[dict[str, Any]]:
        """送一条给所有**能用**的通道。**逐条回执**——调用方拿它决定要不要说一句
        （"飞书没送到"是用户要知道的事，静默等于假装送到了）。"""
        return deliver_all(self.enabled_paths, output)


def deliver_all(paths: list[Any], output: Output) -> list[dict[str, Any]]:
    """把一条输出交给每条路，**逐条隔离**，返回逐条回执。

    只传到这儿的那些路：内建的前端那条不在这张表里（它出现在快照里就是送到了），
    见文件头。
    """
    results: list[dict[str, Any]] = []
    for path in paths:
        name = str(getattr(path, "name", type(path).__name__))
        try:
            path.deliver(output)
        except Exception as exc:                 # noqa: BLE001 — 单条路失败不拖垮
            results.append({"path": name, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
        else:
            results.append({"path": name, "ok": True})
    return results
