# _todo/ — 以后要做的插件

**这里不是包。**（下划线开头的目录扫描器不看它——`loader.py::_package_dirs` 只认
带 `manifest.yaml` 的、且名字不以 `_` 开头的目录。）所以放这儿的东西**不影响运行中的系统**：
它只是一份清单。

清单记的是**旧系统（`occ-os/`、`occ-web/`）里有、新系统有意留着以后做的东西**。
删掉旧版之后，那些能力就只剩这页纸上的几行了——记在这儿是为了**它们不会被忘掉**，
也免得同一个问题被重新讨论一遍。

写法与契约见 [`../AUTHORING.md`](../AUTHORING.md)：**要做的每一件，最后都是一份
`extensions/<名字>/` 包**（一份 `manifest.yaml` + 它自己的代码），不是往内核里加东西。
判断标准就一条：四原语（Task / Executor / Capability / Event Chain）回答的是
"**一件事办得怎么样**"；回答不了的东西，就属于外围。

---

## 1. 感知 / 个人状态（旧的 `sensing` 域）

**旧系统有什么**：`/api/today`、`/api/week`、`/api/collect`、`/api/state`、`/api/todos`、
`/api/events`（带提醒）；四个 sensor 扩展（`city` / `schedule` / `status` / `weather`）；
每日推送（`push_time`，经通知通道）；事件到点提醒（每个事件一个 Timer）。

**现在的裁定**：暂时不做，**以后做成插件**。

**做的时候要知道的**：

- 它**不是控制面**：这条线记的是"我今天是什么状态"，而四原语记的是"这件委托办到哪了"。
  混进内核会把内核拖成个人 OS——所以它是包，不是原语。
- 采集是**一个工具的入口**（包内单例，公开方法就是工具），推送是包自己的事
  （要不要发、发去哪，宿主不管）。
- 旧实现里"事件"和"待办"是 `occ-os` 自己的表（`events` / `todos` / `daily_snapshots`），
  新系统没有对应物，也不该有——它们属于这个包的私有存储。

## 2. 遥测（时长 / 成本 / token / 错误）

**旧系统有什么**：`agent_telemetry` 表 + `/api/occ/metrics` + `/api/modules/trend`
（模块健康趋势）+ 效能诊断（`/api/efficiency`，按专家聚合成功率/耗时/成本）。

**现在的裁定**：暂时不做，**以后有需要再加在插件里**。

**做的时候要知道的**：内核**有意不存返回值与过程**（ADR-008：只留 `result_ref`），
所以遥测天然属于外围——它记的是"跑得怎么样"，不是"控制面确认了什么"。采集口可以是一个
工具（worker 或 adapter 上报），聚合与趋势是这个包自己的事。

## 3. 外部 Agent 监视（Hermes / DSH）

**旧系统有什么**：`hermes` / `dsh` 两个 provider 扩展（直读 Hermes `state.db`、
DSH 的 RPC 会话树），加上 `/api/occ/agent-monitor` 与那棵 subagent 会话树——**只读监测**。

**现在的裁定**：TODO，**做成插件**。

**调用方法**：**写一个 adapter，一样的**——和包里其他对外部系统的接法是同一条路
（adapter 是包自己实现的那几格：`checkpoint_exists` / `read_result` / 可选 `read_audit`）。

## 4. 外部 Agent 后端（把外部 agent 当执行者）

**旧系统有什么**：`agent_backends` 配置 + HTTP Agent Protocol 客户端
（`start` / `status` / `update` / `cancel` / `approve` / `events` / `pause` / `resume`），
状态别名归一化，加一个外部后端注册表。

**现在的裁定**：TODO，**同 3：调用方法就是写一个 adapter**。

**做的时候要知道的**：新系统里执行者的入口现在只有两种——包内 `worker.entrypoint`，
或者基于另一个执行者的配置（`executor:`）。**外部后端会是第三种**，而它不该改内核：
内核只认"谁负责把这件事推到收敛"这个引用（`executor_ref`），那个引用背后是本地子进程
还是远端服务，是外围的事。

---

## 已经定了：**不做**

这几件旧系统里有、但不迁——记在这儿，省得以后再问一遍。

| 旧的什么 | 为什么不迁 |
| --- | --- |
| 专家学习闭环（提案 proposals / 成果 outcomes / 效能 efficiency / 实验 experiments / 专家版本发布） | **专家就是当前的智能体**，这条路不打算做了 |
| 文件夹级授权（`workspace_scopes`） | 权限面向**工具级**；文件夹级主要服务 coding，而其他领域不需要它 |
| 工具沙箱（`fs-tools`：read/write/glob/grep/list/execute + 白名单） | 暂时不做 |
| 预案 runbook（`config.yaml` 的 `plans` + `/api/plans/{id}/run`） | 不做 |

另外，旧版里本来就已经是死的那些（今日视图不可达、`PlanPanel` 零引用、`/api/outcomes`
拉了没人消费……）按"没有这个功能"算，不算被砍掉的能力。
