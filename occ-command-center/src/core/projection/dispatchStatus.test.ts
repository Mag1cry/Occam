/**
 * 派发状态：后端说什么就显示什么
 *
 * 派发记录里 `status` 是后端给的结论，`error` 是它给的原因。前端在这里
 * 只做映射，不做判断——把 `failed` 塌成「未知」等于把后端的结论丢掉，
 * 而「从来没派发过」和「派发了但失败了」在界面上本该是两件事。
 */

import { describe, expect, it } from 'vitest';
import { projectLiveScheduleScene } from './ScheduleProjection';
import type { GatewayDispatch, GatewaySchedule } from '../../api/gateway';
import type { ResourceNode } from '../types/node';

const SCHEDULE: GatewaySchedule = {
  schedule_id: 'daily',
  name: 'daily',
  cron: '0 9 * * *',
  timezone: 'UTC',
  enabled: true,
  executor_config_ref: 'uniapi:gpt-5',
};

function dispatch(over: Partial<GatewayDispatch>): GatewayDispatch {
  return {
    occurrence_key: 'daily:2026-09-24T09:00:00+00:00',
    schedule_id: 'daily',
    task_ids: [],
    status: 'dispatched',
    ...over,
  };
}

function occurrenceNodeOf(record: GatewayDispatch): ResourceNode | undefined {
  const model = projectLiveScheduleScene('daily', [SCHEDULE], [], [record]);
  return model.projection.nodes.find(
    (node): node is ResourceNode =>
      node.type === 'resource' && node.resource_kind === 'occurrence'
  );
}

describe('派发状态映射', () => {
  it('已派发', () => {
    expect(occurrenceNodeOf(dispatch({ status: 'dispatched' }))?.dispatch_status).toBe('dispatched');
  });

  it('失败就是失败，不塌成未知', () => {
    const node = occurrenceNodeOf(dispatch({
      status: 'failed',
      error: '执行者配置不存在: uniapi:gone',
    }));
    expect(node?.dispatch_status).toBe('failed');
    // 原因照原样带出来，前端不加工
    expect(node?.dispatch_error).toBe('执行者配置不存在: uniapi:gone');
  });

  it('后端没给过的状态才是未知', () => {
    const node = occurrenceNodeOf(dispatch({ status: 'something-new' }));
    expect(node?.dispatch_status).toBe('unknown');
    expect(node?.dispatch_error).toBeUndefined();
  });
});
