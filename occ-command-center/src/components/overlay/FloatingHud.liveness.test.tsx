/**
 * HUD 的连接状态必须说真话
 *
 * 这是整屏最容易说假话的地方：数据冻住了、事件流断了，而 HUD 还在绿灯脉冲
 * 说「实时」。判据是**两件事同时成立**——最近一次读快照成功，且事件流还开着。
 * 只读快照状态的话，命令成功后调一次 `load()` 就会把「已断开」抹掉。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FloatingHud } from './FloatingHud';
import { useGatewayStore, isSnapshotLive } from '../../store/gatewayStore';
import { buildMockSnapshot } from '../../mock/snapshot';

const SNAPSHOT = buildMockSnapshot();

beforeEach(() => {
  useGatewayStore.setState({
    snapshot: SNAPSHOT,
    status: 'ready',
    stream: 'open',
    lastReadyAt: '2026-09-24T02:35:00.000Z',
    error: null,
  });
});

describe('isSnapshotLive', () => {
  it('只有「读到了」而且「流还开着」才算实时', () => {
    expect(isSnapshotLive('ready', 'open')).toBe(true);
    // 读到了但流断了：数据是旧的，不能说实时
    expect(isSnapshotLive('ready', 'retrying')).toBe(false);
    expect(isSnapshotLive('ready', 'connecting')).toBe(false);
    // 流开着但最近一次读失败：快照不是现在的
    expect(isSnapshotLive('error', 'open')).toBe(false);
    expect(isSnapshotLive('loading', 'open')).toBe(false);
  });
});

describe('HUD 连接标签', () => {
  it('流开着且读到了 → 实时', () => {
    render(<FloatingHud />);
    expect(screen.getByText('实时')).toBeTruthy();
  });

  it('流断了 → 说断开，并交代数据截至几点', () => {
    useGatewayStore.setState({ stream: 'retrying' });
    render(<FloatingHud />);

    expect(screen.queryByText('实时')).toBeNull();
    // 只说「已断开」等于没说：看不出这份数据有多旧
    expect(screen.getByText(/已断开 · 数据截至 \d{2}:\d{2}/)).toBeTruthy();
  });

  it('命令成功后重读快照，也抹不掉「已断开」', () => {
    useGatewayStore.setState({ stream: 'retrying' });
    // 四个场景在命令成功后都会走这一步
    useGatewayStore.setState({ status: 'ready', lastReadyAt: '2026-09-24T03:00:00.000Z' });
    render(<FloatingHud />);

    expect(screen.queryByText('实时')).toBeNull();
    expect(screen.getByText(/已断开 · 数据截至 \d{2}:\d{2}/)).toBeTruthy();
  });

  it('还没有过任何快照时才说连接中', () => {
    useGatewayStore.setState({ snapshot: null, status: 'loading', stream: 'connecting', lastReadyAt: null });
    render(<FloatingHud />);
    expect(screen.getByText('连接中')).toBeTruthy();
  });
});
