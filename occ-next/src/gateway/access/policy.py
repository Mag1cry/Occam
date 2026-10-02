"""来源分级 + 令牌校验 + **令牌的生成与复用**。

```python
judge(Caller(host="192.168.1.9", token=""), token=load_or_create_token(path))  → Decision
```

## 判据

- **局域网（含回环）放行。** 它就在你手边，和坐在机器前没有区别。
- **外网必须凭据。** 凭据是这台机器自己生成、只存在本地的令牌——所以"能拿到它"
  等价于"你能接触这台机器"。
- 凭据与局域网**同权**：它是授权的证明，不是降级访问。真正的门是"从哪里来"。
- 令牌**总是自动生成**，不存在"忘了配"这个窗口。
- **解析不了一律算外网**——这就是"默认拒绝"在这里的样子。

判决翻译成 HTTP 由 `web/http.py` 做：`allow` → 放行；`deny` → 401 + `WWW-Authenticate`。

## 令牌放在**工作区之外**

`data/` 是宿主的状态目录，不是用户的工作区（`app/settings.py` 把这两个根分开）。
这不是洁癖：工作区的读工具是给执行者用的，把令牌放在它们读得到的地方，等于把
"能拿到令牌"降级成"能跑一个只读工具"。**两个根分开，这条假设才成立。**

## 别踩回去的坑

uvicorn 默认信任来自回环的 `X-Forwarded-For`。本机一旦有反向代理，客户端地址就变成
攻击者可控，LAN 检查可以被伪造——所以外网部署必须 `--no-proxy-headers`。

← 来自 access.py + web.py::_require_access 的判断部分
"""
from __future__ import annotations

import ipaddress
import json
import secrets
from dataclasses import dataclass
from pathlib import Path

from ..permission.decision import Decision
from ..permission.judge import Requirement, judge

LOCAL = "local"
LAN = "lan"
EXTERNAL = "external"

#: 放行的那两级。凭据能把外网提到同一档。
TRUSTED = (LOCAL, LAN)

#: 令牌文件的默认名字。**在状态目录里**，不在工作区里（见上）。
TOKEN_NAME = "access-token.json"


@dataclass(frozen=True)
class Caller:
    """一次请求从哪来、带了什么凭据。"""

    host: str = ""
    token: str = ""

    @property
    def level(self) -> str:
        """来源分级。**解析不了算外网**——碰到看不懂的来源，宁可要求凭据。"""
        try:
            address = ipaddress.ip_address(self.host.strip())
        except ValueError:
            return EXTERNAL
        if address.is_loopback:
            return LOCAL
        if address.is_private or address.is_link_local:
            return LAN
        return EXTERNAL


def judge_caller(caller: Caller, *, token: str) -> Decision:
    """放行条件是**一条**：在信任网段 **或** 凭据对。

    写成两条（来源一条、令牌一条）会把"外网 + 凭据正确"判成拒绝——顺序器只管与，
    而这里要的是或。
    """
    trusted = caller.level in TRUSTED
    presented = bool(token) and _matches(caller.token, token)
    return judge([Requirement(
        trusted or presented,
        "来源不在信任网段，凭据也不对" if not presented else "来源不在信任网段")])


def _matches(presented: str, expected: str) -> bool:
    """比值**比字节**，不是比字符串。

    `secrets.compare_digest` 碰到非 ASCII 的字符串会直接抛 `TypeError`——那意味着
    一个带中文的令牌会让接口回 500 而不是 401。编成字节就没有这个角落了。
    """
    return secrets.compare_digest(str(presented).encode("utf-8"), str(expected).encode("utf-8"))


def load_or_create_token(path: Path) -> str:
    """**生成一次、之后复用。** 读得回来就用回原来那条——重启一次换一次令牌，
    等于让所有已经拿到它的人静默失效。

    文件坏了（半截写入）就当没有，重新生成：那是可恢复的，而"起不来"不是。
    """
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
        token = str(saved.get("token") or "")
        if token:
            return token
    except (OSError, ValueError):
        pass
    token = secrets.token_urlsafe(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"token": token}, indent=2), encoding="utf-8")
    return token
