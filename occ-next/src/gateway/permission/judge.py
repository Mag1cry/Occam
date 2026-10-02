"""判决的顺序器：**只声明允许，默认拒绝**。它自己一条判据都没有。

```python
judge([Requirement(工具被声明过, ...), Requirement(执行者被允许用它, ...)])  → Decision
```

它只保证两件事：**顺序一致**、**判决是一个形状**。

## 规则只声明"允许"

每一条是一个**必须成立的条件**，不是"禁止什么"：

- 全成立 → `allow`
- 任何一条不成立 → `deny`，用**那一条**的理由
- 一条都没有 → `default`

**默认拒绝**——"没被任何规则允许"就是拒绝，不需要有人显式禁止。这不只是保守，
它是**可读性**：读一遍规则列表就知道什么被允许；读一份"允许 + 禁止"混在一起的清单，
你永远不知道有没有漏掉一条。

（"来源不在信任网段，也没有凭据"这种**或**的关系，写进**一条** Requirement 的
`ok` 里——顺序器只管与，不管或。）

## 判决之后还有一步：定性

**"能不能调"和"要不要人批"是两件事**，所以是两步。`classify()` 是第二步：
它唯一读的是**显性声明的那一格**——工具不说它要不要批，就没有"默认不用批"这回事
（`approval_required` 是契约表里的必填项）。

← 新建
"""
from __future__ import annotations

from dataclasses import dataclass

from .decision import ALLOW, DENY, NEEDS_APPROVAL, Decision


@dataclass(frozen=True)
class Requirement:
    """一条**必须成立**的条件。`reason` 是它不成立时要说的话。"""

    ok: bool
    reason: str = ""


def judge(requirements, *, default: str = DENY) -> Decision:
    """全成立 → 放行；任何一条不成立 → 用它自己的理由拒绝；**一条都没有 → `default`**。

    `default` 只在**没有任何条件**的时候生效——它就是"没被任何规则允许"那句话本身。
    条件都在、而且都成立，答案是允许，不是"没被允许"。
    """
    checked = list(requirements)
    if not checked:
        return Decision(default, "" if default == ALLOW else "没有任何一条规则允许它")
    for requirement in checked:
        if not requirement.ok:
            return Decision(DENY, requirement.reason)
    return Decision(ALLOW)


def classify(*, approval_required: bool) -> Decision:
    """定性：允许，但要先问人吗？

    **只有显性声明能把它变成 `needs_approval`。** 声明说是安全的就是安全的——
    工具的 `annotations` 那种服务器自报的提示不算，那是自证。
    """
    if approval_required:
        return Decision(NEEDS_APPROVAL, "这个供给要求人批")
    return Decision(ALLOW)
