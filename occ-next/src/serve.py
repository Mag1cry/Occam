"""把装配好的系统**跑起来**：一个 ASGI 工厂 + 一个命令行入口。

```powershell
uv run python -m src.serve                              # 直接跑
uv run uvicorn --factory src.serve:make_app --reload    # 开发时用（改代码自动重来）
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

← 来自 web.py 的 `app = create_app()`（lifespan 里装配）+ README 里的 uvicorn 命令
"""
from __future__ import annotations

import atexit
import sys
from typing import Any


def make_app() -> Any:
    """给 uvicorn 的工厂。**每一次调用都是一次完整的装配。**"""
    runtime = _assembly()
    return runtime.app


def _assembly():
    from .app.build import build
    from .app.settings import load_env_file

    # **先读 config/.env，再装配。** 环境是入口的事（systemd / 任务计划 / 启动脚本
    # 都是这个角色），放别处的话测试手一抖就会把开发机上真实的凭据灌进来。
    added = load_env_file()
    if added:
        print(f"[配置] 从 config/.env 读了 {len(added)} 项：{' · '.join(added)}", file=sys.stderr)

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
    import uvicorn

    runtime = _assembly()
    settings = runtime.settings
    print(f"OCC 配置舱在 http://{settings.host}:{settings.port} "
          f"（工作区 {settings.workspace}）", file=sys.stderr)
    uvicorn.run(runtime.app, host=settings.host, port=settings.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
