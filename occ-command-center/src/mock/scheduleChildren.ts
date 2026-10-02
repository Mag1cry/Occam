/**
 * Schedule 子场景 Mock 数据
 *
 * 权威关系（projection-contract.md 第 4 节，唯一权威定义）：
 *
 *   Schedule
 *     ├── has → Schedule Entry
 *     │          └── references → Task Definition
 *     └── creates → occurrence
 *                     └── materializes → Core Task
 *
 * Schedule Entry 是外围的绑定记录，不是 Core 原语；它的标题用引用串，
 * 人类可读的名称属于 Task Definition——否则一条 `Schedule ──has──>` 会指到
 * 一个看起来像 Task 的节点上。
 *
 * 子 Task 只在 Schedule ChildScene 内出现，不进入外层 Archive。
 */

import type { TaskNode } from '../core/types/node';
// occurrence 的类型属于投影层：夹具生产它，不拥有它
import type { ScheduleOccurrence } from '../core/types/projection';

/**
 * Task Definition：自动化外围定义目录里的条目
 *
 * 只在本场景内出现，不在外层 World 出现，也不独立成为 Scene。
 */
export interface TaskDefinition {
  definition_ref: string;
  label: string;
  /** 默认执行配置引用（字段存在时） */
  default_executor_config_ref?: string;
  /** 参数 schema 或用途摘要（字段存在时） */
  summary?: string;
}

/** Task Definition 目录 */
export const mockTaskDefinitions: TaskDefinition[] = [
  {
    definition_ref: 'def-db-backup',
    label: '数据库备份',
    default_executor_config_ref: 'config-004',
    summary: '完整备份生产数据库并校验分片',
  },
  {
    definition_ref: 'def-verify-backup',
    label: '校验备份完整性',
    default_executor_config_ref: 'config-004',
    summary: '校验最近一次备份的分片完整性',
  },
  {
    definition_ref: 'def-sync-users',
    label: '同步用户数据',
    default_executor_config_ref: 'config-001',
    summary: '从第三方 API 拉取并合并用户数据',
  },
  {
    definition_ref: 'def-daily-report',
    label: '生成日报',
    default_executor_config_ref: 'config-002',
    summary: '汇总当日运营指标并生成日报',
  },
  {
    definition_ref: 'def-clean-logs',
    label: '清理过期日志',
    default_executor_config_ref: 'config-003',
    summary: '清理 30 天前的日志文件',
  },
  {
    definition_ref: 'def-marketing-mail',
    label: '发送营销邮件',
    default_executor_config_ref: 'config-001',
    summary: '向订阅用户发送营销邮件',
  },
  {
    definition_ref: 'def-daily-sync',
    label: '每日数据同步',
    default_executor_config_ref: 'config-001',
    summary: '每天凌晨同步一次用户与订单数据',
  },
  // def-missing 故意不在此目录中：用于验证「引用缺失」不被猜测补齐
];

/** Schedule Entry：自动化外围的绑定记录，不是 Core 原语 */
export interface ScheduleEntry {
  entry_id: string;
  schedule_id: string;
  /** 引用的 Task Definition 标识；在目录中查不到时显示引用缺失 */
  definition_ref: string;
  /** 默认执行配置引用 */
  default_executor_config_ref?: string;
}

/** Schedule Entry 映射 */
export const mockScheduleEntries: Record<string, ScheduleEntry[]> = {
  'schedule-001': [
    {
      entry_id: 'entry-001-1',
      schedule_id: 'schedule-001',
      definition_ref: 'def-db-backup',
      default_executor_config_ref: 'config-004',
    },
    {
      entry_id: 'entry-001-2',
      schedule_id: 'schedule-001',
      definition_ref: 'def-verify-backup',
      default_executor_config_ref: 'config-004',
    },
  ],
  'schedule-002': [
    {
      entry_id: 'entry-002-1',
      schedule_id: 'schedule-002',
      definition_ref: 'def-sync-users',
      default_executor_config_ref: 'config-001',
    },
    {
      // 引用缺失：Definition 不在目录中，显示引用缺失，不猜测
      entry_id: 'entry-002-2',
      schedule_id: 'schedule-002',
      definition_ref: 'def-missing',
    },
  ],
  'schedule-003': [
    {
      entry_id: 'entry-003-1',
      schedule_id: 'schedule-003',
      definition_ref: 'def-daily-report',
      default_executor_config_ref: 'config-002',
    },
  ],
  'schedule-004': [
    {
      entry_id: 'entry-004-1',
      schedule_id: 'schedule-004',
      definition_ref: 'def-clean-logs',
      default_executor_config_ref: 'config-003',
    },
  ],
  'schedule-005': [
    {
      entry_id: 'entry-005-1',
      schedule_id: 'schedule-005',
      definition_ref: 'def-marketing-mail',
      default_executor_config_ref: 'config-001',
    },
  ],
  'schedule-006': [
    {
      entry_id: 'entry-006-1',
      schedule_id: 'schedule-006',
      definition_ref: 'def-daily-sync',
      default_executor_config_ref: 'config-001',
    },
  ],
};

/**
 * 「每天一次」的重复执行：最近 DAILY_RUNS 天
 *
 * 同一定义每天跑一次会产生多个 Core Task。这类历史在子图里默认折叠，
 * 只显示最近几次，其余按需展开——否则一个跑了三周的日程会把画布铺满。
 */
const DAILY_RUNS = 14;

/** 最新一次执行的触发时间（UTC） */
const DAILY_NEWEST = Date.UTC(2025, 0, 26, 2, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function buildDailyRuns(): {
  occurrences: ScheduleOccurrence[];
  tasks: TaskNode[];
} {
  const occurrences: ScheduleOccurrence[] = [];
  const tasks: TaskNode[] = [];

  for (let offset = 0; offset < DAILY_RUNS; offset += 1) {
    // seq：第几次执行，1 最早、DAILY_RUNS 最新
    const seq = DAILY_RUNS - offset;
    const padded = String(seq).padStart(2, '0');
    const taskId = `daily-task-${padded}`;

    occurrences.push({
      occurrence_id: `occ-006-${padded}`,
      schedule_id: 'schedule-006',
      task_id: taskId,
      entry_id: 'entry-006-1',
      triggered_at: new Date(DAILY_NEWEST - offset * DAY_MS).toISOString(),
      dispatch_status: 'dispatched',
    });

    // 最新一次仍在运行；上一次失败但已确认；更早的都已完成。
    //
    // 最早的那次失败且**没有人确认**——它落在默认折叠的历史里，
    // 因此 Schedule 聚合必须是 attention 而不是 active。
    // 这正是「不能用当前显示的几次冒充完整 Schedule 状态」的实例。
    const isOldest = offset === DAILY_RUNS - 1;
    const status = offset === 0 ? 'running' : offset === 1 ? 'failed' : isOldest ? 'failed' : 'succeeded';

    tasks.push({
      id: taskId,
      type: 'task',
      label: '每日数据同步',
      x: 0,
      y: 0,
      status,
      // 上一次失败已被确认；最早那次没有
      acknowledged_failure: status === 'failed' ? !isOldest : undefined,
      delegation_summary: `第 ${seq} 次每日同步`,
      duration: 420,
      executor_config_id: 'config-001',
    });
  }

  return { occurrences, tasks };
}

const dailyRuns = buildDailyRuns();

/** occurrence 映射 */
export const mockOccurrences: Record<string, ScheduleOccurrence[]> = {
  'schedule-001': [
    {
      occurrence_id: 'occ-001-1',
      schedule_id: 'schedule-001',
      task_id: 'sched-task-001',
      entry_id: 'entry-001-1',
      triggered_at: '2025-01-26T02:00:00Z',
      dispatch_status: 'dispatched',
    },
    {
      occurrence_id: 'occ-001-2',
      schedule_id: 'schedule-001',
      task_id: 'sched-task-002',
      entry_id: 'entry-001-2',
      triggered_at: '2025-01-26T02:05:00Z',
      dispatch_status: 'dispatched',
    },
  ],
  'schedule-002': [
    {
      occurrence_id: 'occ-002-1',
      schedule_id: 'schedule-002',
      task_id: 'sched-task-003',
      entry_id: 'entry-002-1',
      triggered_at: '2025-01-26T11:00:00Z',
      dispatch_status: 'dispatched',
    },
    {
      occurrence_id: 'occ-002-2',
      schedule_id: 'schedule-002',
      task_id: 'sched-task-004',
      entry_id: 'entry-002-1',
      triggered_at: null,
      dispatch_status: 'unknown',
    },
  ],
  'schedule-003': [
    {
      occurrence_id: 'occ-003-1',
      schedule_id: 'schedule-003',
      task_id: 'sched-task-005',
      entry_id: 'entry-003-1',
      triggered_at: '2025-01-26T09:00:00Z',
      dispatch_status: 'dispatched',
    },
  ],
  'schedule-004': [
    {
      occurrence_id: 'occ-004-1',
      schedule_id: 'schedule-004',
      task_id: 'sched-task-006',
      entry_id: 'entry-004-1',
      triggered_at: '2025-01-19T03:00:00Z',
      dispatch_status: 'dispatched',
    },
  ],
  'schedule-005': [
    {
      occurrence_id: 'occ-005-1',
      schedule_id: 'schedule-005',
      task_id: 'sched-task-007',
      entry_id: 'entry-005-1',
      triggered_at: '2025-01-20T10:00:00Z',
      dispatch_status: 'dispatched',
    },
  ],
  'schedule-006': dailyRuns.occurrences,
};

/** 子 Task：只属于 Schedule 内部世界 */
export const mockScheduleChildTasks: TaskNode[] = [
  // schedule-001（needs-decision）：有子 Task 等待拍板
  {
    id: 'sched-task-001',
    type: 'task',
    label: '数据库备份',
    x: 0,
    y: 0,
    status: 'succeeded',
    delegation_summary: '完成生产数据库完整备份',
    duration: 1800,
    executor_config_id: 'config-004',
  },
  {
    id: 'sched-task-002',
    type: 'task',
    label: '校验备份完整性',
    x: 0,
    y: 0,
    status: 'paused',
    approval_state: 'pending',
    pending_decision: {
      decision_id: 'decision-002',
      description: '备份校验发现 2 个分片不完整，需要决定是否重跑',
      created_at: '2025-01-26T02:10:00Z',
    },
    delegation_summary: '校验备份分片完整性',
    executor_config_id: 'config-004',
  },

  // schedule-002（attention）：有子 Task 失败
  {
    id: 'sched-task-003',
    type: 'task',
    label: '同步用户数据',
    x: 0,
    y: 0,
    status: 'failed',
    acknowledged_failure: false,
    delegation_summary: '从第三方 API 同步用户数据',
    duration: 240,
    executor_config_id: 'config-001',
  },
  {
    id: 'sched-task-004',
    type: 'task',
    label: '同步用户数据（重试）',
    x: 0,
    y: 0,
    status: 'paused',
    approval_state: 'approved',
    delegation_summary: '重试同步用户数据',
    executor_config_id: 'config-001',
  },

  // schedule-003（active）：有子 Task 运行中
  {
    id: 'sched-task-005',
    type: 'task',
    label: '生成日报',
    x: 0,
    y: 0,
    status: 'running',
    delegation_summary: '生成当日运营日报',
    duration: 600,
    executor_config_id: 'config-002',
  },

  // schedule-004（settled）：子 Task 全部收敛
  {
    id: 'sched-task-006',
    type: 'task',
    label: '清理过期日志',
    x: 0,
    y: 0,
    status: 'succeeded',
    delegation_summary: '清理 30 天前日志',
    duration: 900,
    executor_config_id: 'config-003',
  },

  // schedule-005（needs-decision，已停用）
  {
    id: 'sched-task-007',
    type: 'task',
    label: '发送营销邮件',
    x: 0,
    y: 0,
    status: 'paused',
    approval_state: 'pending',
    pending_decision: {
      decision_id: 'decision-003',
      description: '邮件模板变更需要确认',
      created_at: '2025-01-20T10:05:00Z',
    },
    delegation_summary: '向订阅用户发送营销邮件',
    executor_config_id: 'config-001',
  },

  // schedule-006（active）：每天一次的重复执行，历史较长
  ...dailyRuns.tasks,
];

/** 重复执行的次数，供场景默认折叠使用 */
export const DAILY_RUN_COUNT = DAILY_RUNS;
