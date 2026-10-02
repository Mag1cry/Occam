"""**包内的一条消息通道**：宿主往外送东西的那只手。

## 它和工具不是一类

| | 工具 | 通道 |
| --- | --- | --- |
| 谁调它 | **执行者**（经判决管线，要审批） | **宿主自己** |
| 它是 | 一个被允许的动作 | 一只往外送的手 |
| 判决 | `gateway/function/` 那条四步 | 没有——送消息不是"请求许可" |

所以它**不走 `function/`**：把"给飞书发一张卡片"做成一个要审批的工具，等于问用户
"我可以通知你吗"。

## 契约（鸭子类型）

```python
enabled() -> bool                    必选：凭据齐不齐（门面据此过滤）
send_text(text) -> dict              必选：文本消息
send_card(card) -> dict              可选：富文本卡片（没有就回落 send_text）
why_not() -> str                     可选：没配好时缺的是哪一格
who                                  可选：发给谁（收件人）
arm(on_action) -> None               可选：**收下"回话"这个口子**（见下）
```

## `arm(on_action)`：**插件回调宿主**的那条路，**按需**接上

只在"外面点得回来"的那种通道上实现。宿主**不是**在启动时叫它，而是在**第一次真的
要把东西送出去之前**叫一次（`gateway/output/paths.py::ChannelPath.deliver`）——
递进去的是**一个口子**：外面发生了什么，就调 `on_action(payload)`，拿回
**`(成没成, 那句话)`**。

**为什么是这一刻**：回来路是**通道自己的事**，而它可能有前提。飞书那条长连接是
我们**出站**连过去的（不占端口、不需要公网、不需要任何人够得到这台机器），但它
**占的是独占资源**——同一应用的多条连接会互相吃事件（集群模式，不广播）。所以
**没东西要送的时候就不该连着**：宿主只说"我可能有需要人拍板的东西了"，通道自己
决定什么时候把插座插上、插在哪儿。这里就是唯一的那一刻。

**"成没成"是给卡片用的**：点完那条消息要原地换成「已批准」还是「没做成」，靠它判
——**不靠猜那句话的文案**（文案是给人看的、会改；卡片标题写错就是给用户看了个假状态）。
只返回一句话也认，那就按"没结论"画，不替它判成功。

平台上有人点了卡片按钮，通道把那次点击转成 `on_action({...})`，宿主再把它变成一条
**带证据的命令**（`gateway/output/callback.py::decide`）。

**它必须自己管住生死**：回来路起在自己的线程里（`arm()` 不该阻塞宿主），宿主关停时
`close()` 要说停就停。

**内容由宿主描述、通道负责渲染**：宿主给的是一张中性卡
（`{"title": ..., "lines": [...], "actions": [{"label", "url"}]}`），
飞书把它渲成自己的卡片 JSON，纯文本通道回落成一行字。

## 一个类实例，一个包

和工具一样：入口指向的东西是一个**类就实例化一次**，是一个对象就用它本身。所以
一条通道可以在自己身上缓存 token（飞书那 2 小时的 tenant_access_token 就是这么攒的）。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .manifest import Channel as Declaration

#: 一条通道必须有的两格。**少了就不是通道**——加载期就拒，不留到发送那一刻。
REQUIRED_METHODS = ("enabled", "send_text")


class ChannelInstance:
    """**起好了的一条通道**：声明 + 那个活的实例。"""

    def __init__(self, declaration: Declaration, instance: Any) -> None:
        self.declaration = declaration
        self.name = declaration.name
        self.instance = instance

    def enabled(self) -> bool:
        """凭据齐不齐。**探测失败按未启用处理**——一条通道连自己能不能用都答不上来，
        就不该在发送时才发现。"""
        try:
            return bool(self.instance.enabled())
        except Exception:                    # noqa: BLE001 — 见上
            return False

    def why_not(self) -> str:
        """**它为什么没配好**——说人话的一句（可选实现，缺省给一句笼统的）。

        没有它的话，"通道装了但一直没动静"要靠人去翻文档才知道缺哪个环境变量——
        而这正是那种"静默地把配置错误说成没配置"的活。执行者那边早有 `why_not`，
        这里照同一条。
        """
        reason = getattr(self.instance, "why_not", None)
        if callable(reason):
            try:
                return str(reason())
            except Exception as exc:            # noqa: BLE001 — 它自己也答不上来
                return f"{type(exc).__name__}: {exc}"
        return "没有配好（看这个包的说明要哪些环境变量）"

    def has_return_path(self) -> bool:
        """这条通道**能自己把外面的动作带回来**吗（实现了 `arm` 就是能）。"""
        return callable(getattr(self.instance, "arm", None))

    def arm(self, on_action: Any) -> None:
        """把"回话"的口子递进去（**第一次要送东西出去时**才叫，见文件头）。

        没有 `arm` 的通道就是纯推送——**这是常态**，不是缺陷：它送出去的东西上
        不该有按钮，而"该不该有按钮"由宿主的 `card_for` 决定（它只发能回答的动作）。
        """
        arm = getattr(self.instance, "arm", None)
        if callable(arm):
            arm(on_action)

    def send_text(self, text: str) -> Any:
        return self.instance.send_text(text)

    def send_card(self, card: dict[str, Any]) -> Any:
        """没有 `send_card` 的通道回落成文本——**卡片是"更好看"，不是"必须"**。"""
        send = getattr(self.instance, "send_card", None)
        if callable(send):
            return send(card)
        return self.instance.send_text(_card_as_text(card))

    def close(self) -> None:
        """收掉这条通道（长连接要真的断掉，否则关停以后它还在那儿收消息）。"""
        close = getattr(self.instance, "close", None)
        if callable(close):
            close()


def _card_as_text(card: dict[str, Any]) -> str:
    lines = [str(card.get("title") or "")]
    lines.extend(str(line) for line in card.get("lines") or [])
    lines.extend(f"{action.get('label')}: {action.get('url')}"
                 for action in card.get("actions") or [])
    return "\n".join(line for line in lines if line)


def load_channel(package_dir: Path, declaration: Declaration) -> ChannelInstance:
    """把一条通道起起来。**它只 import 包自己的代码**（`entrypoint` 那一格）。"""
    from .tools import load_entrypoint

    target = load_entrypoint(package_dir, declaration.entrypoint)
    instance = target() if isinstance(target, type) else target
    for method in REQUIRED_METHODS:
        if not callable(getattr(instance, method, None)):
            raise ValueError(
                f"{declaration.name} 的入口 {declaration.entrypoint} 里没有 {method}()——"
                f"一条通道至少要有 enabled() 和 send_text()")
    return ChannelInstance(declaration, instance)
