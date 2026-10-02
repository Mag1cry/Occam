/**
 * Task Projection
 *
 * 输入：快照里的 Task、ControlEvent、Executor Configuration 目录
 * 输出：Task 的引用摘要与 Core Event Log
 *
 * Core Event 与 Agent Audit 是两条来源不同的信息线，不能混成一条事件带：
 * - Core Event Log：内核控制事实，按追加顺序展示（本投影负责）；
 * - Agent Audit：外围 Agent 执行资料，按需从执行者的 checkpoint 读
 *   （`GET /api/tasks/{id}/agent-audit`，由场景拉取），不从 Core Event 拼接。
 *
 * Task 局部世界不是子图：`focus-leap.md` 3.1 的 Task 场景由焦点对象、
 * 两条信息线和操作牌组成，只有编排台 / 档案馆 / 配置舱才是子图
 * （`rendering-architecture.md` 的命名约定把 Task Focus 与后三类子图分开）。
 * 所以这里不产出画布节点和连线，只把局部真实关系解析成可显示的引用：
 *
 *   Task ──uses──> Executor Configuration   → executor（三态引用）
 *   Task ──awaits──> pending Capability      → pendingToolId（仅 pending_tool_id 存在）
 *
 * 执行者引用是**三态**（ADR-024），不是「有 / 没有」：没有这个字段表示这个 Task
 * 根本没引用执行者；有引用但解析不到时给最小占位（引用 + 已下线/未知 + 原因），
 * 因为一条历史记录引用了一个已下线的配置，是必须说得出来的事实——直接不显示
 * 会让「它下线了」和「这条记录本来就没有这个字段」长得一模一样。
 *
 * 不产出 Worker 节点、Controller 进程节点、checkpoint 节点、Agent 思考节点，
 * 也不生成 Configuration → Capability 虚假关系。
 */

import type { ReferenceView, TaskNode } from '../types/node';
import type { ControlEvent, GatewaySnapshot } from '../../api/gateway';
import { referenceStateOf } from './referenceState';

/**
 * Task 场景输入
 *
 * 唯一来源是后端网关快照的对应切片：Core Task、Core 控制事件、快照本身
 * （引用解析要用到其中的注册清单与配置状态）。没有 mock 兜底——拿不到快照时
 * 由场景渲染状态层，不伪造替代对象。
 */
export interface TaskSceneSource {
  tasks: TaskNode[];
  events: Record<string, ControlEvent[]>;
  /** 快照：引用的三态从这里的同一批事实算（判据见 `referenceState.ts`） */
  snapshot: GatewaySnapshot;
}

/**
 * Task 场景模型
 */
export interface TaskSceneModel {
  /** 焦点 Task；不存在时必须显示未知，不能伪造 */
  task: TaskNode | null;

  /**
   * Task 引用的执行者
   *
   * `null` 表示这个 Task **没有**执行者引用；有引用但解析不到时给的是
   * `state !== 'resolvable'` 的三态视图，界面据此显示最小占位。
   */
  executor: ReferenceView | null;

  /** pending Tool 引用（pending_tool_id 存在时） */
  pendingToolId: string | null;

  /** 内核控制事实 */
  events: ControlEvent[];

}

/**
 * 投影 Task 局部世界
 */
export function projectTaskScene(taskId: string, source: TaskSceneSource): TaskSceneModel {
  // Core Task 只有一个来源：Schedule 子 Task 也是真实 Core Task，只是由外围创建，
  // 所以查找必须跨全部 Core Task，不能只查外层数组
  const task = source.tasks.find((item) => item.id === taskId) ?? null;

  if (!task) {
    return { task: null, executor: null, pendingToolId: null, events: [] };
  }

  /*
    Task ──uses──> Executor Configuration。

    智能体是执行者的一种（`agent:<id>`，ADR-026），所以这一步要能同时解析
    `uniapi:qwen-max` 与 `agent:ops`——三态解析按引用自己判断，不在这里分流。
  */
  const executor = task.executor_config_id
    ? referenceStateOf(task.executor_config_id, source.snapshot)
    : null;

  // pending_tool_id 只支持显示当前等待的工具引用，不能让前端推演 Agent 下一步
  const pendingToolId = task.pending_tool_id ?? null;

  // Core Event Log：内核控制事实，按后端追加顺序（数组顺序）原样展示
  const events = source.events[taskId] ?? [];

  // Agent Audit 不在这里：它是执行者外围的只读投影，按需从
  // `GET /api/tasks/{id}/agent-audit` 读取（见 TaskScene）。
  // 投影器只负责 Core 侧的两件事——Task 本身和 Core 控制事件。
  return { task, executor, pendingToolId, events };
}
