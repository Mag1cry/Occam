/**
 * 测试环境准备
 *
 * jsdom 没有 ResizeObserver / matchMedia；React Flow 和转场动画都会用到。
 *
 * 另外把网络边界换成离线夹具快照。应用只认网关快照，没有 mock 兜底分支，
 * 所以提供一份快照是让界面渲染出来的前提；换来的好处是测试跑在**真实链路**上
 * （快照 → 投影 → 渲染 → 交互），而不是一条只存在于测试里的旁路。
 */

import { vi } from 'vitest';
import { buildMockSnapshot } from '../mock/snapshot';

vi.mock('../api/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/gateway')>();
  const snapshot = buildMockSnapshot();
  return {
    ...actual,
    // 用 vi.fn 包一层：单个用例可以用 mockRejectedValueOnce 模拟后端不可达
    getGatewaySnapshot: vi.fn(async () => snapshot),
    // 不建立真 SSE：测试靠显式 load() 驱动重读。
    // 但要如实上报流状态——否则 HUD 会因为没有「实时」而让每条用例都像断线
    subscribeGatewayEvents: vi.fn((_onEvent: () => void, onStreamState?: (state: string) => void) => {
      onStreamState?.('open');
      return () => {};
    }),
    sendGatewayCommand: vi.fn(async () => ({ request_id: 'test', accepted: true, data: {} })),
    // 默认没有审计投影：与「执行者不提供审计」时的真实行为一致。
    // 需要审计的用例用 `auditFixture()` 显式提供。
    getAgentAudit: vi.fn(async () => ({ available: false, source: '', read_at: '', calls: [] })),
    getTaskResult: vi.fn(async () => null),
    /*
      引用解析的权威口默认「系统里没有这个引用」：这与「读不到」不同——读不到不该
      改任何结论，而这里给的是一条**明确的答案**。用例需要别的答案时覆写它。
    */
    resolveObject: vi.fn(async (ref: string) => ({
      ref,
      object_ref: '',
      state: 'unknown' as const,
      kind: '',
      activation: '',
      reason: '系统里没有这个引用的任何记录',
    })),
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  ResizeObserverStub;

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

// React Flow 需要容器尺寸；jsdom 恒为 0，这里给出稳定值
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  value: 1200,
});
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  value: 800,
});
