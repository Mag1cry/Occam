"""**供应商列表**：有哪些模型服务、怎么连、它认识哪些模型。

**它就是一个列表。** 声明在 `extensions/_providers/<name>.yaml` 里，加载期登记。

| 装什么 | 从哪来 |
| --- | --- |
| 怎么连 | `base_url` / `api_key_env` |
| 认识哪些模型 | `models[]` |
| 模型的事实（上下文长度那种） | 跟着 `models[]` 走——**这是事实，不是配置** |

## 谁读它

- **装配期**：起一个要模型的执行者时在这里查一次，把 `base_url` + 模型名解析成**终值**
  塞给 worker。**worker 在子进程里读不到这个列表**——这是"合并发生在装配期"那条的落点。
- **前端**：渲染"有哪些供应商、各自认识什么模型"。

**判决不读它。** 供应商不参与判决，它只回答"这个模型在哪、怎么连"。

## 它只回答"用哪家"，不回答"跑什么"

模型是**执行者的一个输入**。所以是执行者查它，**它不认识执行者**——
反过来记（供应商里列"哪些执行者用它"）会立刻长出一张要维护的双向表。

## 密钥只传**变量名**

`api_key_env` 是环境变量的名字，不是密钥本身。解析出来的终值里有名字、没有秘密——
秘密由 worker 那个进程自己从环境里读（`OPEN_ISSUES.md` 里那条待定项说的就是这条边界）。

← 新建（模型供应商从扩展包里搬出来，成为独立的声明）
"""
from __future__ import annotations

from typing import Any

from ...extensions.manifest import Provider


class ProviderDirectory:
    def __init__(self) -> None:
        self._items: tuple[Provider, ...] = ()

    def replace(self, items: tuple[Provider, ...]) -> None:
        self._items = tuple(items)

    def all(self) -> tuple[Provider, ...]:
        return self._items

    def get(self, name: str) -> Provider | None:
        for item in self._items:
            if item.name == name:
                return item
        return None

    def enabled(self) -> tuple[Provider, ...]:
        """能用的那些。**关着的仍然在 `all()` 里**——前端照常渲染它，只是点不动。"""
        return tuple(item for item in self._items if item.enabled)

    def model_of(self, ref: dict[str, Any] | None) -> dict[str, Any] | None:
        """`{provider: deepseek, name: x}` → 那条模型的声明（含它的事实）。"""
        if not ref:
            return None
        provider = self.get(str(ref.get("provider") or ""))
        if provider is None:
            return None
        for model in provider.models:
            if model.get("name") == ref.get("name"):
                return dict(model)
        return None

    def resolve(self, ref: dict[str, Any] | None) -> dict[str, Any]:
        """**给 worker 的那份终值。** 装配期调一次，之后它不知道自己错过了什么。

        解析不出来的引用也照答（`found: false`）——**不抛**：一个引用指向的供应商
        可能只是被删了，而那不是起 worker 的人能修的事。缺什么，引擎那边会自己报。
        """
        name = str(((ref or {}).get("provider")) or "")
        model_name = str(((ref or {}).get("name")) or "")
        provider = self.get(name)
        if provider is None:
            return {"found": False, "provider": name, "model": model_name,
                    "reason": f"没有这家供应商: {name}"}
        facts = self.model_of(ref) or {}
        return {
            "found": True,
            "provider": provider.name,
            "model": model_name,
            "base_url": provider.base_url,
            "api_key_env": provider.api_key_env,
            # 模型的事实跟供应商走：**执行者不用重写一遍上下文长度**。
            "context": facts.get("context"),
            "model_parameters": dict(facts.get("parameters") or {}),
        }
