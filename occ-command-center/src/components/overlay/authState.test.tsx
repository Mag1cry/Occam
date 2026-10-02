/**
 * 「需要认证」必须和「后端不可达」分开说
 *
 * 两者都是「没拿到 Core 事实」，但该说的话完全不同：一个是「去拿凭据」，
 * 一个是「服务出问题了」。混成一种，用户就会去重启一个其实好好的后端。
 *
 * 后端从外网收到没有凭据的请求时回 401 + `WWW-Authenticate`，浏览器据此弹登录框；
 * 前端要做的是**别把这件事说成后端挂了**。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SceneStateLayer } from '../overlay/SceneStateLayer';
import { useGatewayStore } from '../../store/gatewayStore';
import { GatewayError, isUnauthorized } from '../../api/gateway';
import { buildMockSnapshot } from '../../mock/snapshot';

describe('isUnauthorized', () => {
  it('只认 401，别的一律不是认证问题', () => {
    expect(isUnauthorized(new GatewayError('需要认证', 401))).toBe(true);
    expect(isUnauthorized(new GatewayError('后端挂了', 503))).toBe(false);
    expect(isUnauthorized(new GatewayError('没找到', 404))).toBe(false);
    // 旧代码只抛 Error：没有状态码时不能猜它是认证失败
    expect(isUnauthorized(new Error('随便什么'))).toBe(false);
    expect(isUnauthorized(null)).toBe(false);
  });
});

describe('状态层文案', () => {
  it('401 说「需要认证」，并说清凭据在哪', () => {
    render(<SceneStateLayer status="unauthorized" error="外网访问需要认证" onRetry={() => {}} />);
    expect(screen.getByText('需要认证')).toBeTruthy();
    expect(screen.queryByText('后端不可达')).toBeNull();
    expect(screen.getByText(/access-token\.json/)).toBeTruthy();
  });

  it('真的不可达时仍然是「后端不可达」', () => {
    render(<SceneStateLayer status="error" error="连接被拒绝" onRetry={() => {}} />);
    expect(screen.getByText('后端不可达')).toBeTruthy();
    expect(screen.queryByText('需要认证')).toBeNull();
  });
});

describe('store 区分两种失败', () => {
  beforeEach(() => {
    useGatewayStore.setState({
      snapshot: buildMockSnapshot(),
      status: 'ready',
      stream: 'open',
      lastReadyAt: null,
      error: null,
    });
  });

  it('401 → unauthorized，503 → error', async () => {
    const { getGatewaySnapshot } = await import('../../api/gateway');
    const mocked = getGatewaySnapshot as unknown as { mockRejectedValueOnce: (v: unknown) => void };

    mocked.mockRejectedValueOnce(new GatewayError('需要认证', 401));
    await useGatewayStore.getState().load();
    expect(useGatewayStore.getState().status).toBe('unauthorized');

    mocked.mockRejectedValueOnce(new GatewayError('后端挂了', 503));
    await useGatewayStore.getState().load();
    expect(useGatewayStore.getState().status).toBe('error');
  });
});
