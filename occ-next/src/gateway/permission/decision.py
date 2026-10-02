"""判决：允许 / 拒绝 / 需人批。**只有三种。**

两半共用同一套词——这是"一个网关"的最小证据：

| 半 | 它原来的说法 | 统一成 |
| --- | --- | --- |
| 对外界（`access/`） | 放行 / 401 | `allow` / `deny` |
| 对工具执行（`function/`） | `allow` / `deny` / `approval_required` | `allow` / `deny` / `needs_approval` |

**`needs_approval` 必须和另外两种并列，不能塌成一个布尔值**：`approved: false`
既可能表示"不许"，也可能表示"还没问"——而这两种要说的话完全不同。

← 新建：统一两套判决词。形状是新的，但来源分类早就在两半之间流动了
"""
from __future__ import annotations

from dataclasses import dataclass

ALLOW = "allow"
DENY = "deny"
NEEDS_APPROVAL = "needs_approval"

#: 封闭集合。判决只说这三种话。
OUTCOMES = (ALLOW, DENY, NEEDS_APPROVAL)


@dataclass(frozen=True)
class Decision:
    """一次判决。`reason` 是给人看的一句话——它同时也是审计里那一格。"""

    outcome: str
    reason: str = ""

    def __post_init__(self) -> None:
        if self.outcome not in OUTCOMES:
            raise ValueError(f"判决只能是 {' / '.join(OUTCOMES)}，收到: {self.outcome}")

    @property
    def allowed(self) -> bool:
        return self.outcome == ALLOW

    @property
    def needs_approval(self) -> bool:
        return self.outcome == NEEDS_APPROVAL
