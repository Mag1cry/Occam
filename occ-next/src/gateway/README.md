# gateway/ — 网关

**系统对外的唯一门 + 它做判决所需的目录 + 它留下的记录。**

| 文件 | 装什么 |
| --- | --- |
| `facade.py` | 命令分派：一张「命令名 → 处理函数」的表 |
| `audit.py` | 审计流水；事实流的游标就是每条的 `seq`（**服务端不存位置**——谁在读到哪是客户端的事） |
| `permission/` | 判决的共同形状：主体、判决、顺序器 |
| `access/` | 对外界的权限鉴定：谁能进来 |
| `function/` | 对工具执行的权限鉴定：能不能跑 |
| `directory/` | **四个列表**：能力、执行者、供应商、日程 |
| `output/` | **送出去 + 收回来**：一份描述、多条路径（前端内建 / 飞书插件 / …）。**目前只有设计稿**（`output/README.md`），代码未落地 |

## 边界

- **不拥有进程**。起 Worker、终止 Worker 是 `tasks/` 的事。
- **`access` 那半不进内核**。内核不知道网络存在，也不该知道。
- **`function` 那半记账但不裁决**。判定、证据、执行都在这里，内核只留一条控制事实。
- **判决只做一遍**。同一个调用不许出现两个判定的地方——那正是"权限中心"分裂的开始。
- **不碰存储**。内核的存储由 `core/kernel.py` 绑定，外围任何函数都不访问它。

## 两处判决都是网关的，都默认拒绝

| 半 | 判什么 | 判据 | 目录 |
| --- | --- | --- | --- |
| 对外界 | 谁能进来 | 来源在信任网段 · 令牌对不对 | `access/` |
| 对工具执行 | 这个工具能不能跑 | 工具被声明过 · 这个执行者被允许用它 | `function/` |

两半共用 `permission/`：判决只有三种（`allow` / `deny` / `needs_approval`），
规则**只声明允许，默认拒绝**（`judge()` 的顺序器）。

```text
一个请求进来
  → access/     谁在请求？放行吗                      ← 判
  → facade.py   翻译成内核命令，或转给写路径
  → directory/  四个列表：这工具在里面吗？执行者允许用它吗？
  → function/   判 → 定性（要不要人批）→ 告诉内核记一笔 → 执行
```

## 命令面就这 11 条

```text
任务      create_task · start_task · approve · deny · resume · cancel    (6)
触发      schedule.trigger                                               (1)
开关      set_enabled                             ← 改声明的 enabled
声明      manifest.create / write / delete        ← 建包 / 改字段 / 删包
```

**没有"重新识别"那条。** 它当年存在的唯一理由是"改扩展 `.py` 源码之后热替换"，而那条路
已经不要了（`extensions/README.md`）：改开关即时生效（`set_enabled` 和声明写入都会重读
声明、重建供给、一次替换列表），改源码重启宿主。掉线的 MCP 连接也一样——重读声明会重建
连接，不需要一个单独的"重连"命令。

| 命令 | 转到哪 |
| --- | --- |
| `create_task` | 内核 `create_task`（前置校验执行者存在，在网关） |
| `start_task` | `tasks/controller.start` |
| `approve` / `deny` | 内核 `approve`/`deny` + **网关接着做自动恢复**（审批完了恢复执行是控制侧的事，不是用户再点一次） |
| `resume` | 内核 `resume` + `tasks/controller.start` |
| `cancel` | 先 `tasks/controller.cancel`（终止 Worker）→ 内核 `cancel` |
| `schedule.trigger` | `tasks/scheduler.trigger` |
| `set_enabled` | 改声明的 `enabled`（走写路径）→ 重读声明 |
| `manifest.create` / `write` / `delete` | `extensions/writer.py`（写前校验 + 原子替换）→ 重读声明 |

**"编辑"那四条覆盖了原来 12 条的全部。** 它们做的是同一件事——改
`extensions/<id>/manifest.yaml` 的一个字段。今天那 12 条各自有自己的持久化行为
（`AbilityRegistry` / `MCPRuntime` / `AutomationStore` / `ConfigStore`），**那才是"关不掉"的成因**。

ADR-025 早就裁过：命令面按对象类型分组，但"开/关"只有**一条**底层实现——
**收实现，不收命令名，命令保持自描述**。命令名保留是因为它是前端的契约。

删掉的三条：`ability.register`（要过 HTTP 传 Python 对象，不可达）、`ability.health`（读快照就有）、
`device.simulate`（设备成了扩展，它变成那个扩展的一个工具）。

## `delete` 带引用检查

删包 = 删目录，**不可撤销**。所以删之前检查：**有没有 Task 引用这个包提供的执行者**——
有就拒绝，并列出那些 Task。今天这条保护只长在"删智能体"上，泛化到所有包。

不删不行：没有删除，"创建了又不要了"就只能靠禁用，`extensions/` 会越积越多说不清来路的包。

## 为什么判决在这里而不在内核

**三层里只有网关知道有哪些工具**，所以只有它能判。内核收到的是"这次调用，判定是 X"，
不是"请你判一下"——它记账，不裁决。

## "Agent 不能伪造批准"这条性质变了吗

没变，但守卫换了人：**判决发生在宿主进程里，由网关做**；Worker 在另一个进程，碰不到网关。
今天这条由内核保证（Worker 碰不到内核），明天由网关保证。

守卫换了，性质一样——**但这条必须写清**，否则下一个人会以为"判决在网关"等于"没那么严"。
