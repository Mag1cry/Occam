/**
 * Schedule Projection
 *
 * 输入：网关快照的 schedules / tasks / dispatches 三个切片。
 * 输出：Schedule 子图节点和聚合状态。
 *
 * **只读快照，不读夹具**。这个文件以前同时导出两支：一支读 `mock/` 的同名函数，
 * 一支读快照的 `projectLive*`。两支并存的结果是测试测的是原型、跑的是另一支，
 * 而「改错了地方」在两边都不报错。现在只有读快照这一支。
 *
 * 关系（projection-contract.md 第 4 节）只有两条——**只有这两条存在**：
 *
 *   Schedule ──creates──▶ occurrence ──materializes──▶ Core Task
 *
 * 文档里另外两条（has → Schedule Entry、references → Task Definition）
 * 依赖一层已经决定不做的契约（任务定义注册表），所以模型里没有对应字段，
 * 也不补造节点或边。测试钉住的就是「只有两条」。
 *
 * 「聚合」始终基于**全部** occurrence：折叠只改变可见节点，不改变聚合状态——
 * 不能用当前显示的几次冒充完整 Schedule 状态（那条有测试用数据反证）。
 */

import type { ProjectionOutput, ScheduleOccurrence } from '../types/projection';
import type { TaskNode, ScheduleNode } from '../types/node';
import { aggregateSchedule, needsDecision, isSettled, taskAttentionLevel } from '../../lib/attention';
import type { ScheduleAttention } from '../types/state';
import type { GatewayDispatch, GatewaySchedule } from '../../api/gateway';

/**
 * Schedule 子图分区
 * 分区仅在 Schedule 内部存在，不重复计入外层响铃/亮灯数量
 */
export interface SchedulePartitions {
  /** 待拍板 */
  needsDecision: TaskNode[];
  /** 运行中（含已批准/已拒绝待恢复） */
  active: TaskNode[];
  /** 待检查 */
  attention: TaskNode[];
  /** 历史折叠 */
  settled: TaskNode[];
}

export interface ScheduleSceneOptions {
  /**
   * 可见的最近 occurrence 数量
   *
   * 省略表示全部展开。只影响画布节点，不影响聚合与分区。
   */
  maxOccurrences?: number;
}

/**
 * Schedule 场景模型
 */
export interface ScheduleSceneModel {
  scheduleId: string;
  /** 子 Task 与 mapping 完整性 */
  completeness: 'complete' | 'partial';
  /** 聚合基于全部 occurrence，不受可见数量影响 */
  aggregate: ScheduleAttention;
  /** 全部 occurrence，按触发时间倒序（最新在前） */
  allOccurrences: ScheduleOccurrence[];
  /** 本次投影可见的 occurrence */
  visibleOccurrences: ScheduleOccurrence[];
  /** 被折叠的 occurrence 数量 */
  hiddenOccurrenceCount: number;
  /** 全部子 Task，与可见数量无关 */
  childTasks: TaskNode[];
  partitions: SchedulePartitions;
  projection: ProjectionOutput;
}


export function projectLiveScheduleNodes(schedules: GatewaySchedule[], tasks: TaskNode[], dispatches: GatewayDispatch[] = []): ScheduleNode[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  return schedules.map((schedule, index) => {
    const ownedIds = dispatches.filter((item) => item.schedule_id === schedule.schedule_id).flatMap((item) => item.task_ids);
    const ownedTasks = ownedIds.map((id) => taskById.get(id)).filter((task): task is TaskNode => Boolean(task));
    return {
      id: schedule.schedule_id,
      type: 'schedule',
      label: String(schedule.name ?? schedule.summary ?? schedule.schedule_id),
      rule_summary: String(schedule.cron ?? schedule.expression ?? ''),
      enabled: schedule.enabled,
      x: 1080 + (index % 3) * 220,
      y: 150 + Math.floor(index / 3) * 200,
      aggregated_state: aggregateSchedule(ownedTasks, ownedIds.length === ownedTasks.length ? 'complete' : 'partial'),
      child_task_count: ownedIds.length,
    };
  });
}

export function projectLiveScheduleScene(scheduleId: string, schedules: GatewaySchedule[], tasks: TaskNode[], dispatches: GatewayDispatch[] = [], options: ScheduleSceneOptions = {}): ScheduleSceneModel {
  const schedule = projectLiveScheduleNodes(schedules, tasks, dispatches).find((item) => item.id === scheduleId) ?? null;
  const records = dispatches.filter((item) => item.schedule_id === scheduleId);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const allOccurrences: ScheduleOccurrence[] = records.flatMap((record) => {
    // 后端说失败就是失败：塌成「未知」等于把它给的结论丢掉，而「没跑过」
    // 和「跑了但失败了」在界面上本该是两件事
    const status = record.status === 'dispatched' ? 'dispatched'
      : record.status === 'failed' ? 'failed' : 'unknown';
    /*
      没物化出 Task 的派发也要画出来。

      派发失败（比如它引用的执行者配置没了）时一条 Task 都没建出来，按 task_ids
      展开的话这次尝试在界面上等于不存在——「从来没派发过」和「派发了但失败了」
      就又变成同一个样子，而那正是要区分的东西。
    */
    if (record.task_ids.length === 0) {
      return [{
        occurrence_id: record.occurrence_key,
        schedule_id: scheduleId,
        task_id: '',
        entry_id: record.occurrence_key,
        triggered_at: record.updated_at ?? null,
        dispatch_status: status,
        dispatch_error: record.error || undefined,
      } as ScheduleOccurrence];
    }
    return record.task_ids.map((taskId, index) => ({
      // 一次派发只物化一个 Task 时 occurrence 的 ID 就是派发键本身；
      // 一个派发带多个 Task（外围批量派发）才需要下标区分
      occurrence_id: record.task_ids.length === 1 ? record.occurrence_key : `${record.occurrence_key}:${index}`,
      schedule_id: scheduleId,
      task_id: taskId,
      entry_id: record.occurrence_key,
      triggered_at: record.updated_at ?? null,
      dispatch_status: status,
      dispatch_error: record.error || undefined,
    } as ScheduleOccurrence));
  }).sort(byTriggeredAtDesc);
  const childTasks = allOccurrences.map((item) => taskById.get(item.task_id)).filter((task): task is TaskNode => Boolean(task));
  const visibleOccurrences = options.maxOccurrences === undefined ? allOccurrences : allOccurrences.slice(0, Math.max(0, options.maxOccurrences));
  const partitions: SchedulePartitions = {
    needsDecision: childTasks.filter(needsDecision), active: childTasks.filter((task) => taskAttentionLevel(task) === 'active'),
    attention: childTasks.filter((task) => taskAttentionLevel(task) === 'attention'), settled: childTasks.filter(isSettled),
  };
  const nodes: ProjectionOutput['nodes'] = schedule ? [{ ...schedule, x: SCHEDULE_COLUMN_X, y: SCHEDULE_Y }] : [];
  const relations: ProjectionOutput['relations'] = [];
  visibleOccurrences.forEach((occurrence, index) => {
    nodes.push({ type: 'resource', id: occurrence.occurrence_id, resource_kind: 'occurrence', label: occurrence.occurrence_id,
      x: index * OCCURRENCE_GAP, y: OCCURRENCE_Y, summary: occurrence.triggered_at ? `派发于 ${new Date(occurrence.triggered_at).toLocaleString()}` : '派发时间未知', dispatch_status: occurrence.dispatch_status, dispatch_error: occurrence.dispatch_error });
    if (schedule) relations.push({ id: `rel-${schedule.id}-creates-${occurrence.occurrence_id}`, source: schedule.id, target: occurrence.occurrence_id, type: 'creates', label: 'creates' });
    const task = taskById.get(occurrence.task_id);
    if (task) { nodes.push({ ...task, x: index * OCCURRENCE_GAP, y: TASK_Y }); relations.push({ id: `rel-${occurrence.occurrence_id}-materializes-${task.id}`, source: occurrence.occurrence_id, target: task.id, type: 'materializes', label: 'materializes' }); }
  });
  return { scheduleId, completeness: childTasks.length === allOccurrences.length ? 'complete' : 'partial', aggregate: schedule?.aggregated_state ?? 'unknown',
    allOccurrences, visibleOccurrences, hiddenOccurrenceCount: allOccurrences.length - visibleOccurrences.length, childTasks,
    partitions, projection: { nodes, relations, sceneEntries: childTasks.map((task) => ({ nodeId: task.id, canEnter: true, targetScene: 'task' as const, label: '进入任务世界' })) } };
}

/** 局部场景坐标：Schedule 列在左，occurrence / Task 按行向右铺开 */
const SCHEDULE_COLUMN_X = -560;
const SCHEDULE_Y = 320;
const OCCURRENCE_Y = 320;
const TASK_Y = 560;
const OCCURRENCE_GAP = 300;

/**
 * 触发时间倒序
 *
 * 缺失触发时间的排最后，且不用其他时间顶替。
 */
function byTriggeredAtDesc(a: ScheduleOccurrence, b: ScheduleOccurrence): number {
  if (a.triggered_at === null && b.triggered_at === null) return 0;
  if (a.triggered_at === null) return 1;
  if (b.triggered_at === null) return -1;
  return b.triggered_at.localeCompare(a.triggered_at);
}


