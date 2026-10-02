/**
 * 事件流的存活与重连
 *
 * 这里要钉住的是「界面凭什么说自己实时」。原先的实现是
 * `onerror = () => source.close()`——它把浏览器**自带**的重连一起掐掉了，
 * 而且没有任何东西告诉界面流已经死了：后端一挂，数据永久冻结，HUD 还在
 * 绿灯脉冲说「实时」。
 *
 * 用 `importActual` 拿真实实现：`src/test/setup.ts` 把整个 `api/gateway`
 * 换成了桩，而这里要测的正是被换掉的那段。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const actual = await vi.importActual<typeof import('./gateway')>('./gateway');

/** 可控的 EventSource 替身：能手动触发 open / error */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = FakeEventSource.CONNECTING;
  closed = false;
  url: string;
  listeners = new Map<string, (() => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** 声明出来才能断言「真实实现没有用它」——它是条永远不会响的路径 */
  onmessage: ((...args: unknown[]) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(kind: string, handler: () => void) {
    const list = this.listeners.get(kind) ?? [];
    list.push(handler);
    this.listeners.set(kind, list);
  }

  /** 模拟后端推来一条事件（具名事件，新协议里不用了） */
  emit(kind: string) {
    for (const handler of this.listeners.get(kind) ?? []) handler();
  }

  /** 模拟后端推来一帧：**新的事实流每一帧都走 message**（没有具名事件） */
  message(data: string) {
    this.onmessage?.({ data } as MessageEvent<string>);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** 模拟后端把流接通 */
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  /** 模拟流断掉 */
  fail() {
    this.onerror?.();
  }
}

function latest() {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1];
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('subscribeGatewayEvents', () => {
  it('每一帧都算一条事件——新的事实流没有具名事件', () => {
    /*
      旧后端每一帧都带 `event:`，于是必须逐个列举事件类型去订阅（漏一种就永久不刷新）。
      新的事实流只说"谁脏了"：一帧一条 `data:`，走 `message` 那条路。
    */
    const onEvent = vi.fn();
    const unsubscribe = actual.subscribeGatewayEvents(onEvent);
    latest().open();

    latest().message('{"seq": 1, "subject_ref": "task:abc"}');

    expect(onEvent).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('心跳那一帧不算脏，不去重读快照', () => {
    // 心跳每 15 秒一次，如果它也算"该重读了"，前端就在无谓地重读整份快照
    const onEvent = vi.fn();
    const unsubscribe = actual.subscribeGatewayEvents(onEvent);
    latest().open();

    latest().message('{"heartbeat": true}');
    expect(onEvent).not.toHaveBeenCalled();

    latest().message('{"seq": 7, "subject_ref": "task:abc"}');
    expect(onEvent).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('取消订阅之后不再重连，也不留下未清的定时器', () => {
    const unsubscribe = actual.subscribeGatewayEvents(() => {});
    latest().fail();
    unsubscribe();

    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
