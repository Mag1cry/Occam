/**
 * Layout Store
 *
 * 布局状态独立于业务状态：
 *
 *   type LayoutEntry = { sceneId, objectId, x, y }
 *
 * - 拖动只改变布局元数据，不改变业务对象；
 * - 增量刷新不能覆盖用户布局；
 * - 布局保存失败不能影响 Core 命令和对象状态。
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SceneId } from '../core/types/scene';

export interface NodePosition {
  x: number;
  y: number;
}

export interface Viewport {
  zoom: number;
  pan: { x: number; y: number };
}

export const DEFAULT_VIEWPORT: Viewport = { zoom: 1, pan: { x: 0, y: 0 } };

/** 布局键：sceneId + objectId，避免不同场景的同名对象互相覆盖 */
function layoutKey(sceneId: SceneId, objectId: string): string {
  return `${sceneId}:${objectId}`;
}

interface LayoutStoreState {
  /** 节点布局：sceneId + objectId → 坐标 */
  entries: Record<string, NodePosition>;

  /** 各场景的视口 */
  viewports: Partial<Record<SceneId, Viewport>>;

  setPosition: (sceneId: SceneId, objectId: string, position: NodePosition) => void;
  getPosition: (sceneId: SceneId, objectId: string) => NodePosition | undefined;
  /** 把这些对象在这张画布上的位置忘掉（对象已经不在系统里了） */
  forget: (sceneId: SceneId, objectIds: string[]) => void;
  setViewport: (sceneId: SceneId, viewport: Viewport) => void;
  getViewport: (sceneId: SceneId) => Viewport;
  resetLayout: () => void;
}

export const useLayoutStore = create<LayoutStoreState>()(
  persist(
    (set, get) => ({
      entries: {},
      viewports: {},

      setPosition: (sceneId, objectId, position) => {
        set((state) => ({
          entries: {
            ...state.entries,
            [layoutKey(sceneId, objectId)]: position,
          },
        }));
      },

      getPosition: (sceneId, objectId) => get().entries[layoutKey(sceneId, objectId)],

      /**
       * 把这些对象在这张画布上的位置忘掉
       *
       * **对象没了，它那一格就该跟着走。** 不清的话这张表只增不减——删掉的 Task、
       * 拿掉的包，它们的位置会一直留在里面（还写进 localStorage），而那个 id
       * 永远不会再出现。
       *
       * 只在**对象真的没了**的时候调（由 `SpatialCanvas` 比对场景给的"存在哪些"），
       * 不是"这一屏没画"就清——收起来的那些还活着，它们的位置得留着。
       */
      forget: (sceneId, objectIds) => {
        set((state) => {
          const entries = { ...state.entries };
          let changed = false;
          for (const objectId of objectIds) {
            const key = layoutKey(sceneId, objectId);
            if (key in entries) {
              delete entries[key];
              changed = true;
            }
          }
          return changed ? { entries } : {};
        });
      },

      setViewport: (sceneId, viewport) => {
        set((state) => ({
          viewports: { ...state.viewports, [sceneId]: viewport },
        }));
      },

      getViewport: (sceneId) => get().viewports[sceneId] ?? DEFAULT_VIEWPORT,

      resetLayout: () => set({ entries: {}, viewports: {} }),
    }),
    { name: 'occ-layout-storage' }
  )
);
