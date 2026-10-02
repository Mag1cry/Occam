/**
 * 注意力派生逻辑
 *
 * 权威判定来源：state-ring.md 第 3 节（响铃 / 亮灯 / 已收敛）
 * 以及第 4 节（Schedule 聚合环）。
 *
 * 关键约束：任何“是否响铃”“是否进入待处理区”的派生都必须读取
 * pending_decision，不能只读取 status。
 */

import type {
  AttentionSummary,
  AttentionLevel,
  ScheduleAttention,
  AggregationCompleteness,
} from '../core/types/state';
import type { TaskNode, ScheduleNode } from '../core/types/node';

/**
 * 响铃判定（唯一写法）
 *
 * status == paused AND pending_tool_id 非空 AND pending_decision == pending
 */
export function needsDecision(task: TaskNode): boolean {
  return (
    task.status === 'paused' &&
    Boolean(task.pending_tool_id || task.pending_decision) &&
    task.approval_state === 'pending'
  );
}

/**
 * 亮灯判定
 *
 * paused + approved/denied、failed 未确认、或诊断存在问题时亮灯
 */
export function needsAttention(
  task: TaskNode,
  recoveryHasIssue: boolean = false
): boolean {
  const approvedOrDenied =
    task.status === 'paused' &&
    (task.approval_state === 'approved' || task.approval_state === 'denied');
  const failedUnacknowledged = task.status === 'failed' && !task.acknowledged_failure;
  return approvedOrDenied || failedUnacknowledged || recoveryHasIssue;
}

/**
 * 已收敛判定
 *
 * succeeded、cancelled，或 failed 且已被用户确认
 */
export function isSettled(task: TaskNode): boolean {
  return (
    task.status === 'succeeded' ||
    task.status === 'cancelled' ||
    (task.status === 'failed' && Boolean(task.acknowledged_failure))
  );
}

/**
 * Schedule 聚合
 *
 * 保留子 Task 原始投影，按最高注意力级别选择 Schedule 环。
 * completeness 为 partial 时直接返回 unknown —— 不能用当前视口内
 * 恰好加载的几个 Task 冒充完整 Schedule 状态。
 */
export function aggregateSchedule(
  tasks: TaskNode[],
  completeness: AggregationCompleteness,
  recoveryFor: (task: TaskNode) => boolean = () => false
): ScheduleAttention {
  if (completeness === 'partial') return 'unknown';
  if (tasks.some(needsDecision)) return 'needs-decision';
  if (tasks.some((task) => needsAttention(task, recoveryFor(task)))) return 'attention';
  if (
    tasks.some(
      (task) =>
        task.status === 'running' ||
        task.status === 'created' ||
        (task.status === 'paused' &&
          (task.approval_state === 'approved' || task.approval_state === 'denied'))
    )
  ) {
    return 'active';
  }
  if (tasks.length === 0) return 'empty';
  if (tasks.every(isSettled)) return 'settled';
  return 'unknown';
}

/**
 * 单 Task 的注意力级别
 */
export function taskAttentionLevel(task: TaskNode): AttentionLevel {
  if (needsDecision(task)) return 'needs-decision';
  if (needsAttention(task)) return 'attention';
  if (isSettled(task)) return 'settled';
  return 'active';
}

/**
 * Schedule 聚合状态对应的注意力级别
 */
export function scheduleAttentionLevel(state: ScheduleAttention): AttentionLevel {
  switch (state) {
    case 'needs-decision':
      return 'needs-decision';
    case 'attention':
      return 'attention';
    case 'settled':
    case 'empty':
      return 'settled';
    case 'active':
    case 'unknown':
    default:
      return 'active';
  }
}

/**
 * 计算注意力汇总（HUD 使用）
 */
export function deriveAttentionSummary(
  tasks: TaskNode[],
  schedules: ScheduleNode[]
): AttentionSummary {
  const summary: AttentionSummary = {
    needsDecisionCount: 0,
    attentionCount: 0,
    activeCount: 0,
    settledCount: 0,
  };

  const tally = (level: AttentionLevel) => {
    switch (level) {
      case 'needs-decision':
        summary.needsDecisionCount++;
        break;
      case 'attention':
        summary.attentionCount++;
        break;
      case 'active':
        summary.activeCount++;
        break;
      case 'settled':
        summary.settledCount++;
        break;
    }
  };

  tasks.forEach((task) => tally(taskAttentionLevel(task)));
  schedules.forEach((schedule) => tally(scheduleAttentionLevel(schedule.aggregated_state)));

  return summary;
}

/**
 * 获取 Schedule 聚合状态标签
 */
export function getScheduleAggregateLabel(state: ScheduleAttention): string {
  switch (state) {
    case 'needs-decision':
      return '等我拍板';
    case 'attention':
      return '待检查';
    case 'active':
      return '处理中';
    case 'settled':
      return '已收敛';
    case 'empty':
      return '无近期实例';
    case 'unknown':
      return '等待对账';
  }
}
