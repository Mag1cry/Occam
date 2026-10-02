# OCC 指挥中心前端

> 基于 `../docs-Next-Version/command-center-design/` 实现：
> 全屏空间画布 + 悬浮 Overlay，数据来自后端 `occ-next` 的网关快照。

## 快速开始

先起后端（`occ-next`，默认 8765），再起前端：

```bash
# 1) 后端
cd ../occ-next && uv run python -m src.serve

# 2) 前端
npm install
npm run dev      # http://localhost:5173，/api 代理到 127.0.0.1:8765
```

代理目标可用 `VITE_GATEWAY_DEV_URL` 覆盖；生产构建默认同源。

其他命令：

```bash
npm run test     # vitest（140 项）
npm run build    # tsc -b && vite build
npm run lint     # oxlint
```

离线开发（不需要后端）用夹具快照，**必须显式开启**：

```bash
VITE_DATA_SOURCE=mock npm run dev
```

开发用（不属于产物）：用 CDP 驱动本机 Edge 截图与量测，零依赖：

```bash
node scripts/shot.mjs --out shots/world.png                      # 首屏
node scripts/shot.mjs --script scripts/scenes/all.mjs --out out.png   # 四个场景各一张
node scripts/shot.mjs --script scripts/scenes/overlap.mjs --out ov.png # 量节点重叠/被遮挡
```

## 可以看到什么

**World Scene（全屏画布）**

外层只显示四类节点，0 条连线。数量以后端为准（下面括号里是离线夹具的规模）：

| 节点 | 数量 | 说明 |
| --- | --- | --- |
| `Task` | 每个非 Schedule 的 Core Task 一个（夹具 10） | 每个真实 Core Task 一个；Schedule 子 Task 归编排台 |
| `Schedule` | 每个外围 Schedule 一个（夹具 6） | 聚合与子 Task 数由 occurrence 与子 Task 派生 |
| `Archive` | 1 | 档案馆入口，历史 Task 不铺回外层 |
| `Configuration` | 1 | 配置舱入口，配置资料不进外层 |

- 缩放、平移、拖动节点；布局按 `sceneId + objectId` 记忆在 localStorage；
- 外层没有连线：设计列出的真实关系两端都在子场景内部，只能在子场景绘制
  （「节点可以没有连线。只有真实关系才画线」）；
- 滚轮/捏合缩放时信息密度随 LOD 变化，选中与待拍板节点保持可读；
- 空白处右键（桌面）或长按（Pad）打开菜单 → 新建任务。

手势分工：

| 操作 | 结果 |
| --- | --- |
| 单击节点 | 选中（节点展开到可读密度，底部出现操作牌，相关连线提高对比度） |
| 再单击已选中的节点 | 取消选中 |
| 单击空白 | 取消选中 |
| 拖动节点 | 只改布局，不改变选中态 |
| 双击节点 | 进入局部场景（不改变选中态）；可进入的节点由投影声明，子场景里的 Core Task 同样适用 |
| 长按节点（Pad） | 打开操作牌 |
| 长按空白（Pad）/ 右键 | 打开菜单 |

**Focus Leap**

- 双击节点进入局部场景；节点飞行到左上角锚点；
- 左上角锚点 / `Esc` / 浏览器返回 都执行 `SceneStack.pop()`；
- 返回后恢复外层视口与选择，外层节点坐标不变。

**四类局部场景**

- `TaskScene`：一块铺满全屏的信息面——身份条（状态环 / 委托摘要 / 持续时间 /
  真实引用徽标 / Controller 观测）、**完整的人机交互**（一条记录一张卡、横向翻页，
  身份标在卡片下方；工具调用在那条序列里面）。**没有画布**：Task 是焦点场景，只有
  编排台 / 档案馆 / 配置舱才是「父对象 → 子节点 + 真实关系」的子图；
  顶部内边距把 HUD 让开；
- `ScheduleScene`：`Schedule → Entry → Task Definition` 与
  `Schedule → occurrence → Core Task` 两条权威关系，四个角色各有独立节点；
  重复执行的历史默认折叠（只显示最近 4 次，可展开），
  但聚合始终基于全部子 Task；子 Task 分区（待拍板 / 运行 / 待检查 / 历史折叠）
  只在编排台内部存在；子 Task 是真实 Core Task，可以和外层 Task 一样
  双击进入它自己的局部世界；
- `ArchiveScene`：非 Schedule 的终态 Core Task，按状态筛选，
  **没有任何连线**——事件、结果和诊断是时间序列组件，不变成空间图节点；
  归档时间只来自显式元数据，缺失就不显示。选中后可以进入该 Task 的局部世界；
- `ConfigurationScene`：Executor Configuration / Extension / Capability，
  只画 `Extension → Capability`。

编排台与配置舱中的 Executor Configuration、Extension、Capability、
Schedule Entry、Task Definition、occurrence 都是**资料节点**（`ResourceNode`），
不是外层第五类节点，也不会出现在 World。Task 场景没有资料节点：
它的 Executor Configuration / pending Capability 是引用摘要，不是空间对象。

**操作与反馈**

- 操作牌由对象当前事实生成（`focus-leap.md` 的操作矩阵），
  普通节点不常驻按钮列；
- 高风险命令（取消、拒绝、批准、启停）一律先进入预览，
  再确认提交；
- 提交后只显示 `accepted` 回执，并说明这不等于执行成功。

## 悬浮层

画布独占 100vw × 100vh，所有 UI 都是 Overlay：

| 组件 | 位置 | 作用 |
| --- | --- | --- |
| `FloatingHud` | 顶部中央胶囊 | 时间、连接、待拍板数、亮灯数、当前焦点；可拖动/折叠 |
| `FocusAnchor` | 左上角 | 焦点对象的实体化返回锚点 |
| `CommandSurface` | 底部 | 状态驱动的操作牌 |
| `ActionPreview` | 居中模态 | 高风险命令预览与确认 |
| `WorldContextMenu` | 指针位置 | 空白处菜单 |
| `BackendCapabilityNotice` | 右下角 | 标注未就绪的目标接口 |
| `TransitionLayer` | portal | FlyingProxy 飞行代理 |

## 技术栈与视觉

Vite + React + TypeScript + React Flow + Framer Motion + Zustand + Tailwind CSS v4。

视觉系统**与 `../occ-web` 同源**：近黑中性面（`#05070a` / `#0f1011` / `#191a1b`）、
青色主强调（`#2dd4a7`）、色盲安全的三态色（青 / 琥珀 `#ffb020` / 品红 `#ff5470`）、
小字号密集排版（11–13px + 等宽数字 + 小标签）、战术网格底衬。
节点表面按状态派生（`src/lib/nodeSurface.ts`）：状态色淡渐变 + 内高光 +
柔和投影，需要响应的节点加同色外发光。

字距只给拉丁串：occ-web 的 `.label` 是全大写英文专用，0.2em 套到中文上会把词撑散，
所以中文标签用不带字距的 `.label`，拉丁串显式加 `.label-en`。
时长用 `src/lib/format.ts` 的紧凑写法（`20min` / `1h 15min`），零秒不显示——
节点页脚只有 154px 可用，`20m 0s` 放不下。

## 目录结构

```text
src/
├── api/               gateway.ts（快照/命令/SSE 的唯一出入口）+ 契约测试
├── core/
│   ├── scene/         SceneRenderer / SpatialCanvas / TransitionLayer
│   ├── projection/    投影器（World / Task / Schedule / Archive / Configuration）+ 快照来源
│   └── types/         scene / node / state / projection
├── scenes/            WorldScene、TaskScene、ScheduleScene、ArchiveScene、ConfigurationScene
├── components/
│   ├── nodes/         TaskNode / ScheduleNode / ArchiveNode / ConfigurationNode / StateRing
│   ├── overlay/       HUD / 锚点 / 操作牌 / 预览 / 菜单 / 新建任务 / 状态层
│   ├── audit/         CoreEventLog / AgentAuditPanel / AgentConversation / PlainCallCard / AuditCard
│   └── ui/            Button / Badge / Card / GlassPanel
├── lib/               状态环、注意力、LOD、命令矩阵、命令提交、FLIP、节点视觉
├── mock/              夹具：离线快照构建（snapshot.ts）+ 各对象数据
├── store/             gateway / scene / selection / layout / transition / prototypeTask
└── hooks/             useFocusLeap
```

## 重要说明

数据只有**一个**运行时来源：后端网关快照。

- `GET /api/gateway/snapshot` 全量读取，`POST /api/gateway/commands`
  提交命令，`GET /api/gateway/events`（SSE）只当「有变化」的信号；
- **拿不到快照就不渲染任何节点**：画布显示「后端不可达 + 重试」状态层，
  HUD 显示「已断开」。`src/mock/` 是夹具，没有任何静默回落；
- `acknowledge` 与增量游标（Change Feed）仍是目标接口，界面上以禁用状态
  显示，不用本地状态替代；
- 「新建任务」仍是原型本地提交，节点带原型标记；
- Core Event Log 是真实数据；Agent Audit 仍是夹具（后端还没有审计投影接口）；
- 已知差距与刻意保留的边界见 [DESIGN.md](./DESIGN.md)。

设计文档位于 `../docs-Next-Version/command-center-design/`，
实现与设计的对应关系见 [DESIGN.md](./DESIGN.md)。
