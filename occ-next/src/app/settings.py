"""环境变量与默认路径。

## 两个根，别混

| 根 | 装什么 | 谁能读 |
| --- | --- | --- |
| **工作区**（`workspace`） | 任务正文、工具读写的东西 | **执行者**——工具的 jail 就是它 |
| **状态目录**（`state`） | 内核库、启动记录、派发记录、审计流水、**访问令牌** | 只有宿主 |

**这两个根必须分开。** 工作区的读工具是给执行者用的（`read_text("data/…")` 曾经
读得到访问令牌，已实测），把令牌放在它们读得到的地方，等于把"能拿到令牌"降级成
"能跑一个只读工具"。

## 三个小库各有各的文件

内核的控制库只有一个（`core/kernel.py` 定义"内核只存两样东西"）。外围这几个各有各的
表、各有各的读者，所以各住一个文件：启动记录、派发记录、网关审计。混进控制库的话，
迟早有人拿它们当控制事实用。

← 来自 composition/settings.py（配置状态库已删：开关就是声明里那一行）
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_ROOT = Path(__file__).resolve().parents[2]

#: 手写的配置放这儿（**不是状态目录**）：`config/.env`。
#:
#: 两者装的东西不一样，所以分开放：
#:
#: | 目录 | 谁写 | 装什么 |
#: | --- | --- | --- |
#: | `data/` | **程序** | 库、令牌、签名密钥、发出去的链接账 |
#: | `config/` | **人** | 这台机器的秘密与运行参数（`config/.env`） |
#:
#: 混在一起的话，"备份"和"改配置"就成了同一件事的两副面孔。
CONFIG_DIR = "config"
ENV_FILE = ".env"


def load_env_file(root: str | Path | None = None) -> list[str]:
    """把 `config/.env` 读进环境里，返回**真正新加进去的那些变量名**。

    ## 为什么不覆盖已有的

    **"环境变量 > .env"**：`$env:OCC_NEXT_HOST='0.0.0.0'; uv run occ-next`
    这种临时覆盖必须永远赢——不然调试的时候你会怀疑自己在改哪个值。
    （`override=False`，`python-dotenv` 的默认值。）

    ## 为什么由**入口**调用

    这个函数会改进程的环境，而环境是**入口的事**（systemd / 任务计划 / 启动脚本 /
    `uvicorn --env-file` 都是这个角色）。放进 `Settings.from_env()` 的话，
    任何跑测试的手一抖就会把开发机上真实的凭据灌进来——测试不该有那种威力。
    所以它只在 `serve.py` 启动入口装配系统之前被调用。

    ## `config/` 在哪个根下

    **根**（`OCC_NEXT_ROOT`，默认就是这个项目目录）——不是状态目录。这一点是刻意的：
    状态目录的路径本身要靠环境变量才知道，而"去哪儿找 .env"不能也变成一道谜题。
    """
    from dotenv import dotenv_values

    base = Path(root).resolve() if root is not None else _default_root()
    path = base / CONFIG_DIR / ENV_FILE
    if not path.is_file():
        return []
    added: list[str] = []
    for key, value in dotenv_values(path).items():
        if not key or value is None:
            continue
        if key in os.environ:
            continue                      # 环境变量优先（见上）
        os.environ[key] = value
        added.append(key)
    return added


def parse_allowed_origins(raw: str) -> tuple[str, ...]:
    """`OCC_NEXT_ALLOWED_ORIGINS` → 一串**裸 origin**。空/只有一个逗号 = 空清单。

    ## 为什么是精确白名单，不是 `*`

    局域网内后端**按来源 IP 放行、不要令牌**（`gateway/access/policy.py`）。CORS 要是
    写成 `*`，用户浏览器里**任意一个网页**都能 `POST http://192.168.x.x:8765/api/command`，
    而那个请求会被**当作局域网自动信任**——`mcp.register` 再把 payload 交给 `Popen`。
    `*` 在这里等于给每个网站发一台能起进程的机器。

    所以这里只接受**逐字比对**的 origin：`https://localhost.evil.com`、`https://localhost/`、
    `https://localhost:443`、`https://LOCALHOST` 都是不同的字符串，一个都不匹配
    （`:443` 那条尤其反直觉，但浏览器报的 origin 也就不带默认端口，两边一致）。

    ## 为什么不合规就抛

    打错的清单是 **fail-closed** 的——请求全被挡掉。但它**表现成一个浏览器 CORS 错误**：
    后端一切正常、日志里什么都没有，你要对着一个看不懂的前端报错查半天。这个仓库躲的就是
    这一类问题（`_mount_web` 里"设了但目录不在要说出来"是同一个立场），所以宁可在启动那一刻
    就指名道姓地炸掉。`ValueError` 从 `from_env` 冒出，`serve.py` 的装配阶段直接失败。
    """
    entries = [item.strip() for item in raw.split(",")]
    return tuple(_one_origin(item) for item in entries if item)


def _one_origin(entry: str) -> str:
    """一个条目 → 它自己，或者一条说清楚哪儿不对的 `ValueError`。"""
    parts = urlsplit(entry)
    why = ""
    if parts.scheme not in ("http", "https"):
        why = "只认 http:// 或 https:// 开头"
    elif not parts.hostname:
        why = "没有主机名"
    elif parts.path or parts.query or parts.fragment:
        why = "只能写到端口为止，后面不许有路径、查询或片段"
    elif parts.username or parts.password:
        why = "不许带用户名密码"
    elif entry != entry.lower():
        why = "必须全小写（浏览器报的 origin 就是小写，大写永远匹配不上）"
    if why:
        raise ValueError(
            f"OCC_NEXT_ALLOWED_ORIGINS 里的这一条不对：{entry!r}——{why}。"
            f"正确写法形如 https://localhost 或 http://192.168.1.9:8765")
    return entry


@dataclass(frozen=True)
class Settings:
    root: Path
    database: Path
    workspace: Path
    extensions: Path
    host: str = "127.0.0.1"
    port: int = 8765
    #: 前端构建产物（`occ-command-center/dist`）在哪儿。**空 = 不挂**——开发时
    #: 界面归 vite dev（5173，带热更新），这时候再在这儿挂一份旧的构建产物，
    #: 只会让人对着一个不会变的东西调界面。
    web_dir: Path | None = None
    #: 允许跨域访问 `/api/` 的**裸 origin** 白名单。**空 = 一条 CORS 头都不加**
    #: （本机与局域网形态就是这个）。解析规则见 `parse_allowed_origins`。
    allowed_origins: tuple[str, ...] = ()

    @property
    def state(self) -> Path:
        """宿主状态。**它不在工作区里**（见上）。"""
        return self.database.parent

    @property
    def executor_data(self) -> Path:
        """**执行者的数据**（checkpoint、它的结果）——不是控制库。

        起 worker 时给它的就是这一个路径。**Worker 从不打开控制库**：它不认识
        Task 表，也不该认识。这个文件归执行者的包用，内核从不读它。
        """
        return self.state / "occ-next-executor-data.sqlite"

    @property
    def access_token(self) -> Path:
        return self.state / "access-token.json"

    @property
    def access_devices(self) -> Path:
        """已接入设备的台账。**和令牌同一个理由放在状态目录**：

        工作区的读工具是给执行者用的，把凭据放在它们读得到的地方，等于把
        "能拿到凭据"降级成"能跑一个只读工具"。里面只有摘要（`pairing.py` 存 SHA-256），
        但那是第二道，不是第一道。
        """
        return self.state / "access-devices.json"

    @property
    def launches(self) -> Path:
        """Worker 启动记录——**对账的依据**（`tasks/launches.py`）。"""
        return self.state / "occ-next-launches.sqlite"

    @property
    def dispatches(self) -> Path:
        """派发记录。它的唯一读者是 `tasks/scheduler.py`。"""
        return self.state / "occ-next-dispatches.sqlite"

    @property
    def audit(self) -> Path:
        """网关流水。**不是内核的事实**（`gateway/audit.py`）。"""
        return self.state / "occ-next-gateway.sqlite"

    def prepare(self) -> "Settings":
        """把该有的目录建出来。**幂等**——每次启动都能调。"""
        for path in (self.state, self.workspace, self.extensions):
            path.mkdir(parents=True, exist_ok=True)
        return self

    @classmethod
    def from_env(cls, root: str | Path | None = None) -> "Settings":
        base = Path(root).resolve() if root is not None else _default_root()

        def where(name: str, default: Path) -> Path:
            value = Path(os.environ.get(name, str(default)))
            return value.resolve() if value.is_absolute() else (base / value).resolve()

        state = where("OCC_NEXT_STATE_DIR", base / "data")
        # 前端产物：**设了才挂**（见字段说明）。没设就是 `None`，路由一棵都不多。
        web = os.environ.get("OCC_NEXT_WEB_DIR", "").strip()
        return cls(
            root=base,
            database=where("OCC_NEXT_DB", state / "occ-next-v1-control.sqlite"),
            workspace=where("OCC_NEXT_WORKSPACE", base / "workspace"),
            extensions=where("OCC_NEXT_EXTENSIONS_DIR", base / "extensions"),
            host=os.environ.get("OCC_NEXT_HOST", "127.0.0.1"),
            port=int(os.environ.get("OCC_NEXT_PORT", "8765")),
            web_dir=where("OCC_NEXT_WEB_DIR", Path(web)) if web else None,
            allowed_origins=parse_allowed_origins(
                os.environ.get("OCC_NEXT_ALLOWED_ORIGINS", "")),
        )


def _default_root() -> Path:
    configured = os.environ.get("OCC_NEXT_ROOT")
    return Path(configured).resolve() if configured else DEFAULT_ROOT
