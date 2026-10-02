# 实现说明

> 本文说明原型如何对应 `../docs-Next-Version/command-center-design/` 的设计，
> 以及在哪些地方刻意保留边界、不做实现。

## 1. 权威来源

设计文档按“产品体验 → 渲染架构 → 投影契约 → 后端事实”分层。
发生冲突时按该顺序判断：体验目标不能虚构后端事实，后端事实不能反过来
决定所有视觉表现，专题文档不得覆盖分层契约。

| 层 | 文档 | 在本项目中的落点 |
| --- | --- | --- |
| 产品体验 | `frontend-experience.md` | `scenes/*`、四级信息密度、操作流程 |
| 渲染架构 | `rendering-architecture.md` | `core/scene/*`（SceneRenderer / SpatialCanvas / TransitionLayer） |
| 投影契约 | `projection-contract.md` | `core/projection/*` |
| 后端契约 | `backend-contract.md` | `api/gateway.ts`（快照与命令）、`lib/commandMatrix.ts` 的能力开关 |
| 视觉系统 | `visual-system.md` | `components/*`、`index.css` 的 `@theme` |
| 业务专题 | `world-model.md` / `state-ring.md` / `focus-leap.md` | `lib/attention.ts`、`lib/stateRing.ts` |

## 1.1 外层四类节点与子场景资料

这是最容易写错、也最影响「最外层界面简洁」的一条边界：

```text
外层 World 只有四类节点
  Task          每个真实 Core Task 一个
  Schedule      每个外围 Schedule 一个
  Archive       一个档案馆入口
  Configuration 一个配置舱入口

子场景资料节点（ResourceNode），只出现在父场景的 ChildScene
  executor-config / extension / capability        ← 配置舱
  schedule-entry / task-definition / occurrence  ← 编排台
```

Task 场景里没有资料节点：`uses` / `awaits` 以引用摘要呈现（见 1.4），
Executor Configuration 在那里不是可选中、可连线的空间对象。
档案馆也没有资料节点：它的内容是终态 Task 本身。

设计原文：

- `world-model.md` 第 2 节：Executor Configuration、Extension、Capability、
  Task Definition、occurrence 和 Archive Record **都不是外层第五类节点**，
  只在对应父节点的 ChildScene 中出现；
- 第 6 节：Archive **外层只显示档案馆入口，不把历史 Task 铺回 World**；
  Configuration **外层只显示配置舱入口**。

因此外层的规模是「快照里的每个非 Schedule Task 一个 Task 节点 +
每个 Schedule 一个节点 + 1 个档案馆入口 + 1 个配置舱入口」。
离线夹具正好是 10 + 6 + 1 + 1 = **18 个节点，0 条连线**；
接真后端时 Task 与 Schedule 的数量以后端为准。
Schedule 的 occurrence 物化出的 Task 归编排台管，不在外层出现
（判据是派发记录里的真实 ID 映射，不是名字前缀）。

关于连线：外层没有任何合法关系。设计列出的真实关系
（`Task→Executor Configuration`、`Extension→Capability`、
`Schedule→Entry→occurrence→Task`）**两端都在子场景内部**，
只能在子场景绘制。设计原文是「节点可以没有连线。只有真实关系才画线」——
把子场景关系提升到全局，既让外层变拥挤，也把不存在的全局关系画成了事实。

资料节点与真实对象的关系只能来自显式 ID 映射
（如 `ArchiveMetadata.task_id`），没有映射就单独显示、不画线，
不按名称、创建时间或数组位置猜测。

### 1.2 世界的全部关系

设计的合法关系是封闭清单，逐条对照如下
（`world-model.md` 第 4 节 / `projection-contract.md` 第 4 节 / `focus-leap.md` 3.2）：

| # | 关系 | 实现位置 | 说明 |
| --- | --- | --- | --- |
| 1 | `Task ──uses──> Executor Configuration` | Task 场景**摘要** | 只在有真实 `executor_config_id` 时给出引用摘要，不画线 |
| 2 | `Task ──awaits──> pending Capability` | Task 场景**摘要** | 只在 `pending_tool_id` 存在时给出摘要，不画线 |
| 3 | `Task ──has──> ControlEvent` | **不画** | Core Event Log 是时间序列组件，不变成空间节点 |
| 4 | `Task ──has──> Agent Audit Projection` | **不画** | 同上，审计是时间序列面板 |
| 5 | `Task ──observed-by──> Controller Observation` | **不画** | 设计明确：徽标，不是节点 |
| 6 | `Extension ──declares──> Capability` | Configuration 场景 | 唯一合法的能力关系 |
| 7 | `Schedule ──has──> Schedule Entry` | Schedule 场景 | |
| 8 | `Schedule Entry ──references──> Task Definition` | Schedule 场景 | 定义缺失时不画，Entry 显示引用缺失 |
| 9 | `Schedule ──creates──> occurrence` | Schedule 场景 | **不越过 occurrence 直连 Task** |
| 10 | `occurrence ──materializes──> Core Task` | Schedule 场景 | 只在有明确 ID 映射时画 |

**画线的只有两处**：编排台（has / references / creates / materializes）和配置舱
（declares）。Task 场景的 `uses` / `awaits` 以**引用摘要**出现，见 1.4。

禁止清单（均未出现）：`Executor Configuration → Capability`、
`Controller → Worker`、`Task → Task`。

**外层 World 没有连线**：上表每条关系至少有一端是子场景资料节点，
外层无处可画（「节点可以没有连线。只有真实关系才画线」）。

**档案馆没有连线**：Archive ChildScene 投影的是「非 Schedule Task 的历史、
结果、事件和诊断」，「历史 Task 默认折叠，选中后再进入 Task 局部世界」——
可选中、可进入的对象是 Task 本身。事件/结果/诊断是时间序列组件，
因此没有可画的边。

早期实现额外造了一层「归档条目」节点再连一条线到 Task，有两个问题：
把同一个对象画了两遍；而且 `Archive → Task` **不在合法关系清单里**。
现在内容节点就是终态 Task，归档时间通过显式 `task_id` 关联；
没有元数据就不显示时间。

**Schedule 的四个角色不能合并**：Schedule / Schedule Entry / Task Definition /
occurrence 各是独立节点。早期实现把 Task Definition 折进 Entry 的标题，
于是 `Schedule ──has──>` 指向一个标题是定义名（如「数据库备份」）的节点——
而同一场景里的 Core Task 也叫这个名字，看起来就像 has 线直接连到了 Task。
现在 Entry 的标题是引用串（`def-db-backup`），人类可读的名称属于 Definition 节点。

#### Schedule 的聚合是派生的

Schedule 不拥有自己的 Core 状态环，它的环是子 Task 注意力的聚合投影
（`state-ring.md` 第 1 节）。因此 `aggregated_state` 和 `child_task_count`
**不在 mock 里写死**，由 `projectScheduleNodes()` 从 occurrence 与子 Task 派生；
World、HUD、焦点锚点、节点组件、局部场景共用这一份，保证各处说的是同一件事。

聚合始终基于**全部** occurrence，不受子图折叠影响——这正是
「不能用当前视口内恰好加载的几个 Task 冒充完整 Schedule 状态」。

`schedule-006` 是这条规则的实例：每天跑一次、已经跑了 14 次。
最近几次看起来健康（运行中 + 上一次失败已确认），但最早那次失败无人确认，
落在默认折叠的历史里。只看可见的 4 次会得出 `active`，
只有基于全部才会得出 `attention`。测试对这一点做了双向断言。

#### 重复执行历史的折叠

每天一次的日程三周就能积累二十多次，全铺开既读不动也画不下。
编排台默认只显示最近 4 次，其余通过「展开更早的 N 次执行」按需展开。

折叠只削减可见节点，**不改变聚合与分区**；分区列表里点到被折叠的 Task 时，
先自动展开再选中，避免选中一个画布上不存在的节点。

### 1.4 Task 场景是焦点场景，不是子图

四类局部场景不等价。设计把「Task Focus」和后三类子图明确分开
（`rendering-architecture.md`：避免把 Task Focus 和后三类子图混成一个类型），
`focus-leap.md` 3.1 的 Task 场景图里也只有：

```text
状态环 / 委托摘要 / 持续时间        ← 焦点对象
Executor Configuration 真实引用摘要 | pending Capability（仅 pending_tool 存在）
════ Agent Audit Timeline / Core Event Log ════
[当前状态生成的操作牌]
```

没有节点、没有连线、也没有画布。编排台 / 档案馆 / 配置舱才是
「父对象 → 子节点 + 真实关系」的子图。

早期实现把 `Task ──uses/awaits──>` 画成了节点加连线：结果是打开一个 Task
看到的是第二个编排台样子的子图，和设计图不符。现在这两条关系不画线，
只在身份条上以**引用徽标**呈现：同样来自真实字段、同样能看出引用缺失，
但不是可选中、可拖动、可连线、参与布局和缩放的空间对象。

#### 全屏信息面

Task 场景是一块铺满全屏的信息面，两段自上而下：

| 段 | 内容 |
| --- | --- |
| 身份条 | 状态环 · 任务名 · 状态文案 · 持续时间 · 委托摘要 · 真实引用徽标 · Controller 观测 |
| 人机交互 | **完整消息序列**：一条记录一张卡，横向翻页；身份标在卡片下方，卡片内容各自滚动 |

「人机交互」= 系统提示、人的输入、模型每一轮说的话（含它要调什么）、工具回来了
什么，按执行者账上存的顺序。**工具调用在里面**（模型那一轮写着"要调用 X（参数）"，
紧接着那张卡是工具回来的东西），不另列一排。

<small>（这一段原先是「时间线 + 调用卡」两个视图，只画工具调用。改成人机交互序列
之后，系统提示、人的输入、模型的每一句话才进得来——而"它为什么这么干"的答案通常
在模型上一句话里，不在那次调用的参数里。）</small>

- **卡片组撑满剩余高度**，整块信息面的顶部内边距（`AUDIT_TOP_INSET`）把顶部中央的
  HUD 让开，避免被盖住；
- 底部留出操作牌的宽度，卡片不钻到操作牌下面；
- 两条信息线仍然是两个视图：切到「内核事件」时同一块位置换成 Core Event Log。

#### 视觉：与 occ-web 同源

配色与材质**直接对齐 occ-web**（同仓库的参考实现），不另起一套。
Palantir 一脉的语言是「近黑中性面 + 克制的圆角 + 数据密集」，
Blueprint 本身是 2px 圆角 / 10px 网格 / 五种意图色，
occ-web 取其中偏克制的一档：

| 规矩 | 落地 |
| --- | --- |
| 表面是近黑中性灰，不是蓝调深空 | `#05070a` / `#0f1011` / `#191a1b`；body 叠两层径向辉光（顶部蓝、右下青） |
| 主强调是**青**，状态用色盲安全三态 | `#2dd4a7` 青 / `#ffb020` 琥珀 / `#ff5470` 品红 / `#64748b` 板岩 |
| 颜色只出现在需要你注意的地方 | 状态环：活着=亮青，响铃=琥珀，亮灯=品红，已收敛=暗青或板岩；资料节点类别一律中性板岩，靠字形区分 |
| 视觉重量跟着状态走（occ-web 的 `priorityMeta` 配方） | `lib/nodeSurface.ts`：状态色淡渐变 + 内高光 + 柔和投影；需要响应的加同色外发光；宽度也随注意力变化 |
| 材质 = 淡色渐变 + 内高光 + 柔和投影 | `.glass` / `.glass-strong` 与 occ-web 同一份配方；`.tactical-command-deck` 的青色描边 + 外发光用在操作牌上 |
| 战术网格作底衬 | `.grid-bg`：96px + 24px 双层网格，顶部径向渐隐，固定不随画布移动 |
| 小字号密集排版 | 正文 11–13px；`.label` = 11px；数字一律等宽 |
| **字距只给拉丁串** | occ-web 的 `.label` 是**全大写英文专用**，0.2em 字距套到中文上会被撑散（实测 11px 的字拿到 2.2px 字距，「引用该配置」渲染成「引 用 该 配 置」）。所以默认档不带字距，纯拉丁串显式加 `.label-en`；中文靠字号 + 字重 + `topline` 分割线承担「标题感」 |
| 时长用紧凑写法 | `lib/format.ts` 的 `formatDurationSec` 从 occ-web 抄来：`20min`、`1h 15min`，**零秒不显示**——页脚只有 154px，`20m 0s` 这种写法放不下 |
| 圆角克制 | 8–16px（芯片 8 / 面板 12 / 卡片与节点 16），不用大圆角卡片 |

人机交互的卡片与画布节点同一套读法：状态色淡渐变 + 内高光 + 柔和投影；
卡片身份标在卡片下方（小方块图标 + 角色名 + 状态点）。
强调色只标「这一条有多该被看见」——系统提示是布景压到最暗、**人的输入**最亮、
模型在中间、工具按成败取色；**不用色相区分四种角色**（调色板只有四个色，
硬分反而每一条都在喊）。

#### 相应约束

- Task 场景不产出画布节点与连线（`TaskProjection` 只解析引用）；
- 操作牌的目标是**焦点对象本身**，不依赖选中态——Task 场景里没有可点选的节点；
- Controller Observation 仍是徽标，不是节点（`focus-leap.md` 3.2）。

## 2. 全屏画布 + 悬浮 Overlay

```text
App（w-screen h-screen）
├── SceneRenderer            ← 100vw × 100vh，只维护一个活动画布
│   └── Active Scene → SpatialCanvas
│       └── TransitionLayer（FlyingProxy，portal 到 body）
├── FloatingHud              ← fixed，顶部中央灵动岛
├── FocusAnchor              ← fixed，左上角返回锚点
└── CommandSurface / ActionPreview / ContextMenu   ← fixed Overlay
```

没有任何面板与画布并列：HUD、操作牌、事件档案、菜单全部是 Overlay。
`SpatialCanvas` 是 World 与**三个子图**（Schedule / Archive / Configuration）
共用的唯一画布容器，容器内不出现第二个 React Flow。

Task 场景没有画布，见 1.4：它是焦点场景，不是子图。

### 屏幕区域划分

每块屏幕位置只由一类信息占用，避免互相遮挡：

| 区域 | 占用者 | 说明 |
| --- | --- | --- |
| 顶部中央 | **只有 HUD** | fixed 屏幕坐标的注意力 Overlay，不随 viewport 变化 |
| 左上角 | 焦点锚点 + 概览栈 | 锚点是返回入口；概览（`SceneOverlayStack` / `SceneFacts`）贴在锚点正下方 |
| 底部中央 | 操作牌 | 子图场景里选中对象后出现；Task 场景里焦点对象本身就是目标，常驻 |
| 底部两侧 | 场景专属面板 | 如 Schedule 的子 Task 分区、Configuration 的引用列表 |
| 其余 | 画布 / Task 信息面 | 画布独占全屏；Task 场景是同样铺满全屏、顶部让开 HUD 的信息面 |

局部场景**不能**在顶部中央放摘要条：那会和 HUD 抢同一块屏幕，
而且设计里「委托摘要」本来就由画布中央的焦点对象承担
（`focus-leap.md` 3.1 的焦点对象框），固定摘要条是重复表达。

概览栈的位置由 `ANCHOR_POSITION` / `ANCHOR_SIZE` 派生，和飞行终点共用同一组常量，
否则飞行代理会落到和锚点不重合的地方。`sceneOverlay.test.tsx` 锁住了这两点。

## 3. 关键机制

### SceneStack

- `SceneId = world | task | schedule | archive | configuration`；
- `SceneFrame` 保存 `sceneId / focusId / viewport / selection`；
- 进入 `push()`、返回 `pop()`；返回后按快照恢复外层 viewport 与 selection；
- 返回入口统一：左上角锚点、`Esc`、浏览器 Back（`history` + `popstate`）。

### Focus Leap

进入：测量源节点矩形 → 暂时隐藏源节点 → 代理飞向左上角锚点 →
动画结束提交 `push()`。测量到的矩形和源节点的名字、颜色随帧一起入栈。
返回：按帧里的源矩形飞回 → 动画结束提交 `pop()`。

返回目标是**上一层场景**里的源节点，不是写死的 World：从编排台进入的
Task 要飞回编排台。用进入时测到的矩形而不是重新推算，是因为源画布在
返回动画开始时还没挂载；源场景视口被冻结在帧里，回来时取景不变，
因此进入前的屏幕矩形就是返回目标。测量失败（`rect: null`）时降级为
按上一层场景的布局坐标推算，再失败就只用锚点，等同于淡出。

- `FlyingProxy` 不进入画布 Node registry，不具有 `nodeId`，不参与投影、
  布局、选择和事件分发；
- 转场期间 `interactive=false`：外层不能平移、缩放或拖动，也不能重复进入；
- 测量失败 → 直接切换场景（降级）；
- `prefers-reduced-motion` → 缩短为淡入淡出；
- **动画兜底**：`onAnimationComplete` 不保证回调，`useFocusLeap` 用 900ms
  超时强制结束飞行，避免导航卡死（渲染架构第 3 节的降级要求）；
- 动画位置永不写回业务对象或布局。

### 状态环与注意力

判定集中在 `lib/attention.ts`，与 `state-ring.md` 一一对应：

- `needsDecision`：`paused` + `pending_decision/pending_tool_id` + `pending`，
  这是唯一的响铃判定；
- `needsAttention`：`paused + approved/denied`、`failed 未确认`、诊断问题；
- `isSettled`：`succeeded`、`cancelled`、`failed 且已确认`；
- `aggregateSchedule`：`partial` 直接返回 `unknown`，优先级
  `needs-decision > attention > active > settled`。

几何由 `lib/stateRing.ts` 派生：闭合 / 缺口 / 断裂 / 收束，四种形状差异
不依赖颜色；每种都带独立文案。

### 场景入口：可进入性由投影声明

能不能进入局部世界，不由节点类型、也不由「当前在哪个场景」决定，
而是由投影返回的 `SceneEntry` 声明（`SceneRenderer` 里没有 `if/else`）。

由此得到一条必须成立的推论：**Core Task 就是 Core Task**。
Schedule 子 Task 是 occurrence 物化的真实 Core Task
（`world-model.md` 第 3 节「外围每次 occurrence 仍创建独立 Core Task」），
它和外层 Task 只有「由谁创建」的区别，因此双击、操作牌、进入局部世界
全都一样。「子 Task 不进外层」指的是不进 Archive 投影、不重复计入
响铃/亮灯，不是「不能打开」——`focus-leap.md` 3.3 的原话就是
「保留每个子 Task 的原始状态**供进入详情**」。

早期实现有两条不一致，都已修正：

- `projectTaskScene()` 只在 `mockTasks` 里按 ID 找 Task，Schedule 子 Task
  找不到，打开后是「对象不可用」——这是数据源拆错了，不是设计边界。
  现在统一在**网关快照的全部 Core Task** 里查找（`TaskSceneSource.tasks`，
  它同时含外层 Task 与 Schedule 子 Task）；
- 编排台把 `canEnter` 写死为 `false`，于是同一类对象在 World 能进、
  在编排台不能进。现在 World / Schedule / Archive 都从投影的
  `sceneEntries` 读入口，只有资料来源节点（occurrence / Entry /
  Definition / Executor Configuration / Extension / Capability）
  不在入口表里，因为它们没有自己的局部世界。

入口按**全部**子 Task 声明，不按当前可见的几次：可进入性是对象的属性，
不是视口的属性。折叠只决定画布上看得到几个，不决定谁能被打开。

### 选中态

选中态由 store 单向驱动（`selectedNodeId`），画布不持有第二份选中事实。

原因：每次重算节点数组都会整体替换 React Flow 的节点对象，如果选中态挂在
那些对象上，平移、缩放、布局变化或投影刷新都会把它一起冲掉——
表现为「点了没选中」。因此 `flowNodes` 每次都写入
`selected: node.id === selectedNodeId`。

单击选中不走 React Flow 的 click，而是自己判定 pointer 序列
（`SpatialCanvas` 的手势跟踪）：

| 手势 | 判定 | 结果 |
| --- | --- | --- |
| 轻点 | 位移 ≤ 10px | 节点未选中 → 选中；已选中 → 取消选中；空白 → 取消选中 |
| 拖动 | 位移 > 10px | 移动节点或平移画布，**不改变选中态** |
| 长按（触控，480ms） | 未移动 | 节点 → 操作牌（选中，不做开关）；空白 → 菜单 |
| 双击（300ms 内同节点两次轻点） | — | 进入 ChildScene，并把选中恢复到双击之前 |

阈值取 10px 而不是 React Flow 默认的 1px：触控轻点必然带几像素指尖抖动，
1px 会把轻点误判成拖拽——这正是「长按能选中、轻点选不中」的来源。

#### 双击进入为什么不用浏览器的 dblclick

原生 `dblclick` 的阈值来自**操作系统设置**（Windows 默认 500ms），而且要求
两次点击落在**同一个元素**上。而画布上第一次点击会选中节点，节点随即从
mid 密度变成 near 密度——内容变多、DOM 变化，第二次点击命中的元素
常常已经不是同一个，浏览器于是根本不派发 `dblclick`。表现就是
「点得越快越进不去」。

所以双击进入由画布的手势层自己判定（和轻点选中同一套 pointer 序列），
原生 `dblclick` 只作为**慢速双击**的兜底保留：

| 你点得多快 | 走哪条路 |
| --- | --- |
| 两次轻点间隔 ≤ 300ms（`DOUBLE_TAP_MS`） | 手势判定，必定进入 |
| 间隔 300–500ms（超过手势窗口但在系统阈值内） | 交给原生 `dblclick`，能不能进取决于两次点击是否落在同一元素 |
| 同一节点在 600ms 内被两条路各判一次 | `ENTER_DEDUPE_MS` 抑制第二次，只入栈一次 |

两个常量都在 `SpatialCanvas` 顶部，可单独调。

#### 双击为什么要显式恢复选中

双击由两次轻点组成，但两次开关**并不抵消**：

```text
原来选中 A，双击 B：
  tap1 → toggleSelected(B) → 选中 B（A 被抢走）
  tap2 → toggleSelected(B) → 取消选中
  净结果：什么都没有选中，A 丢了
```

只有「被点的节点本来就是选中」时两次开关才等于恒等。
所以双击进入场景时由画布显式把选中恢复成双击之前的值
（`onSelectionRestore`），因为进入场景是导航，不该改变选中态。
设计也要求返回时恢复选择，快照必须反映双击前的真实选中。

`useFocusLeap` 读取选中用 `getState()` 而不是渲染期闭包：
进入场景与转场提交之间隔了一次动画，闭包值可能已经过期。

选中还会强调相关连线（`lib/relationVisual.ts`）：与选中对象相连的线提高对比度，
无关的线降低对比度但保持同一形态，不改成断裂虚线，避免被读成关系不存在。

### LOD

`lib/lod.ts` 给出三档密度，`effectiveLOD` 保证：

- 选中节点永远提升到可读层级；
- 待拍板 / 亮灯节点至少保留标题与状态文字；
- LOD 只改变渲染表现，不改变投影节点集合（有测试断言）。

**密度跟着视口本身走，画布不另存一份缩放值**。早先画布用
`useState(1)` 存一份 zoom、只由 `onMove` 更新，而返回场景时视口是
通过 `defaultViewport` 直接套用记忆值的，不会再触发一次 `onMove`——
于是密度按初始值 1（near）计算，**整层节点全部被撑开**，看起来就是
「打开一个子界面再返回，所有节点都展开了」。

这和选中态是同一条道理：画布不持有第二份事实。现在 `zoom` 由
`state.viewports[sceneId]?.zoom` 直接派生（取原始值，平移时不重渲染），
`focusLeap.test.tsx` 锁住了「返回后按恢复的视口决定密度」。

### 手势

| 意图 | 桌面 | Pad |
| --- | --- | --- |
| select | 单击 | 单击 |
| pan | 空白拖动 | 空白单指拖动 |
| move-node | 节点拖动 | 按住节点拖动 |
| zoom | 滚轮 | 双指捏合 |
| open-menu | 空白右键 | 空白长按（480ms，位移超阈值取消） |
| open-scene | 双击 / 操作牌「查看详情」 | 双击 |
| command-surface | 选中节点 | 长按节点 |
| back | Esc / 浏览器 Back / 锚点 | 返回锚点 |

滑动永远只承担导航，不承载批准、拒绝、取消。

## 4. 严格保留的边界

这些是设计文档的硬边界，实现中刻意不做「看起来更完整」的补全：

| 边界 | 实现方式 |
| --- | --- |
| 外层只有四类节点 | `WorldProjection` 只产出四类；资料节点由 `ResourceNode` 承担，有测试断言 |
| Core Task 只有一个来源 | 按 ID 查 Task 跨外层与 Schedule 子 Task（`findCoreTask`），子 Task 与外层 Task 入口一致 |
| 引用者也是全部 Core Task | 配置舱的「引用该配置的真实 Task」同样在全部 Core Task 里查找（含 Schedule 子 Task）；只查外层会对 `config-004` 这种只被 Schedule 子 Task 引用的配置说「暂无引用」 |
| 外层只有真实关系 | `WorldProjection.relations` 为空；子场景关系不提升到全局 |
| SceneRenderer 只维护一个活动画布 | World 与三个子图复用 `SpatialCanvas`，无嵌套画布；Task 场景没有画布（1.4） |
| FlyingProxy 不参与业务 registry | 独立 `TransitionLayer` + `createPortal` |
| 状态环输入不混用 | 四类节点各自读自己的投影语义（`lib/nodeVisual.ts`） |
| Schedule 子 Task 不进入外层 Archive | `collectScheduleOwnedTaskIds()` 过滤，有测试断言 |
| 不生成 Configuration → Capability | `ConfigurationProjection` 只画 `Extension → Capability` |
| 只画合法关系 | 连线只出现在编排台与配置舱（1.2 表）；`Archive → Task` 不在清单里，不画 |
| Task 场景不做成子图 | 没有画布、没有节点连线；`uses` / `awaits` 是引用摘要（1.4），有 DOM 断言 |
| 归档元数据用显式 ID | 归档时间按 `task_id` 关联；没有元数据就不显示时间 |
| accepted ≠ 成功 | 回执只标注 accepted，无庆祝动效，等待重读 |
| 失败确认需要后端接口 | `BACKEND_CAPABILITIES.acknowledge=false`，牌面显示「接口未就绪」并禁用 |
| 没有真实字段就不显示 | 无进度字段则任何密度都不画百分比 |
| 未知就是未知 | Schedule 触发时间缺失显示「未知」；映射不完整按 `unknown` 聚合 |
| 派发 ≠ 执行成功 | occurrence 只显示「已派发/未派发/派发状态未知」 |

## 5. 已知边界（与设计不一致之处）

以下是我明确知道的差距，不是设计目标：

1. **数据源已经接上后端网关**：运行时唯一来源是
   `GET /api/gateway/snapshot`（`src/api/gateway.ts`）。拿不到快照时
   画布显示「后端不可达 + 重试」状态层，**不渲染任何节点**——
   `src/mock/` 已降级为夹具（投影契约测试 + `VITE_DATA_SOURCE=mock`
   的离线开发），不再有任何静默回落。界面右下角常驻
   `BackendCapabilityNotice`，列出仍未就绪的目标接口；
2. **没有 Change Feed**：不做增量同步、游标推进与快照恢复。SSE 只当
   「有变化」的信号，收到就重拉整份快照；
3. **新建任务**仍是本地提交（`prototypeTaskStore`），节点带
   `isPrototypeDraft` 标记，并在界面标注「原型本地提交，非 Core 事实」。
   后端的 `create_task` 命令已经存在，但还没有接进「新建任务」流程；
4. **命令提交后按真实结果反馈**：成功显示 accepted 并重读快照，
   失败显示 rejected 与后端给的原因（不再无条件提示「已接受」）。
   回执本身仍不会被后续重读结果推翻（`focus-leap.md` 3.5 的
   「等待重读」目前只做到重读，没做到回执随事实更新）；
5. **Agent Audit 仍是夹具数据**：后端还没有审计投影接口（
   `backend-contract.md` 第 7 节的 `GET /api/tasks/{id}/agent-audit`
   是目标契约），这一条线不能作为真实任务执行过程的证据。Core Event Log
   已经是真实数据；
6. **Schedule 子图只画得出两个角色**：网关快照只有 `schedules` +
   `dispatches`，没有 Schedule Entry 与 Task Definition，因此
   `has` / `references` 两条关系在真实数据下画不出来。四角色的契约由
   `projection.test.ts` 在设计夹具上覆盖，等外围把这两个角色放进快照后
   再补 DOM 断言；
7. **动画时长与缓动**未做视觉验收冻结，当前 420ms / `cubic-bezier(.4,0,.2,1)`；
8. **视觉细节**（颜色对比、字号、间距）只做了设计取向的实现。
   已用 CDP 截图做过几轮目视与实测（第 6 节），但没有做过
   **真实屏幕上的视觉验收**（对比度、色偏、在不同显示器上的观感）；
9. **「有视口记忆时不再 fitView」这一分支没有测试覆盖**：jsdom 里
   React Flow 节点的尺寸恒为 0，`fitView` 无从计算，开关这条分支
   测试结果都一样。它影响的是返回时的取景（有关系时回到离开前的视野），
   需要在真实浏览器里确认；`focusLeap.test.tsx` 只锁住了「挂载时用的是
   视口记忆」这一半；
10. **卡片的外观没有自动化覆盖**：卡片尺寸、圆角、阴影、吸附是纯视觉，
   自动化只能量到数值（宽度、行数、遮挡面积），量不出好看不好看。
   测试锁住的是行为（消息的先后顺序、角色卡各出现几次）；
11. **视觉语言已与 occ-web 对齐**：调色板、材质配方、圆角尺度、字号层级
   全部照 occ-web 抄过来（见 1.4）。若 occ-web 那边改了配色，这里需要跟着改——
   两份 token 目前是各自定义的，没有共享包；
12. **节点宽度与页脚长度是硬绑的**：节点宽由注意力档决定（180/190/200/208），
   页脚可用宽度因此只有 154px，而最长的状态文字「失败（已确认）」占 77px。
   留给时长的余量只有 69px——`20m 0s` 这种写法（83px）放不下，会从中间断行。
   现在用 occ-web 的紧凑写法（`20min`，66px）压在一行内，并给页脚加了
   `flex-wrap` 兜底。**再往页脚塞任何字都会重新触发这个问题**，
   要加内容得先重新量（第 6 节给了量法）；
13. **悬浮层会盖住画布节点**（浏览器实测量出，未修）：根因是 `fitView`
   只按画布矩形取景，不知道屏幕边缘有固定悬浮层。实测（1600×1000）：
   编排台概览栈盖住 `def-daily-sync` 2537px²；视口缩到 1280×720 后同一
   根因又多吃两个：`schedule-006` 被左下的子 Task 分区盖住 8213px²、
   配置舱 `config-001` 被概览栈盖住 4034px²。React Flow v11 的
   `fitViewOptions.padding` 只接受标量，要做「按边留白」得自己接管
   framing（先 fitView 再按保留区平移视口）。这是取景策略的决定，
   没有擅自改——**第 3、6 两项（观感、大屏空置）和它是同一个决定**。
   已修的一处：配置舱引用列表原在左下、压住 `cap-001` 1263px²，
   现在按设计的「底部两侧」挪到右下（该场景右下本来就是空的）。

### 与原计划的一处结构差异

计划里列了一个通用 `FloatingContainer`（可拖动 + 安全区吸附）。
实现时只在 `FloatingHud` 内做了拖动与吸附，没有抽出通用组件，原因是：

- 左上角焦点锚点必须与 `flip.ts` 的 `ANCHOR_RECT` 严格一致，
  否则飞行终点和锚点会对不上；
- 操作牌、审计面板是位置固定的 Overlay，不需要拖动语义。

三者的定位约束不同，强行统一反而会引入额外间接层。
共用的部分（玻璃态、尺寸、层级）由 `GlassPanel` 承担。

### 动效边界

- 不用循环闪烁表达普通运行状态（连接状态用静态标记）；
- `prefers-reduced-motion` 下 FlyingProxy 只淡入淡出，不做位移或缩放；
- 失败和未知状态停留在对象上，不因动画结束而被表现为成功。

## 6. 验证

### 浏览器实测

`scripts/shot.mjs` 用 CDP 驱动本机 Edge（零依赖：Node 自带 WebSocket），
派发的是**可信指针事件**，走的是用户路径（真实双击、真实点返回锚点），
不是直接改 store。它补上了 jsdom 测不到的那一层：命中测试、原生事件、
真实排版与取景。

已用它做过的事：

- **实测确认双击失灵的诊断**：真实双击（两次点击间隔 60ms）时，
  浏览器派发的原生 `dblclick` 次数是 **0**，而场景仍然进入——进入
  确实由画布的手势层完成，不依赖浏览器；
- 量出 World 里 `schedule-005 × archive-entry` 重叠 12×46px（已修：
  右侧入口列从 x=1400 移到 1560）；
- 量出悬浮层遮挡（见 §5 第 12 条，未修；其中配置舱引用面板那处已修）；
- **量出页脚为什么折行**：节点内容盒 154px，`持续时间 20m 0s` 一行要
  83px，最长状态文字「失败（已确认）」占 77px，加 8px 间距共 168px——
  差 14px，浏览器于是把时长从中间断成两行（页脚高 40px vs 正常的 24px）。
  换成 occ-web 的 `20min`（66px）后 151px，一行放得下；
- **量出 `.label` 的 0.2em 字距落在中文上**：11px 的中文串拿到
  `letter-spacing: 2.2px`，渲染成「引 用 该 配 置」；
- **修掉了量测工具自身的一个盲点**：`overlap.mjs` 原来按 class 点名找
  悬浮层（`.glass-strong`），而配置舱的引用列表用的是 `.glass`——
  于是「面板压住 cap-001」量了很久都没报出来。现在改成取**所有**
  `fixed` 面板（按尺寸排除全屏信息面），不再依赖 class 名单。

```bash
node scripts/shot.mjs --script scripts/scenes/all.mjs --out shots/all.png
node scripts/shot.mjs --script scripts/scenes/overlap.mjs --out shots/ov.png
```

```bash
npm run test    # 140 项：注意力判定、投影契约、网关契约、SceneStack、Focus Leap、选择、场景布局、格式化、App 冒烟
npm run build   # tsc -b && vite build
```

测试直接对应设计文档的验收条目，尤其是：

- `attention.test.ts`：唯一响铃判定；paused 三种含义；已确认失败仍为断裂环；
- `projection.test.ts`：Schedule 子 Task 不泄漏到 Archive；无
  Configuration → Capability；无 Task → Task；两条信息线不互相污染；
  子 Task 能打开自己的局部世界；入口只给 Core Task、不随折叠变化；
- `focusLeap.test.tsx`：进入/返回只改 UI Scene State；外层坐标不被改写；
  从编排台双击子 Task 进入 TaskScene；返回飞向进入时测到的源矩形，
  且回到上一层场景而不是 World；
- `sceneOverlay.test.tsx`：Task 场景没有画布（不是子图）、信息面顶部让开 HUD、
  人机交互按发生顺序排、固定代码的执行者画单卡、身份条给的是引用徽标而不是节点；
- `sceneStore.test.ts`：多层进入逐层返回；返回恢复外层 viewport 与 selection；
- `format.test.ts`：时长格式化的每个分支（零秒不显示、分进位到小时、
  没有值返回 `null`）——页脚的宽度假设建立在这个函数的输出长度上，
  改坏一个分支就会重新折行。

每个非显然的保护都做过反向变异验证（把实现改回错误版本，对应用例必须
失败），避免出现「改坏了测试还全绿」的空转断言。
