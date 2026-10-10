"""设备配对：**请求接入 → 局域网里的人批准 → 按设备签发凭据**。

这里**全程走 HTTP**，不碰 `PairingDesk` 的内部——测的是契约：
一个没有任何凭据的外网来源，能不能靠"人点了一下头"变成一台被认得的设备。

最要紧的一条钉在最后：**凭据只交付一次**，以及**吊销立刻生效**。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.gateway.access.pairing import (
    CODE_ALPHABET,
    CODE_TTL_SECONDS,
    MAX_PENDING,
    MAX_REQUESTS_PER_WINDOW,
    PairingDesk,
)
from tests.support.newtree import application

LOCAL = ("127.0.0.1", 51234)
REMOTE = ("8.8.8.8", 51234)


@pytest.fixture
def app(tmp_path: Path):
    application_ = application(tmp_path)
    yield application_
    application_.shutdown()


@pytest.fixture
def 手机(app):
    """**没有任何凭据**的外网来源——就是那台要接入的手机。"""
    with TestClient(app.app, client=REMOTE) as made:
        yield made


@pytest.fixture
def 本机(app):
    """局域网里的你——后端本来就信任这个来源，所以能看能批。"""
    with TestClient(app.app, client=LOCAL) as made:
        yield made


def auth(app, credential: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {credential}"}


# ── 一条完整的路

def test_从零到接入(手机, 本机, app):
    # ① 手机请求
    asked = 手机.post("/api/access/request", json={"device_name": "Pixel 8"})
    assert asked.status_code == 200
    entry = asked.json()
    assert entry["ok"] is True
    assert entry["device_name"] == "Pixel 8"

    # ② 本机那边看得见这条待批，而且**有码可以核**
    waiting = 本机.get("/api/access/pending").json()["pending"]
    assert [item["request_id"] for item in waiting] == [entry["request_id"]]
    assert waiting[0]["code"] == entry["code"], "两边必须是同一个码——那就是人工闸门"

    # ③ 本机点头
    assert 本机.post("/api/access/approve",
                     json={"request_id": entry["request_id"]}).status_code == 200

    # ④ 手机取到凭据
    got = 手机.get("/api/access/status", params={"request_id": entry["request_id"]}).json()
    assert got["state"] == "approved"
    credential = got["credential"]
    assert credential

    # ⑤ 现在它是一台被认得的设备了
    assert 手机.get("/api/state", headers=auth(app, credential)).status_code == 200

    # ⑥ 台账里认得出它叫什么
    devices = 本机.get("/api/access/devices").json()["devices"]
    assert [d["name"] for d in devices] == ["Pixel 8"]


def test_请求和查询这两条免鉴权(手机):
    """**请求方就是还没进来的人** —— 给它们挂 guard 等于把门锁在门里。"""
    assert 手机.post("/api/access/request", json={"device_name": "x"}).status_code == 200
    assert 手机.get("/api/access/status", params={"request_id": "nope"}).status_code == 200


def test_外网没凭据批准不了(手机):
    """**批准端要 guard。** 不设这道，谁都能给自己批。"""
    assert 手机.post("/api/access/approve",
                     json={"request_id": "whatever"}).status_code == 401
    assert 手机.get("/api/access/pending").status_code == 401
    assert 手机.post("/api/access/revoke", json={"device_id": "x"}).status_code == 401


# ── 凭据的一次性

def test_凭据只交付一次(手机, 本机, app):
    """取走即删。**那个槽位握着一份明文凭据**，留着就是多一个可偷的地方。"""
    entry = 手机.post("/api/access/request", json={"device_name": "Pixel 8"}).json()
    本机.post("/api/access/approve", json={"request_id": entry["request_id"]})

    first = 手机.get("/api/access/status", params={"request_id": entry["request_id"]}).json()
    second = 手机.get("/api/access/status", params={"request_id": entry["request_id"]}).json()

    assert first["state"] == "approved" and first["credential"]
    assert second["state"] == "unknown", "第二次还拿得到，等于凭据一直躺在服务器上"


def test_过期和没见过的请求同一个答复(手机):
    """**这里不该成为一把可探的尺子**：不认识的、过期的、被拒的，答复要一样。"""
    assert 手机.get("/api/access/status", params={"request_id": "从没存在过"}).json() == {
        "state": "unknown"}


def test_拒绝了就是拒绝了(手机, 本机):
    entry = 手机.post("/api/access/request", json={"device_name": "Pixel 8"}).json()
    assert 本机.post("/api/access/deny", json={"request_id": entry["request_id"]}).status_code == 200
    assert 手机.get("/api/access/status",
                    params={"request_id": entry["request_id"]}).json()["state"] == "unknown"
    assert 本机.get("/api/access/pending").json()["pending"] == []


# ── 吊销

def test_吊销立刻生效(手机, 本机, app):
    """**凭据对不对是每次请求现场比台账**，不是在启动时抄一份——所以吊销不用重启。"""
    entry = 手机.post("/api/access/request", json={"device_name": "Pixel 8"}).json()
    本机.post("/api/access/approve", json={"request_id": entry["request_id"]})
    credential = 手机.get("/api/access/status",
                        params={"request_id": entry["request_id"]}).json()["credential"]
    device_id = 本机.get("/api/access/devices").json()["devices"][0]["device_id"]

    assert 手机.get("/api/state", headers=auth(app, credential)).status_code == 200
    assert 本机.post("/api/access/revoke", json={"device_id": device_id}).status_code == 200
    assert 手机.get("/api/state", headers=auth(app, credential)).status_code == 401


# ── 不落明文

def test_台账里没有明文凭据(tmp_path):
    """令牌必须明文（人要读它）；**设备凭据不必**——服务端从不展示它，只存摘要。"""
    desk = PairingDesk(tmp_path / "devices.json")
    entry = desk.request(device_name="Pixel 8", host="8.8.8.8")
    desk.approve(entry.request_id)
    credential = desk.result(entry.request_id)["credential"]

    raw = (tmp_path / "devices.json").read_text(encoding="utf-8")
    assert credential not in raw
    assert json.loads(raw)["devices"][0]["credential_hash"]
    assert desk.verify(credential) is not None


def test_凭据错了就是没有(tmp_path):
    desk = PairingDesk(tmp_path / "devices.json")
    assert desk.verify("") is None
    assert desk.verify("猜的") is None


# ── 免鉴权那两条自己扛的三件事

def test_限速(tmp_path):
    """配对被塞满 = 批准界面被刷爆 = 拒绝服务。所以同一来源一个窗口内只许几条。"""
    desk = PairingDesk(tmp_path / "devices.json")
    ok = [desk.request(device_name="x", host="8.8.8.8") for _ in range(MAX_REQUESTS_PER_WINDOW)]
    assert all(entry is not None for entry in ok)
    assert desk.request(device_name="x", host="8.8.8.8") is None, "超了就该拒"

    # **换个来源不受影响**——限的是那一个来源，不是全局
    assert desk.request(device_name="x", host="9.9.9.9") is not None


def test_队列有上限(tmp_path):
    desk = PairingDesk(tmp_path / "devices.json")
    for i in range(MAX_PENDING):
        assert desk.request(device_name=f"d{i}", host=f"10.0.0.{i}") is not None
    assert desk.request(device_name="挤不进来", host="11.0.0.1") is None


def test_待批会自动过期(tmp_path):
    now = [0.0]
    desk = PairingDesk(tmp_path / "devices.json", clock=lambda: now[0])
    entry = desk.request(device_name="Pixel 8", host="8.8.8.8")

    now[0] = CODE_TTL_SECONDS - 1
    assert [item.request_id for item in desk.pending()] == [entry.request_id]

    now[0] = CODE_TTL_SECONDS + 1
    assert desk.pending() == []
    assert desk.result(entry.request_id)["state"] == "unknown"


def test_批了但没人来取的也会清掉(tmp_path):
    """**那个槽位握着一份明文凭据**，不能让它一直待着。"""
    now = [0.0]
    desk = PairingDesk(tmp_path / "devices.json", clock=lambda: now[0])
    entry = desk.request(device_name="Pixel 8", host="8.8.8.8")
    desk.approve(entry.request_id)

    now[0] = CODE_TTL_SECONDS + 1
    assert desk.result(entry.request_id)["state"] == "unknown"


def test_空设备名不收(tmp_path):
    """名字是人在设备列表里认出它的唯一依据——空名字等于列表里一排"unknown"。"""
    desk = PairingDesk(tmp_path / "devices.json")
    assert desk.request(device_name="   ", host="8.8.8.8") is None


# ── 码

def test_码里没有易混字符():
    """**这串是给人念、给人对的。** 认错一个字符就等于批准了错的人。"""
    for confusing in "01OIL":
        assert confusing not in CODE_ALPHABET
    assert len(set(CODE_ALPHABET)) == len(CODE_ALPHABET), "字母表里不该有重复"
