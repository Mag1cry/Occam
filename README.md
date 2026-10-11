# Occam

**English**: [README.en.md](README.en.md)

> **一个本地优先的 Agent 执行控制面**：让不同来源的 Agent 任务可观察、可约束、可追溯，并由人掌握控制权。

Occam 不试图成为新的 Agent 框架，也不要求所有 Agent 使用同一套运行时。它关注 Agent 被委托之后的问题：
**任务进行到哪一步、调用了什么工具、依据什么策略获准、谁做了审批，以及运行结果如何。**

```text
托管 Agent ──工具请求──▶ 权限判决 ──▶ 人工审批 ──▶ 工具执行
     │                                 │
     └──执行过程与结果──▶ 运行审计      └──▶ 事件与运行记录

外部 Agent ──只读监控扩展（规划中）──▶ 标准化观察视图
```

## 项目主张

- **兼容不同 Agent，但不假装它们一样。** 通过扩展接入框架或运行环境；记录原生来源和可观测范围，把事实投影到共同的执行视图。无法确定的信息保持未知。
- **区分控制与观察。** Occam 管理的执行者可以通过宿主工具通道接受权限判决和审批；外部监控扩展读取既有运行记录，不因此获得控制外部 Agent 的能力。
- **工具动作先判决，再执行。** 执行者按白名单获得工具；策略可要求人工批准；控制事件记录权限判决与审批。工具实际执行结果的网关持久化仍待完善。
- **让运行证据帮助人改进流程。** 目标是汇总执行过程、成本、耗时、审批和失败信息，由分析 Agent 提出改进建议，是否采纳由人决定。成本与效率分析仍在规划中。
- **本地优先，核心保持精简。** Task、Executor、Capability 和 Control Event 构成控制内核；框架、监控源和其他外围能力由扩展接入。

## Agent 集成范围

| 集成方式 | 能力边界 | 当前状态 |
| --- | --- | --- |
| 托管执行 | Occam 启动执行者，并要求工具调用经过 Occam 权限与审批通道 | 已实现 Worker 契约、LangGraph 执行者、工具白名单与审批管线 |
| 外部执行控制 | 调用远端 Agent 的启动、暂停、恢复或取消接口 | 规划中，能力取决于外部服务接口 |
| 外部只读监控 | 读取由其他运行时启动的 Agent 的对话、工具活动和运行状态 | 监控扩展契约待设计；计划提供 LangGraph 外部监控样例 |

当前 LangGraph Agent 属于托管执行。未来的 LangGraph 外部监控样例指向另一种部署/接入方式：Agent 在 Occam 之外运行，由独立监控扩展读取其记录；它不会改变当前执行者的定位。

不同来源提供的数据并不相同。外部监控计划统一事件外形，同时保留源标识、原生引用、证据来源和未知字段；不会把观察到的活动标成由 Occam 授权或执行。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| [`occ-next/`](occ-next/) | Python 后端：控制内核、权限网关、Worker、扩展机制和 HTTP 接口 |
| [`occ-command-center/`](occ-command-center/) | React 前端：任务、事件、审批与配置的空间控制台 |
| [`occ-mcp-examples/`](occ-mcp-examples/) | 外部 MCP 连接示例 |

## 本地运行

需要 Python 3.11+ 和 Node.js。

```bash
# 后端
cd occ-next
uv sync --extra dev --extra agent
uv run occ-next

# 前端开发服务器
cd occ-command-center
npm ci && npm run dev
```

后端默认监听 `127.0.0.1:8765`，前端开发服务器默认监听 `localhost:5173`。发布时可先构建前端，再用 `OCC_NEXT_WEB_DIR=../occ-command-center/dist` 由后端同源提供界面与 API。

## 当前实现边界

- 系统定位为单机、本地优先项目；没有多租户或公网产品化设计。
- 当前 LangGraph Agent 由 Occam Worker 子进程托管执行；其工具调用经 Occam 网关判决和审批。未来外部监控将作为独立接入样例，不替换或重新归类当前实现。
- Agent 对话审计由执行者 adapter 按需读取；网关侧持久化工具实际执行结果、耗时及完整成本遥测仍需完善。
- 独立分析 Agent、统一的外部 Agent 监控事件契约和远程 Agent 控制适配仍在规划中。

仓库实现说明见 [`occ-next/README.md`](occ-next/README.md)、扩展契约见 [`occ-next/extensions/AUTHORING.md`](occ-next/extensions/AUTHORING.md)，Agent 集成决策见 [`occ-next/extensions/AGENT_INTEGRATION_DECISION.md`](occ-next/extensions/AGENT_INTEGRATION_DECISION.md)，前端说明见 [`occ-command-center/README.md`](occ-command-center/README.md)。
