"""把装配好的系统**跑起来**：一个 ASGI 工厂 + 一个 uv 项目命令。

```powershell
uv run occ-next                 # 按 OCC_NEXT_HOST / OCC_NEXT_PORT 启动
uv run occ-next --reload        # 开发时自动重载
```

**装配发生在工厂被调用时，不在 import 时。** `--reload` 会反复 import 这个模块，而
建库、跑对账、起轮询线程都不是"看一眼代码"该干的副作用。

## 关停要跑完

Ctrl-C 之后 uvicorn 会让进程退出，而关停清单（停轮询 → 终止 worker → 收供给 → 关库）
**不是"进程要没了"就可以跳过的**：没杀干净的 worker 会活下来，而重启之后要靠对账才认得出
它们。所以挂 `atexit`——它是最后一道保证。

## 启动时把对账的结论说出来

诊断**不落库**（ADR-028），所以"上次有几个 Task 没跑完"这件事只在启动那一刻说得出口。
不说的话，它就是一个没人看见的返回值。

← 来自 web.py 的 `app = create_app()`（lifespan 里装配）+ `pyproject.toml` 的项目命令
"""
from __future__ import annotations

import argparse
import atexit
import sys
from pathlib import Path
from typing import Any


def make_app() -> Any:
    """给 uvicorn 的工厂。**每一次调用都是一次完整的装配。**"""
    runtime = _assembly()
    return runtime.app


def _load_configuration() -> None:
    from .app.settings import load_env_file

    # **先读 config/.env，再装配。** 环境是入口的事（systemd / 任务计划 / 启动脚本
    # 都是这个角色），放别处的话测试手一抖就会把开发机上真实的凭据灌进来。
    added = load_env_file()
    if added:
        print(f"[配置] 从 config/.env 读了 {len(added)} 项：{' · '.join(added)}", file=sys.stderr)


def _assembly(*, configuration_loaded: bool = False):
    if not configuration_loaded:
        _load_configuration()

    from .app.build import build

    runtime = build(start_scheduler=True)
    atexit.register(runtime.shutdown)
    _announce(runtime)
    return runtime


def _announce(runtime: Any) -> None:
    """把启动时该说的话说掉：对账看出来的东西 + 令牌在哪。"""
    report = runtime.reconciliation
    for note in report.notes:
        print(f"[对账] {note}", file=sys.stderr)
    if report.unresolved:
        print(f"[对账] {len(report.unresolved)} 个 Task 等着人确认——"
              f"它们的上一次启动可能还在跑，在那之前**不会被重新启动**", file=sys.stderr)
    if not runtime.settings.access_token.exists():
        print(f"[接入] 访问令牌已生成：{runtime.settings.access_token}", file=sys.stderr)
    # **装了通道、但位置不对**——这一句要说在前面：不然要等到"点了没反应"才发现，
    # 而那时候你查的是飞书，问题却在这边的配置上。
    for channel in runtime.loaded.channels:
        if not channel.enabled():
            # **装了但没配好**：不说的话，那条通道就是"永远不出声"——而用户以为配了
            print(f"[输出] 通道 {channel.name} 没配好，不会送：{channel.why_not()}",
                  file=sys.stderr)
        elif not channel.has_return_path():
            # **只送得出去、收不回来**：卡片上的按钮没有回来路，点了没人接。
            # 今天所有回调型按钮都靠 `start()` 那条常驻连接，没有它 = 点了没反应。
            print(f"[输出] 通道 {channel.name} 只能往外送，点不了（它没有实现 start）",
                  file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="启动 Occam 本地 Agent 执行控制面")
    parser.add_argument("--host", help="监听地址（默认读取 OCC_NEXT_HOST，缺省为 127.0.0.1）")
    parser.add_argument("--port", type=int, help="监听端口（默认读取 OCC_NEXT_PORT，缺省为 8765）")
    parser.add_argument("--reload", action="store_true", help="监视后端源码并在变更时重启")
    parser.add_argument("--no-proxy-headers", action="store_true",
                        help="不信任 X-Forwarded-* 头；有反向代理时建议启用")
    args = parser.parse_args(argv)

    # 配置文件需要在读取监听地址之前加载；reload 子进程会继承这些环境变量。
    _load_configuration()
    from .app.settings import Settings

    settings = Settings.from_env()
    host = args.host or settings.host
    port = args.port if args.port is not None else settings.port
    print(f"OCC 配置舱在 http://{host}:{port} （工作区 {settings.workspace}）", file=sys.stderr)

    import uvicorn

    common = {
        "host": host,
        "port": port,
        "proxy_headers": not args.no_proxy_headers,
    }
    if args.reload:
        # Uvicorn 子进程通过工厂装配，父进程只负责监视，不会额外启动调度器。
        watch_root = Path(__file__).resolve().parents[1]
        # **只盯源码。** 任务正文里出现 `.py`、`uv sync` 重写 `.venv`，都不是"代码改了"；
        # 让它们把开发服务器重启一遍，只会把一次调试切成几段。
        # **排除项必须是已存在的目录**：uvicorn 会把不存在的绝对路径当通配符去 glob，
        # 而 glob 不吃绝对路径（`NotImplementedError: Non-relative patterns are unsupported`）。
        settings.prepare()                    # 幂等，只是把状态目录/工作区建出来
        noise = {settings.state, settings.workspace, watch_root / ".venv",
                 watch_root / ".pytest-tmp", watch_root / ".pytest-tmp-cov",
                 watch_root / ".ruff_cache"}
        uvicorn.run("src.serve:make_app", factory=True, reload=True,
                    reload_dirs=[str(watch_root)],
                    reload_excludes=[str(path) for path in sorted(noise) if path.is_dir()],
                    **common)
    else:
        runtime = _assembly(configuration_loaded=True)
        uvicorn.run(runtime.app, **common)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
