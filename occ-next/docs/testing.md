# OCC Next 测试说明

测试按四个证明层次组织：

```text
unit        模块内部逻辑正确
contract    模块之间的公共边界正确
negative    非法行为被拒绝且不能越界
flow        一个委托经过正确模块并完成闭环
```

`integration/` 负责真实多模块、进程和 checkpoint 连接，`smoke/` 只保存显式启用的外部供应商测试。

从 `occ-next/` 执行：

```powershell
uv run pytest -q
uv run pytest --collect-only -q
uv run pytest -q -m "not live_provider"
```

默认测试不访问网络。LangChain/LangGraph 属于可选 agent 依赖；缺少依赖时，相关测试应使用 `pytest.importorskip`，不会导致整体收集失败。

真实供应商测试需要显式启用：

```powershell
$env:OCC_RUN_PROVIDER_SMOKE = "1"
$env:DEEPSEEK_API_KEY = "..."
uv run pytest -q -m live_provider
```

每个测试应优先证明一个边界。流程测试除最终状态外，还应检查 Task ID、session/thread ID、tool ID、事件顺序和外部引用；模拟 Worker、模型和设备必须明确标注为 simulated。

自动化外围、心率手表扩展和硬编码执行者仍是预留内容，不在当前测试中伪造已实现证据。

## 当前分层与证据

测试目录是测试的执行边界，而不是仅用于整理文件名：

| 层 | 证明内容 | 当前重点 |
|---|---|---|
| `unit/` | 单个模块内部规则 | Core 状态修订、SQLite 读写、配置解析、Provider 预算 |
| `contract/` | Protocol 和模块边界 | Core fake port、授权 grant、IPC 可序列化、Web/Worker 禁止反向依赖 |
| `negative/` | 非法行为不会越过边界 | 空幂等键、终态命令、伪造授权、坏事件、坏扩展、IPC 拒绝、HTTP 映射 |
| `flows/` | 一个任务的生命周期闭环 | 创建、只读完成、审批恢复、失败、取消、重启诊断、多任务隔离 |
| `integration/` | 真实装配和外部连接 | spawn Worker、LangGraph SQLite、扩展目录、应用启动完整体检 |
| `web/` | 用户接入层 | 配置展示、供应商/模型级联、手动幂等和错误映射 |
| `smoke/` | 外部供应商可选证据 | 默认跳过；显式开关后从统一 ExtensionLoader 选择带 key 的 executor |

目标不是让测试数量看起来大，而是让每个四原语和每条模块边界同时有正例、反例和流程证据。新增功能至少应回答：模块自身是否正确、边界是否正确、非法调用如何失败、完整调用链是否闭环。

## 收集与标记

`tests/conftest.py` 根据目录自动添加 marker，因此可以按层执行：

```powershell
uv run pytest -q -m unit
uv run pytest -q -m negative
uv run pytest -q -m flow
uv run pytest -q -m integration
```

当前收集数量以 `uv run pytest --collect-only -q` 为准；迁移时不得保留旧路径副本，否则会造成重复收集。测试辅助 Worker 必须是顶层函数，以满足 Windows `spawn` 的 pickle 要求。

## 事务和故障证据

Core fake store 会模拟 Task、Event 或 CommandResult 任一写入失败，验证一个命令不能留下半套控制事实。SQLite 适配器则验证物理追加顺序、checksum、尾部维修备份、内部损坏阻断和启动完整体检。`repair_tail` 仍是本地维护入口，不通过 Core 或普通 Web API 暴露。

失败、取消和重启测试刻意区分：Worker 未报告就退出由当前 Controller 负责生成 `FAILED`；Controller 重启时没有旧 Worker 句柄，只能生成恢复诊断，不能替别的进程伪造失败；取消只有在进程确实退出后才能生成 `CANCELLED`。

## Smoke 约束

`tests/smoke/test_provider_smoke.py` 只有在 `OCC_RUN_PROVIDER_SMOKE=1` 时才可能访问网络，并从统一 `ExtensionLoader` 读取 executor、API 地址、模型和 API key 环境变量。它使用临时目录，不写正式 Core 或 LangGraph 数据库；没有 agent extra 或没有已配置 key 时跳过。普通 `uv run pytest -q` 永远保持离线。
