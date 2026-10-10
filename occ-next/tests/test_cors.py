"""跨域接入：**只对清单里的源、只在 `/api/` 上开一道口子。**

这道口子是给"界面不从后端同源加载"的客户端用的——Android 打包之后，WebView 从
`https://localhost` 提供资源，对后端就是跨域，而后端的立场一直是"一条 CORS 头都不加"。

它**不放松任何权限**：真请求照旧由 `guard` 这个 router 级依赖判决，所以
不存在的路径仍然是 404、没凭据的外网请求仍然是 401。变的只有响应头。

最要紧的一条钉在最下面：**预检过了，真请求仍然要凭据。**
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from src.app.settings import parse_allowed_origins
from tests.support.newtree import application

#: Capacitor Android 的默认 origin（`androidScheme: 'https'` + `hostname: 'localhost'`）。
ORIGIN = "https://localhost"

LOCAL = ("127.0.0.1", 51234)
REMOTE = ("8.8.8.8", 51234)   # 真的公网地址（203.0.113.x 在 ipaddress 里算"私有"）

PREFLIGHT = {
    "Origin": ORIGIN,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization,content-type",
}


@pytest.fixture
def app(tmp_path):
    application_ = application(tmp_path, allowed_origins=(ORIGIN,))
    yield application_
    application_.shutdown()


@pytest.fixture
def client(app):
    """**从外网来。** 这样"没凭据"和"有凭据"才分得开——局域网本来就不看凭据。"""
    with TestClient(app.app, client=REMOTE) as made:
        yield made


def auth(app) -> dict[str, str]:
    return {"Authorization": f"Bearer {app.token}"}


# ── 预检

def test_预检不用凭据也答_200(client):
    """**这就是整件事的入口。** 预检带不了 `Authorization`——浏览器在拿到许可之前
    不会发真请求。它要是被 `guard` 挡了，跨域客户端永远连不上。
    """
    response = client.options("/api/command", headers=PREFLIGHT)

    assert response.status_code == 200, "预检过不去，后面什么都别谈"
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert "POST" in response.headers["access-control-allow-methods"]
    assert "authorization" in response.headers["access-control-allow-headers"].lower()
    assert "content-type" in response.headers["access-control-allow-headers"].lower()


def test_预检不发_allow_credentials(client):
    """`Bearer` 不是 CORS 语义里的凭据（那个头管 cookie 和客户端证书）。
    发了它只会把许可放宽——平白多给浏览器一份信任。
    """
    response = client.options("/api/command", headers=PREFLIGHT)

    assert "access-control-allow-credentials" not in response.headers


@pytest.mark.parametrize("headers", [
    {"Access-Control-Request-Method": "DELETE"},
    {"Access-Control-Request-Headers": "x-not-allowed"},
])
def test_预检问不许可的东西就是_400(client, headers):
    assert client.options("/api/command", headers={**PREFLIGHT, **headers}).status_code == 400


# ── 真请求

def test_清单里的源读得到_401_而且读得懂(client):
    """**401 必须带着 ACAO**。跨域 fetch 拿到没有 ACAO 的响应时，JS 读不到状态码，
    只拿到一个 `TypeError`——那"令牌不对"和"后端不可达"就分不开了，
    前端 `gatewayStore` 的 `unauthorized` 状态也就没有意义了。
    """
    response = client.get("/api/state", headers={"Origin": ORIGIN})

    assert response.status_code == 401
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert response.headers["vary"] == "Origin"
    assert "Bearer" in response.headers.get("www-authenticate", ""), \
        "权限那条契约没变，还是这个头"


def test_清单里的源带着凭据就是正常请求(app, client):
    response = client.get("/api/state", headers={**auth(app), "Origin": ORIGIN})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN


def test_不存在的接口仍然是_404_而且带着_ACAO(client):
    """**权限是 router 级依赖那条规矩，这里一个字没改。**

    404 也要带 ACAO：不带的话前端读不到那个 404，就分不清"后端没这个接口"和
    "网络就断了"——而这两个要采取的下一步完全不同。
    """
    response = client.get("/api/没有这个", headers={"Origin": ORIGIN})

    assert response.status_code == 404
    assert response.headers["access-control-allow-origin"] == ORIGIN


def test_预检过了真请求仍然要凭据(app, client):
    """**反回归。** 跨域开了口子之后，这道门必须还是关着的：
    预检答 200 只是"允许浏览器发这个请求"，不是"允许这个人进来"。
    """
    assert client.options("/api/command", headers=PREFLIGHT).status_code == 200
    assert client.post("/api/command", headers={"Origin": ORIGIN},
                       json={"command": "create_task", "payload": {}}).status_code == 401
    assert client.post("/api/command", headers={**auth(app), "Origin": ORIGIN},
                       json={"command": "create_task",
                             "payload": {"summary": "跨域进来的", "executor_ref": "echo.run"}}
                       ).status_code == 200


# ── 长得像的，一个都不认

@pytest.mark.parametrize("origin", [
    "https://localhost.evil.com",
    "https://localhost/",
    "https://localhost:443",
    "https://LOCALHOST",
    "null",
])
def test_长得像的源连预检都过不去(client, origin):
    """**逐字比对，不做规范化。** 上面前三条都是"看着像"的写法：
    子域名、多一个斜杠、多一个默认端口。浏览器报的 origin 本来就不带默认端口，
    所以 `:443` 那条匹配不上不是 bug，是两边的写法本来就该一致。
    """
    assert client.options("/api/command",
                          headers={**PREFLIGHT, "Origin": origin}).status_code == 400
    assert "access-control-allow-origin" not in client.get(
        "/api/state", headers={"Origin": origin}).headers


# ── 清单之外的路径不掺和

@pytest.mark.parametrize("path", ["/docs", "/openapi.json", "/"])
def test_只有_api_开这个口子(client, path):
    """`/docs` 和 `/openapi.json` 注册在 `guard` 之外。没有这道路径闸门，
    清单里的源连它们都能读——那道口子就没有边界了。
    """
    assert "access-control-allow-origin" not in client.get(
        path, headers={"Origin": ORIGIN}).headers


# ── 清单空着 = 从来没有过 CORS

@pytest.mark.parametrize("raw", ["", "   ", " , "])
def test_清单空的时候一个中间件都不挂(tmp_path, raw, monkeypatch):
    monkeypatch.setenv("OCC_NEXT_ALLOWED_ORIGINS", raw)
    from src.app.settings import Settings

    assert Settings.from_env(tmp_path).allowed_origins == ()

    application_ = application(tmp_path)
    try:
        with TestClient(application_.app, client=REMOTE) as bare:
            # 预检落到真实路由上：GET-only 的 `/api/command` 不认 OPTIONS
            assert bare.options("/api/command", headers=PREFLIGHT).status_code == 405
            assert "access-control-allow-origin" not in bare.get(
                "/api/state", headers={"Origin": ORIGIN}).headers
    finally:
        application_.shutdown()


# ── 清单怎么解析

def test_清单按逗号切开_空白不算():
    assert parse_allowed_origins(" https://localhost , http://192.168.1.9:8765 ,, ") == (
        "https://localhost", "http://192.168.1.9:8765")


@pytest.mark.parametrize("bad,why", [
    ("*", "通配"),
    ("localhost", "没有 scheme"),
    ("ftp://localhost", "不是 http(s)"),
    ("https://", "没有主机名"),
    ("https://localhost/", "带了路径"),
    ("https://localhost:8765/x", "带了路径"),
    ("https://user:pw@localhost", "带了用户名密码"),
    ("https://LOCALHOST", "不是全小写"),
])
def test_不合规的条目启动就报错_而且指名道姓(bad, why):
    """打错的清单是 fail-closed 的（请求全被挡），但**表现成一个看不懂的浏览器
    CORS 错误**——后端一切正常、日志里什么都没有。所以宁可在启动那一刻炸掉。
    """
    with pytest.raises(ValueError) as caught:
        parse_allowed_origins(bad)

    assert bad in str(caught.value), f"{why}：错误里要出现那条原文，不然不知道改哪条"


def test_通配进不了清单():
    """单独再钉一次：`*` 是这里唯一"看起来能省事"的写法，而它在这个后端
    等于给每个网站发一台能起进程的机器——局域网是按来源 IP 免凭据放行的。
    """
    with pytest.raises(ValueError):
        parse_allowed_origins("https://localhost,*")
