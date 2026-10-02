/**
 * World Projection
 *
 * 输入：Task、Schedule、Archive、Configuration 摘要
 * 输出：外层节点和真实关系
 *
 * 外层只承认四类节点（world-model.md 第 2 节）：
 *   Task          每个真实 Core Task 一个节点
 *   Schedule      每个外围 Schedule 一个节点
 *   Archive       一个档案馆入口节点，不把历史 Task 铺回 World
 *   Configuration 一个配置舱入口节点
 *
 * 不展开内部条目：Executor Configuration、Extension、Capability、
 * Task Definition、Schedule Entry、occurrence、Archive Record 都是资料节点，
 * 只在对应 ChildScene 中出现。
 *
 * 关于连线：外层目前没有任何合法关系。设计文档列出的真实关系
 * （Task→Executor Configuration、Extension→Capability 等）两端都是
 * 子场景资料节点，只能在子场景内绘制。外层「节点可以没有连线」，
 * 把子场景关系画到全局会让外层同时看起来更拥挤也更不真实。
 */

import type { ProjectionOutput } from '../types/projection';
import type { Node } from '../types/node';
import { deriveAttentionSummary } from '../../lib/attention';
import { projectLiveScheduleNodes } from './ScheduleProjection';
import type { TaskNode } from '../types/node';
import type { GatewayDispatch, GatewaySchedule } from '../../api/gateway';

/**
 * World 投影输入
 *
 * 唯一来源是后端网关快照的对应切片。这里没有 mock 兜底：
 * 拿不到快照时由 SceneRenderer 渲染状态层说明原因，
 * 不允许用原型数据冒充真实世界。
 */
export interface WorldInput {
  tasks: TaskNode[];
  schedules: GatewaySchedule[];
  dispatches: GatewayDispatch[];
}

/**
 * 外层两个固定入口节点
 *
 * 它们**不是后端数据**：快照里没有「档案馆入口」这种对象。它们是这张画布的固定
 * 入口——label 是界面用词、坐标是布局。身份（`archive-entry` /
 * `configuration-entry`）是 UI 契约：它进布局记忆、进场景栈的 focusId、也进
 * sceneEntries 的 nodeId，所以必须稳定且只有一处定义。
 *
 * 定义在投影层而不是 mock 里：生产模块 import 夹具，等于让原型数据决定界面身份，
 * 而那句「这里没有 mock 兜底」也就没法用 grep 验证了。依赖方向应该是夹具引用
 * 界面契约，不是反过来。
 */
const ARCHIVE_ENTRY = {
  id: 'archive-entry',
  label: '档案馆',
  summary: '归档过的 Task：收进去之后只剩「删除」',
  x: 1560,
  y: 350,
} as const;

const CONFIGURATION_ENTRY = {
  id: 'configuration-entry',
  label: '配置舱',
  summary: 'Executor Configuration、Extension、Capability',
  x: 1560,
  y: 650,
} as const;

/**
 * World Projection
 */
export function projectWorldScene(input: WorldInput): ProjectionOutput {
  const { tasks: allTasks, schedules: rawSchedules, dispatches } = input;

  // Schedule 的 occurrence 物化出的是真实 Core Task，但它们归编排台管，
  // 只在 Schedule 的局部世界里出现（world-model.md：子 Task 不进入外层）。
  // 判据是派发记录里的真实 ID 映射，不是名字前缀之类的猜测。
  const ownedTaskIds = new Set(dispatches.flatMap((dispatch) => dispatch.task_ids));
  /*
    **归档过的离开这个屏幕。**

    归档是"我把它收起来了"——收起来之后它还在这儿，那这个动作等于什么都没做，
    而那张卡片会永远占着一格。它去了档案馆（那个入口上的计数说的是同一批）。

    跑完但**没归档**的仍然留在这儿：那正是"堆着等你收"的样子，
    也是「归档」那个按钮该出现的场合。
  */
  const tasks = allTasks.filter((task) => !ownedTaskIds.has(task.id) && !task.archived_at);

  // Schedule 的聚合仍然基于**全部**子 Task（包括外层看不见的那些）
  const schedules = projectLiveScheduleNodes(rawSchedules, allTasks, dispatches);

  /*
    「N 条归档」数的是**归档过的**——和档案馆同一条规则，**还要同一批**。
    **不是"跑完了"**：跑完只说明它可以被归档，不说明有人收过它。
    子 Task 不算：它们归编排台，馆里不摆它们（`LiveArchiveProjection` 里那条）。
    一个数里含着馆里看不到的东西，点进去就会发现对不上。
  */
  const archiveRecordCount = allTasks
    .filter((task) => !ownedTaskIds.has(task.id))
    .filter((task) => Boolean(task.archived_at)).length;

  const nodes: Node[] = [
    // 每个真实 Core Task 一个节点，位置由用户拖动决定
    ...tasks,

    // 每个外围 Schedule 一个节点
    ...schedules,

    // 档案馆入口：只有一个，条目不铺到外层
    {
      id: ARCHIVE_ENTRY.id,
      type: 'archive',
      label: ARCHIVE_ENTRY.label,
      x: ARCHIVE_ENTRY.x,
      y: ARCHIVE_ENTRY.y,
      record_count: archiveRecordCount,
      summary: ARCHIVE_ENTRY.summary,
    },

    // 配置舱入口：只有一个
    //
    // 不带 diagnostics_ok：快照里没有诊断来源，
    // 猜「正常」和猜「需检查」一样不允许。
    {
      id: CONFIGURATION_ENTRY.id,
      type: 'configuration',
      label: CONFIGURATION_ENTRY.label,
      x: CONFIGURATION_ENTRY.x,
      y: CONFIGURATION_ENTRY.y,
      summary: CONFIGURATION_ENTRY.summary,
    },
  ];

  // 外层没有合法关系：不画线，也不把子场景关系提升到全局
  const relations: ProjectionOutput['relations'] = [];

  // 场景入口由投影提供，SceneRenderer 不根据业务类型写死
  const sceneEntries = [
    ...tasks.map((task) => ({
      nodeId: task.id,
      canEnter: true,
      targetScene: 'task' as const,
      label: '进入任务世界',
    })),
    ...schedules.map((schedule) => ({
      nodeId: schedule.id,
      canEnter: true,
      targetScene: 'schedule' as const,
      label: '进入编排台',
    })),
    {
      nodeId: ARCHIVE_ENTRY.id,
      canEnter: true,
      targetScene: 'archive' as const,
      label: '进入档案馆',
    },
    {
      nodeId: CONFIGURATION_ENTRY.id,
      canEnter: true,
      targetScene: 'configuration' as const,
      label: '进入配置舱',
    },
  ];

  const attentionSummary = deriveAttentionSummary(tasks, schedules);

  return { nodes, relations, sceneEntries, attentionSummary };
}

