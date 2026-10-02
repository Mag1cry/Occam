/**
 * Scene Store
 *
 * 使用 Zustand 管理场景栈状态
 */

import { create } from 'zustand';
import type { SceneId, SceneFrame, SceneStack } from '../core/types/scene';

interface SceneStoreState extends SceneStack {
  /**
   * 进入子场景
   */
  push: (sceneId: SceneId, focusId: string, snapshot: Omit<SceneFrame, 'sceneId' | 'focusId'>) => void;

  /**
   * 返回上一场景
   */
  pop: () => SceneFrame | null;

  /**
   * 开始转场
   */
  startTransition: () => void;

  /**
   * 结束转场
   */
  endTransition: () => void;
}

export const useSceneStore = create<SceneStoreState>((set, get) => ({
  // 初始状态：World Scene
  stack: [
    {
      sceneId: 'world',
      focusId: '',
      viewport: { zoom: 1, pan: { x: 0, y: 0 } },
      selection: { selectedNodeId: null },
    },
  ],
  currentScene: 'world',
  isTransitioning: false,

  push: (sceneId, focusId, snapshot) => {
    const newFrame: SceneFrame = {
      sceneId,
      focusId,
      ...snapshot,
    };

    set((state) => ({
      stack: [...state.stack, newFrame],
      currentScene: sceneId,
    }));
  },

  pop: () => {
    const state = get();
    if (state.stack.length <= 1) {
      // 已经是 World Scene，不能再返回
      return null;
    }

    const newStack = state.stack.slice(0, -1);
    const previousFrame = newStack[newStack.length - 1];

    set({
      stack: newStack,
      currentScene: previousFrame.sceneId,
    });

    return previousFrame;
  },

  startTransition: () => {
    set({ isTransitioning: true });
  },

  endTransition: () => {
    set({ isTransitioning: false });
  },
}));
