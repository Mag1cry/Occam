# TODO：心率监测手表扩展

预留一个由插件独立管理设备数据的接入方案，当前不启用、不注册 Capability。

这份 TODO 同时保留该方案的决策过程，避免后续实现时退化为“Agent 每次需要数据时直接连接手表”。

## 目标结构

```text
手表
  → 设备适配器
  → 插件数据库
  → Capability 查询函数
  → Core.call_function
  → Agent
```

## 设计决策

选择“持续接入并保存到插件数据库”，而不是“每次 Agent 读取时再连接手表”。

### 为什么不每次直接读取手表

每次读取手表会让 Agent 查询强依赖设备当前连接状态和厂商协议，带来以下问题：

- 手表暂时离线时无法读取最近一次有效数据；
- 每次查询都要重新处理 BLE 或厂商 SDK 连接；
- 查询历史心率时需要反复访问设备，延迟和失败概率更高；
- 多个 Task 或多个执行者重复读取同一份设备数据；
- 设备采集、设备连接和 Agent 任务生命周期耦合；
- 无法统一做采样去重、补传、保留和统计。

### 采用插件数据库后的收益

```text
设备采集与 Agent 执行解耦
手表离线时仍可读取最近一次数据
多个 Task 共享同一份采样事实
支持历史查询、平均值、最大值和异常区间
插件可以独立处理重连、缓存、补传和数据保留
Agent 不需要知道手表协议或数据库位置
```

因此，手表通信只由采集器负责，Agent 只通过 Capability 查询插件数据库中的数据。

## 两条独立的数据链

### 设备数据链

```text
BLE / 厂商 SDK
  → HeartRateAdapter
  → HeartRateCollector
  → HeartRateRepository
  → 插件 SQLite
```

这条链负责采集和保存业务数据，可以在没有 Task 的情况下持续运行。

### OCC 控制链

```text
Agent Tool
  → Worker IPC
  → TaskController
  → Core.call_function
  → allow
  → CapabilityGateway
  → HeartRateProvider
  → HeartRateRepository
  → Agent
```

这条链负责权限、Task 关联、调用幂等和控制事实。Provider 查询数据库，不直接连接手表。

设备连接状态则单独进入控制链：

```text
HeartRateCollector
  → Core.set_online / set_offline / set_error
  → SUBJECT_ONLINE / SUBJECT_OFFLINE / SUBJECT_ERROR
```

设备离线不会自动把 Task 标记为 `failed`；只有执行者确认无法继续时，外围控制器才调用 `Core.fail()`。

## 四原语映射

- `Task`：例如“检查当前心率并在异常时提醒我”；
- `Executor Configuration`：Agent、硬编码规则函数或工作流，负责把任务推到收敛；
- `Capability`：`watch.heart_rate.read_latest`、`watch.heart_rate.read_history`、未来的 `watch.vibrate`；
- `Event Chain`：记录能力调用和设备 online/offline/error 等 OCC 控制事实。

逐条心率采样是插件的数据事实，不是 OCC Control Event。Core 只记录对采样的受控访问和设备状态变化。

## 目标插件结构

```text
extensions/
└── heart-rate-watch/
    ├── TODO.md
    ├── manifest.yaml       # 完成实现后再创建
    ├── README.md           # 完成实现后按需创建
    ├── adapter/
    │   ├── protocol.py
    │   └── ble.py
    ├── collector.py
    ├── repository.py
    ├── provider.py
    └── data/
        └── heart-rate.sqlite
```

插件数据库建议放在统一的外围数据区域，而不是 Python 源码目录内部：

```text
occ-next/
├── data/
│   ├── occ-next-v1-control.sqlite
│   └── extensions/
│       └── heart-rate-watch/
│           └── heart-rate.sqlite
└── data/occ-next-v1-langgraph.sqlite
```

三类数据库各自负责不同事实：

```text
OCC 控制数据库       Task、Control Event、CommandResult
LangGraph 数据库     Agent 消息、图状态和 checkpoint
插件数据库           心率采样、设备数据和同步状态
```

## Agent 可用的查询能力

插件完成后，Agent 看到的是稳定的能力，而不是插件内部实现：

```text
watch.heart_rate.read_latest
watch.heart_rate.read_history
```

示例 manifest：

```yaml
id: heart-rate-watch
name: Heart Rate Watch
enabled: true
defaults:
  target_type: wearable-device
  risk_level: low
  approval_required: false
  cancellable: false
  idempotency: safe-retry
tools:
  - kind: heart_rate_read_latest
    tool_id: watch.heart_rate.read_latest
    function_name: read_latest_heart_rate
    input_schema:
      type: object
      properties:
        device_ref: {type: string}
      required: [device_ref]
  - kind: heart_rate_read_history
    tool_id: watch.heart_rate.read_history
    function_name: read_heart_rate_history
    input_schema:
      type: object
      properties:
        device_ref: {type: string}
        from: {type: string}
        to: {type: string}
      required: [device_ref]
```

## 采样数据边界

插件数据库保存：

- 设备引用；
- 采样时间；
- 心率值；
- 接收时间；
- 数据来源；
- 同步游标；
- 必要的厂商原始数据引用。

OCC 控制数据库不保存逐条心率采样、完整历史查询结果或原始厂商 payload，只记录控制事实和外部结果引用。

## 异常触发

后续如果实现“心率持续超过阈值自动处理”，流程应为：

```text
插件采集器
  → 插件规则观察器
  → 发现心率连续超过阈值
  → Core.create_task()
  → TaskController 启动执行者
  → Agent 调用 watch.heart_rate.read_latest
  → Agent 判断和处理
```

插件不能直接写 Task 表或 Event Chain；即使触发来源是设备采集器，也必须通过 Core 命令创建 Task。

## 健康数据要求

心率属于敏感健康数据，实现时至少需要考虑：

- 按设备或用户隔离；
- 查询时间范围和数量上限；
- 数据保留周期；
- 删除和导出；
- 插件数据库访问权限；
- 可选数据库加密；
- Agent 返回结果的最小化，避免不必要地暴露完整历史。

## 待实现内容

- 增加手表协议适配器，例如 BLE 或厂商 SDK；
- 增加独立采集器，持续接收心率数据；
- 将原始采样写入插件自己的 SQLite 数据库；
- 增加心率采样 Repository 和数据保留策略；
- 增加 `watch.heart_rate.read_latest` 查询能力；
- 增加 `watch.heart_rate.read_history` 查询能力；
- 通过 `manifest.yaml` 注册上述 Capability；
- 让 `CapabilityProvider` 只查询插件数据库，不直接读取手表；
- 将设备 online/offline/error 映射为 Core subject 状态事件；
- 后续再增加阈值观察器，由插件通过 Core `create_task` 创建 OCC Task；
- 对心率等健康数据增加访问隔离、删除、导出和可选加密策略。

## 启用条件

完成适配器、插件数据库、Provider、manifest 和测试后，再创建该目录下的 `manifest.yaml`。在此之前，本目录中的 TODO 不会被扩展加载器注册。
