"""设备配对：**请求接入 → 局域网里的人批准 → 按设备签发凭据**。

```python
desk = PairingDesk(Path("data/access-devices.json"))
entry = desk.request(device_name="Pixel 8", host="8.8.8.8")   # 手机那台，没有凭据
desk.approve(entry.request_id)                                # 局域网里的你点头
desk.verify(credential)                                       # 之后每次请求走这里
```

## 为什么不复用那条访问令牌

令牌是**一根**：`data/access-token.json`，一台机器一根，所有设备共用。它有三个毛病：

1. **不好搬**——`secrets.token_urlsafe(32)` 是 43 个字符，在服务器上；手机上要么手打，
   要么把文件传过去。
2. **换一根就全部失效**——手机丢了要换令牌，桌面浏览器跟着一起掉。
3. **认不出是谁**——审计里只有 `external@8.8.8.8`，看不出是哪台设备。

所以令牌留着当**根**（首次引导、桌面浏览器直接用），设备凭据是**按设备签发**的第二条路：
一个设备一条，能单独吊销，审计里认得出名字。

## 批准这一步必须"人对码"

手机屏幕上显示一个 8 位码，批准方屏幕上出现**同一个码**，人核对过才点头。

**没有这一步，谁先请求谁就拿到访问权**——请求端点是免鉴权的（它就是流程入口），
任何能碰到它的人都能往队列里塞一条。码就是那道人工闸门。

## 免鉴权的那两个端点

`POST /api/access/request` 和 `GET /api/access/status` **没有 guard**——请求方就是还没进来的人。
所以这一层自己扛三件事：

- **限速**：同一来源地址一个窗口内只许几条（`MAX_REQUESTS_PER_WINDOW`）；
- **短有效期**：待批 5 分钟（`CODE_TTL_SECONDS`），过期自动清；
- **队列有上限**：`MAX_PENDING`，塞满了直接拒——不然一个人就能把批准界面刷爆，
  而"刷爆"本身就是拒绝服务。

## 凭据只存摘要

令牌必须**明文**存（人要打开文件去读它）；设备凭据不必——**服务端从来不展示它**，
签发出去就不再需要原文。所以文件里存的是 SHA-256：偷看 `data/` 拿不到能用的凭据。

## 凭据只交付一次

批准之后凭据在 `_approved` 里等手机来取，**取走即删**。丢了就重新请求一遍——
这比"一直留着"安全（那个槽位本身就是一份明文凭据），也比"取不到就废掉"宽容。

← 新建（`web/http.py` 把它挂成路由，判决走 `policy.judge_caller`）
"""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

#: 码的字母表。**去掉了 0/O/1/I/L**——这串是给人念、给人对的，
#: 认错一个字符就等于批准了错的人。
CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LENGTH = 8

#: 待批活多久。够你从手机上读到、走回电脑前点下去。
CODE_TTL_SECONDS = 300.0

#: 待批队列的上限。**没有它，一个人就能把批准界面刷爆**，而刷爆本身就是拒绝服务。
MAX_PENDING = 8

#: 同一个来源地址，一个窗口内只许请求几次。配对是**人的动作**，不是高频接口。
REQUEST_WINDOW_SECONDS = 600.0
MAX_REQUESTS_PER_WINDOW = 5

#: 写文件的节流：`verify` 每次请求都会刷新 `last_seen`，但不能每次都落盘。
LAST_SEEN_FLUSH_SECONDS = 60.0


def _hash(credential: str) -> str:
    return hashlib.sha256(credential.encode("utf-8")).hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _format_code() -> str:
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
    return f"{raw[:4]}-{raw[4:]}"


@dataclass(frozen=True)
class PendingRequest:
    """一条等着人点头的请求。**只活在内存里**——重启就没了，重新请求一次即可。"""

    request_id: str
    code: str
    device_name: str
    host: str
    created_at: float
    expires_at: float

    def public(self, now: float) -> dict[str, object]:
        return {
            "request_id": self.request_id,
            "code": self.code,
            "device_name": self.device_name,
            "host": self.host,
            "expires_in": max(0, round(self.expires_at - now)),
        }


@dataclass(frozen=True)
class Device:
    """一台已接入的设备。**凭据的原文不在这里**，只有摘要。"""

    device_id: str
    name: str
    credential_hash: str
    host: str = ""
    created_at: str = ""
    last_seen: str = ""

    def public(self) -> dict[str, object]:
        return {k: v for k, v in asdict(self).items() if k != "credential_hash"}


class PairingDesk:
    """待批队列 + 已接入设备台账。**进程内的一个对象**，由装配阶段建出来。"""

    def __init__(self, path: Path, *, clock=time.monotonic) -> None:
        self.path = path
        self._clock = clock
        self._pending: dict[str, PendingRequest] = {}
        #: `request_id -> (设备, 凭据原文, 批准时刻)`。**握着一份明文凭据**，所以有寿命。
        self._approved: dict[str, tuple[Device, str, float]] = {}
        self._requests_by_host: dict[str, list[float]] = {}
        self._devices: dict[str, Device] = self._load()
        self._last_flush = 0.0

    # ── 台账的读写

    def _load(self) -> dict[str, Device]:
        """读得回来就用它。**文件坏了当空**——那是可恢复的，而"起不来"不是。"""
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
            return {
                item["device_id"]: Device(**item)
                for item in saved.get("devices", [])
                if item.get("device_id")
            }
        except (OSError, ValueError, TypeError, KeyError):
            return {}

    def _flush(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"devices": [asdict(d) for d in self._devices.values()]}
        self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        self._last_flush = self._clock()

    # ── 请求端（免鉴权）

    def request(self, *, device_name: str, host: str) -> PendingRequest | None:
        """收一条接入请求。**回 `None` 就是拒了**，三种原因都归在这里：

        - 同一个来源地址请求得太密；
        - 待批队列满了；
        - 设备名是空的。

        调用方不该区分这几件事——**对一个免鉴权的端点，说得越细越像是在帮人试探**。
        """
        now = self._clock()
        self._sweep(now)

        name = device_name.strip()[:60]
        if not name:
            return None

        recent = [t for t in self._requests_by_host.get(host, []) if now - t < REQUEST_WINDOW_SECONDS]
        if len(recent) >= MAX_REQUESTS_PER_WINDOW:
            return None
        if len(self._pending) >= MAX_PENDING:
            return None

        self._requests_by_host[host] = [*recent, now]
        entry = PendingRequest(
            request_id=secrets.token_urlsafe(24),
            code=_format_code(),
            device_name=name,
            host=host,
            created_at=now,
            expires_at=now + CODE_TTL_SECONDS,
        )
        self._pending[entry.request_id] = entry
        return entry

    def result(self, request_id: str) -> dict[str, object]:
        """手机轮询这里。**凭据取走即删**——那个槽位本身就是一份明文凭据。"""
        now = self._clock()
        self._sweep(now)

        approved = self._approved.pop(request_id, None)
        if approved is not None:
            device, credential, _ = approved
            return {"state": "approved", "credential": credential, "device": device.public()}

        entry = self._pending.get(request_id)
        if entry is not None:
            return {"state": "pending", **entry.public(now)}
        # 不认识的、过期的、被拒的，**一律同一个答复**：这里不该成为一把可探的尺子
        return {"state": "unknown"}

    # ── 批准端（要 guard）

    def pending(self) -> list[PendingRequest]:
        self._sweep(self._clock())
        return sorted(self._pending.values(), key=lambda item: item.created_at)

    def approve(self, request_id: str) -> Device | None:
        """点头。**凭据在这里生成一次**，放在 `_approved` 等手机来取。"""
        now = self._clock()
        self._sweep(now)
        entry = self._pending.pop(request_id, None)
        if entry is None:
            return None

        credential = secrets.token_urlsafe(32)
        device = Device(
            device_id=secrets.token_hex(8),
            name=entry.device_name,
            credential_hash=_hash(credential),
            host=entry.host,
            created_at=_now_iso(),
            last_seen=_now_iso(),
        )
        self._devices[device.device_id] = device
        self._approved[request_id] = (device, credential, now)
        self._flush()
        return device

    def deny(self, request_id: str) -> bool:
        self._sweep(self._clock())
        return self._pending.pop(request_id, None) is not None

    def devices(self) -> list[Device]:
        return list(self._devices.values())

    def revoke(self, device_id: str) -> bool:
        gone = self._devices.pop(device_id, None)
        if gone is not None:
            self._flush()
        return gone is not None

    # ── 判决入口

    def verify(self, credential: str) -> Device | None:
        """这条凭据是哪台设备。

        **逐条比完再返回**，不提前 `return`——提前返回会让"第几条匹配"从耗时上漏出去。
        """
        if not credential:
            return None
        wanted = _hash(credential)
        found: Device | None = None
        for device in self._devices.values():
            if secrets.compare_digest(device.credential_hash, wanted):
                found = device
        if found is None:
            return None

        # 刷新"最近见过"——但要节流，否则每个请求都写一次盘
        now = self._clock()
        refreshed = Device(**{**asdict(found), "last_seen": _now_iso()})
        self._devices[found.device_id] = refreshed
        if now - self._last_flush > LAST_SEEN_FLUSH_SECONDS:
            self._flush()
        return refreshed

    # ── 过期清理

    def _sweep(self, now: float) -> None:
        for key, entry in list(self._pending.items()):
            if entry.expires_at <= now:
                self._pending.pop(key, None)
        # 批准了但没人来取的也清掉——**它手里握着一份明文凭据**
        for key, (_, _, approved_at) in list(self._approved.items()):
            if now - approved_at >= CODE_TTL_SECONDS:
                self._approved.pop(key, None)
