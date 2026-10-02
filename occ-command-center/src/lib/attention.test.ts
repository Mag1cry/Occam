/**
 * 注意力派生测试
 *
 * 直接对应 state-ring.md 第 3 节“唯一响铃判定”和第 4 节 Schedule 聚合。
 */

import { describe, expect, it } from 'vitest';
import {
  needsDecision,
  needsAttention,
  isSettled,
  aggregateSchedule,
  deriveAttentionSummary,
} from './attention';
import { deriveStateRing } from './stateRing';
import { effectiveLOD } from './lod';
import type { TaskNode, ScheduleNode } from '../core/types/node';

const task = (over: Partial<TaskNode>): TaskNode => ({
  id: 't',
  type: 'task',
  label: 't',
  x: 0,
  y: 0,
  status: 'running',
  ...over,
});

describe('响铃判定', () => {
  it('只有 paused + pending_decision + pending_tool_id 才响铃', () => {
    expect(
      needsDecision(
        task({
          status: 'paused',
          approval_state: 'pending',
          pending_decision: {
            decision_id: 'd',
            description: 'x',
            created_at: '2025-01-01T00:00:00Z',
          },
        })
      )
    ).toBe(true);
  });

  it('paused + pending 但缺少 pending_decision 和 pending_tool_id 时不响铃', () => {
    expect(needsDecision(task({ status: 'paused', approval_state: 'pending' }))).toBe(false);
  });

  it('仅 paused 不响铃（禁止只读 status 的写法）', () => {
    expect(needsDecision(task({ status: 'paused' }))).toBe(false);
  });

  it('仅 pending_tool_id 不响铃', () => {
    expect(needsDecision(task({ status: 'running', pending_tool_id: 'tool' }))).toBe(false);
  });

  it('已批准/已拒绝不响铃，但亮灯', () => {
    const approved = task({ status: 'paused', approval_state: 'approved' });
    const denied = task({ status: 'paused', approval_state: 'denied' });
    expect(needsDecision(approved)).toBe(false);
    expect(needsDecision(denied)).toBe(false);
    expect(needsAttention(approved)).toBe(true);
    expect(needsAttention(denied)).toBe(true);
  });
});

describe('亮灯与收敛判定', () => {
  it('失败未确认时亮灯且未收敛', () => {
    const failed = task({ status: 'failed', acknowledged_failure: false });
    expect(needsAttention(failed)).toBe(true);
    expect(isSettled(failed)).toBe(false);
  });

  it('失败已确认后收敛，但仍保留 failed 语义', () => {
    const failed = task({ status: 'failed', acknowledged_failure: true });
    expect(isSettled(failed)).toBe(true);
    expect(deriveStateRing({ status: 'failed', acknowledged_failure: true }).shape).toBe(
      'broken'
    );
  });

  it('succeeded 与 cancelled 都已收敛', () => {
    expect(isSettled(task({ status: 'succeeded' }))).toBe(true);
    expect(isSettled(task({ status: 'cancelled' }))).toBe(true);
  });
});

describe('Schedule 聚合', () => {
  it('数据不完整时返回 unknown，不冒充完整状态', () => {
    const settled = [task({ status: 'succeeded' })];
    expect(aggregateSchedule(settled, 'partial')).toBe('unknown');
  });

  it('优先级：响铃 > 亮灯 > 运行 > 已收敛', () => {
    const pending = task({
      status: 'paused',
      approval_state: 'pending',
      pending_tool_id: 'tool',
    });
    const failed = task({ status: 'failed', acknowledged_failure: false });
    const running = task({ status: 'running' });
    const settled = task({ status: 'succeeded' });

    expect(aggregateSchedule([settled, running, failed, pending], 'complete')).toBe(
      'needs-decision'
    );
    expect(aggregateSchedule([settled, running, failed], 'complete')).toBe('attention');
    expect(aggregateSchedule([settled, running], 'complete')).toBe('active');
    expect(aggregateSchedule([settled], 'complete')).toBe('settled');
  });

  it('无子 Task 时为 empty', () => {
    expect(aggregateSchedule([], 'complete')).toBe('empty');
  });
});

describe('状态环几何', () => {
  it('每种状态都有非颜色信号（形状或文字）', () => {
    expect(deriveStateRing({ status: 'running' }).shape).toBe('closed');
    expect(deriveStateRing({ status: 'paused' }).shape).toBe('gap');
    expect(deriveStateRing({ status: 'failed' }).shape).toBe('broken');
    expect(deriveStateRing({ status: 'cancelled' }).shape).toBe('collapsed');
  });

  it('paused 的三种含义给出不同文案', () => {
    expect(deriveStateRing({ status: 'paused', approval_state: 'pending' }).label).toBe(
      '等待拍板'
    );
    expect(deriveStateRing({ status: 'paused', approval_state: 'approved' }).label).toBe(
      '已批准'
    );
    expect(deriveStateRing({ status: 'paused', approval_state: 'denied' }).label).toBe(
      '已拒绝'
    );
  });

  it('已确认失败不等于成功：仍是断裂环', () => {
    const ring = deriveStateRing({ status: 'failed', acknowledged_failure: true });
    expect(ring.shape).toBe('broken');
    expect(isSettled(task({ status: 'failed', acknowledged_failure: true }))).toBe(true);
  });
});

describe('LOD 可读性保底', () => {
  it('选中节点永远提升到可读层级', () => {
    expect(effectiveLOD({ zoom: 0.18, selected: true })).toBe('near');
    expect(effectiveLOD({ zoom: 0.18, selected: false })).toBe('far');
  });

  it('待拍板/亮灯节点不会因为缩小而失去文字', () => {
    expect(effectiveLOD({ zoom: 0.2, attention: true })).toBe('mid');
  });
});

describe('注意力汇总', () => {
  it('统计各注意力级别数量', () => {
    const tasks = [
      task({
        status: 'paused',
        approval_state: 'pending',
        pending_tool_id: 'x',
      }),
      task({ status: 'failed', acknowledged_failure: false }),
      task({ status: 'running' }),
      task({ status: 'succeeded' }),
    ];
    const summary = deriveAttentionSummary(tasks, []);
    expect(summary.needsDecisionCount).toBe(1);
    expect(summary.attentionCount).toBe(1);
    expect(summary.activeCount).toBe(1);
    expect(summary.settledCount).toBe(1);
  });

  it('Schedule 聚合计入响应级别', () => {
    const schedules: ScheduleNode[] = [
      {
        id: 's',
        type: 'schedule',
        label: 's',
        x: 0,
        y: 0,
        aggregated_state: 'needs-decision',
        child_task_count: 1,
        enabled: true,
      },
    ];
    expect(deriveAttentionSummary([], schedules).needsDecisionCount).toBe(1);
  });
});
