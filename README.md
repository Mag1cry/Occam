# Occam

**English**: [README.en.md](README.en.md)

> 一个**本地优先的个人控制面**：把"交给智能体去办的事"当成一等对象来管。

名字取自**奥卡姆剃刀**——*不要增加不必要的实体*。这条内核就守着它：
四原语（Task / Executor / Capability / Control Event），别的都是附属；
改状态必须同时记事件，所以不为"审计"另立一套日志——**事件链本身就是事实**。

它不训练模型、不调度集群、不是又一个 agent 框架。它回答的是另一类问题：
**这件事办到哪了、当时是谁批的、凭什么批的、以及那一刻到底发生了什么。**

```text
你 ──委托──▶ Task ──▶ 执行者（智能体 / 固定代码）
                │
                ├── 要调用工具？──▶ 判决 ──▶ 需要人拍板？──▶ 推到你手机上
                │                                        （点了批准，它自己接着跑）
                └── 每一步都落成一条事件，链上写得清清楚楚
```

## 四条设计主张

**① 四原语，别的都是附属。** Task（一件事）、Executor（谁来办）、Capability（它被允许动什么）、
Control Event（发生了什么）。内核只认这四样，所以"一件事办得怎么样"永远只有一个答案的地方。

**② 改状态必须同时记事件。** 内核只有一条迁移通道（`commit(uow, command, task, *, event)`）——
写不出"改了忘了记"的代码。于是事件链不是日志，是**事实本身**；界面、审计、对外推送全都从它派生。

**③ 判决在动作之前。** 工具调用不是"执行者想调就调"：先判决（谁能调、要不要人批），
**再记账**，最后才执行。所以"它干过什么"这件事在事后也说得清——包括那些被拒的。

**④ 外围是包，内核不长大。** 要加能力就加一个 `extensions/<名字>/manifest.yaml`
（工具 / 执行者 / 日程 / 供应商 / 消息通道），内核一行不改。包装了就能用，改配置热加载。

## 它长什么样

界面是一张**空间画布**，五类场景（全局 / 任务 / 编排台 / 档案馆 / 配置舱），按焦点在它们之间跳转。
每个对象点开是一张**操作牌**：每条命令都先告诉你**后果是什么、可不可撤回**，再让你按。

审批不走"自己写个界面看"：需要人拍板时，那一刻的输出会**推到你手机上**（今天接了飞书）——
卡片上的按钮点一下，**原地变成「✅ 已批准」，任务自己接着跑**；不跳转、不用翻聊天记录。

## 跑起来

需要 Python 3.11+ 和 Node（只用来自建前端）。

```bash
# 后端（接口在 127.0.0.1:8765）
cd occ-next
uv sync --extra dev --extra agent
uv run python -m src.serve

# 界面（开发形态，热更新在 localhost:5173）
cd occ-command-center
npm ci && npm run dev
```

发布形态是**一个进程、一个端口**：先 `npm run build`，再给后端设
`OCC_NEXT_WEB_DIR=../occ-command-center/dist`，界面和接口一起从 8765 出来。

- 凭据放 `occ-next/config/.env`（人写，不进 git），**只走环境变量**；
  程序自己写的东西在 `occ-next/data/` 和 `occ-next/workspace/`。
- 不想调真模型也能跑：装上扩展包、用固定代码的执行者，整条审批链路一样走得通。

## 目录

| 目录 | 是什么 |
| --- | --- |
| [`occ-next/`](occ-next/) | 后端：四原语内核 + 网关（判决 / 审批 / 日程 / 执行者 / 输出层）。**系统的大脑** |
| [`occ-command-center/`](occ-command-center/) | 前端：React 19 + Vite + Tailwind 的空间画布界面 |
| [`occ-next/extensions/`](occ-next/extensions/) | 扩展包。`AUTHORING.md` 是写包的教程 |
| [`occ-mcp-examples/`](occ-mcp-examples/) | MCP 接法的示例 |
| [`docs-Next-Version/`](docs-Next-Version/) | 架构与决策（含 ADR）、前端设计、旧系统删除前的导出 |
| [`docs/`](docs/) | 历史文档归档（描述的是**已删除的旧系统**） |

> **为什么目录和变量都叫 `occ`**：前身是 OCC（Operations Command Center），
> `occ-next/`、`OCC_NEXT_*` 这些名字是从那儿留下来的。名字改成 Occam 之后它们照旧——
> `occ` 正好是 Occam 的头三个字母。

后端 298 条测试（`cd occ-next && uv run pytest -q`），前端 293 条（`cd occ-command-center && npm test`）。

## 现在是什么状态

**个人项目，单机，本地优先。** 能跑、天天在用，但不是产品：没有多租户、没有云部署、
没有把控制面暴露到公网的设计（反过来说，它就是为了不暴露才这么写的）。

> 上一版实现 `occ-os` / `occ-web` 已于 **2026-10-02** 删除。代码仍在 git 历史里
> （`git log -- occ-os`），配置与数据导出在 [`docs-Next-Version/from-occ-os/`](docs-Next-Version/from-occ-os/)，
> 删除前的审计在 [`docs/删除旧版前的审计.md`](docs/删除旧版前的审计.md)。

文档以中文为主；英文只有这份 README 的对照版。

## 想往下看

1. **想知道怎么跑、往哪放凭据、开机怎么自启** → [`docs/运行与结构.md`](docs/运行与结构.md)
2. **想写一个扩展包** → [`occ-next/extensions/AUTHORING.md`](occ-next/extensions/AUTHORING.md)
3. **想知道为什么这么设计** → [`docs-Next-Version/architecture-next/decisions.md`](docs-Next-Version/architecture-next/decisions.md)
4. **想看需求是怎么一步步长出来的（含每次返工的理由）** → [`occ-next/docs/requirements.md`](occ-next/docs/requirements.md)
