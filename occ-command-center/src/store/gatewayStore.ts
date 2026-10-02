import { create } from 'zustand';
import {
  getGatewaySnapshot,
  isUnauthorized,
  subscribeGatewayEvents,
  type GatewaySnapshot,
  type StreamState,
} from '../api/gateway';

/**
 * 快照状态
 *
 * - `loading`：还没有拿到过任何快照（首屏或重试中）；
 * - `ready`  ：最近一次读取成功；
 * - `error`  ：最近一次读取失败。
 *
 * `error` 不等于快照作废：已经拿到的快照仍然是已知事实，继续显示，
 * 由 HUD 标注连接已断。只有**从未拿到过快照**时才由 SceneRenderer
 * 渲染「后端不可达」状态层——不能让一次刷新失败把已经看到的世界抹掉，
 * 也不能让后端不可达时用原型数据顶上。
 *
 * **这个状态只说「最近一次读快照」，不说「连接还活着」。** 后者是 `stream`。
 * 合成一个字段会让两件事互相覆盖：命令成功后调一次 `load()` 就会写 `ready`，
 * 而那时事件流可能早就断了。
 */
export type SnapshotStatus = 'loading' | 'ready' | 'error' | 'unauthorized';

/** 是否还可以把当前快照当真：读取成功 **且** 事件流还开着 */
export function isSnapshotLive(status: SnapshotStatus, stream: StreamState): boolean {
  return status === 'ready' && stream === 'open';
}

interface GatewayStoreState {
  snapshot: GatewaySnapshot | null;
  status: SnapshotStatus;
  /** 事件流自身的状态。与 `status` 正交，互不覆盖 */
  stream: StreamState;
  /** 最近一次成功读到快照的时刻；没有过就是 null。断开时界面用它说「数据截至」 */
  lastReadyAt: string | null;
  error: string | null;
  load: () => Promise<void>;
  connect: () => () => void;
}

export const useGatewayStore = create<GatewayStoreState>((set) => ({
  snapshot: null,
  status: 'loading',
  stream: 'connecting',
  lastReadyAt: null,
  error: null,
  load: async () => {
    set((state) => ({ status: state.snapshot ? state.status : 'loading', error: null }));
    try {
      set({
        snapshot: await getGatewaySnapshot(),
        status: 'ready',
        lastReadyAt: new Date().toISOString(),
        error: null,
      });
    } catch (error) {
      set({
        // 「需要认证」和「后端不可达」是两种不同的事实，界面该说的话也不同：
        // 一个要你去拿凭据，一个是服务本身出问题了。混成一种，用户就会去重启
        // 一个其实好好的后端。
        status: isUnauthorized(error) ? 'unauthorized' : 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  connect: () =>
    subscribeGatewayEvents(
      () => { void useGatewayStore.getState().load(); },
      (stream) => set({ stream })
    ),
}));
