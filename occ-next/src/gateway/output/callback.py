"""**回来那一步**：外面点了一下 → 一条带证据的命令。

## 只有一条回来路：回调型按钮

按钮带着 `value`（这件事的意图），点了之后平台把这次点击通过**我们连出去的那根连接**
推回来（飞书长连接，见 `extensions/feishu/channel.py::arm`）；通道把它交给宿主递给它的
那个口子（`app/build.py::answer`，装配期经 `paths.ChannelPath._arm` 递进去），
宿主调这里的 `decide`——**判断只有这一份**。

## 为什么不再有"签名链接"（记在这儿，免得将来有人又想加回来）

之前还并着一条路：按钮是个签名链接，点开落在本机的 `/api/decision` 上，验 HMAC。
删掉它的理由：

- **它要求"点的那台设备"够得到这台机器**。飞书服务器本来就够不到我们——那是
  本地优先的前提；而链接把这件事转嫁给了用户的手机：在 4G 下打不开，在局域网里
  也得这台机器正好在听、地址正好写对。
- **证据弱一格**：链接里能带的只有"发给谁"（`who`），写不进"谁点的"。而回调体里
  **天然带着点击者的身份**（`operator.open_id`），证据是硬的那一个。
- 长连接是**出站**的：不占端口、不需要公网、不需要任何人够得到这台机器。两条路
  留一条，留没有前提条件的那条。

链接还留下了两样东西：`data/link-secret.json`（签名密钥，不再生成）和
`OCC_NEXT_PUBLIC_URL`（那个"别人打得开"的地址，不再需要）。
"""
from __future__ import annotations

from typing import Any


def decide(payload: dict[str, Any], *, kernel: Any, facade: Any) -> tuple[bool, str]:
    """**把一次外部动作变成一条带证据的命令。**

    返回 `(成没成, 给他的那句话)`——调用方拿它写飞书的 toast 和那张原地替换的卡片。

    三条判断，缺一不可：

    1. **动作认得出**（`approve` / `deny`）——别的一律不认；
    2. **指纹对得上现在等的那一件**。按钮里的 `value` 只证明"这是发出去的那一条"，
       它**不证明"那一件还在等"**：工具请求换过一次，指纹就变了。少了这一步，
       "旧卡片自动作废"就只是文档里的一句话——那张卡片上的按钮点了还会生效；
    3. **证据写"谁点的"**（`channel:<who>`），不是"发给谁的"、更不是"本机操作员"。
    """
    task_id = str(payload.get("task_id") or "")
    action = str(payload.get("action") or "")
    who = str(payload.get("who") or "")
    fingerprint = str(payload.get("fingerprint") or "")
    if action not in ("approve", "deny"):
        return False, "看不懂这个动作"
    try:
        task = kernel.get_task(task_id)
    except Exception:                               # noqa: BLE001 — Task 没了就是没得批
        return False, "这件事已经不在等了"
    if task.pending_fingerprint != fingerprint:
        return False, "这件事已经变了（等的是另一件了）"
    try:
        facade.submit(action, {"task_id": task_id, "decision_ref": f"channel:{who}"})
    except Exception as exc:                        # noqa: BLE001 — 内核怎么拒的就怎么说
        return False, f"这一次没有生效：{exc}"
    return True, ("已批准。" if action == "approve" else "已拒绝。")


def card_for(output: Any, *, fingerprint: str) -> dict[str, Any]:
    """把一份输出变成一张**中性卡**——各个通道照着它渲染自己的样子。

    这张卡里**没有正文，只有引用和一句话**：正文归内核（结果在 `result_ref` 后面、
    审批在 Task 上），搬过来就会有两份会漂的说法（ADR-008 那条）。

    按钮只有一种形状：带 `value`（回调型）。**没有 `command` 的动作不发**——
    它按不动任何东西，给个按不动的按钮比不给更糟。
    """
    task_id = output.target_ref.partition(":")[2] or output.target_ref
    actions = []
    for action in output.actions:
        if not action.command:
            continue
        actions.append({
            "label": action.label,
            # **回调体里不带原卡片**，所以摘要要在这儿捎回去：飞书点完要**原地换卡**，
            # 而它只拿得到这个 `value`（见 `extensions/feishu/channel.py::_decided_card`）。
            "value": {"task_id": task_id, "action": action.command,
                      "fingerprint": fingerprint, "ref": output.ref,
                      "summary": output.summary},
        })
    return {"title": output.title, "lines": [output.summary], "actions": actions,
            "ref": output.ref, "kind": output.kind}
