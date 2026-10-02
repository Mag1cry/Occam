/**
 * Core 控制事件夹具
 *
 * 形状与后端 `core.models.ControlEvent` 一致（`subject_ref` 是 `task:<id>`，
 * 事件名取自 `EVENT_TYPES`，时间是 `occurred_at`）。只用作测试夹具与
 * `VITE_DATA_SOURCE=mock` 的离线数据，不参与真实运行时的投影。
 */

import type { ControlEvent } from '../api/gateway';

/** 按 task_id 排列的 Core 控制事件链 */
export const mockCoreEvents: Record<string, ControlEvent[]> = {
  // running：创建后被调用了一次能力，还没有终态
  'task-001': [
    {
      event_id: 'evt-001-1',
      event_type: 'TASK_CREATED',
      subject_ref: 'task:task-001',
      task_id: 'task-001',
      occurred_at: '2025-01-26T09:00:00Z',
      payload: { summary: '分析用户反馈数据' },
    },
    {
      event_id: 'evt-001-2',
      event_type: 'FUNCTION_CALLED',
      subject_ref: 'task:task-001',
      task_id: 'task-001',
      tool_id: 'workspace.read_text',
      occurred_at: '2025-01-26T09:04:10Z',
      payload: {},
    },
  ],

  // paused + pending：停在等待拍板，最新一条是审批请求
  'task-002': [
    {
      event_id: 'evt-002-1',
      event_type: 'TASK_CREATED',
      subject_ref: 'task:task-002',
      task_id: 'task-002',
      occurred_at: '2025-01-26T10:00:00Z',
      payload: { summary: '部署生产环境' },
    },
    {
      event_id: 'evt-002-2',
      event_type: 'FUNCTION_APPROVAL_REQUESTED',
      subject_ref: 'task:task-002',
      task_id: 'task-002',
      tool_id: 'workspace.write_text',
      occurred_at: '2025-01-26T10:05:00Z',
      payload: {},
    },
  ],

  // failed：能力调用后失败
  'task-005': [
    {
      event_id: 'evt-005-1',
      event_type: 'TASK_CREATED',
      subject_ref: 'task:task-005',
      task_id: 'task-005',
      occurred_at: '2025-01-26T08:00:00Z',
      payload: { summary: '备份数据库' },
    },
    {
      event_id: 'evt-005-2',
      event_type: 'FUNCTION_CALLED',
      subject_ref: 'task:task-005',
      task_id: 'task-005',
      tool_id: 'workspace.list_dir',
      occurred_at: '2025-01-26T08:02:00Z',
      payload: {},
    },
    {
      event_id: 'evt-005-3',
      event_type: 'FAILED',
      subject_ref: 'task:task-005',
      task_id: 'task-005',
      occurred_at: '2025-01-26T10:00:15Z',
      payload: { error: 'Database connection timeout' },
    },
  ],
};

/**
 * 取某个 Task 的 Core 控制事件链（夹具读取口）
 *
 * 没有记录时返回空数组：不补造事件，也不从 Agent 侧资料拼一条出来。
 */
export function getCoreEventsForTask(taskId: string): ControlEvent[] {
  return mockCoreEvents[taskId] ?? [];
}
