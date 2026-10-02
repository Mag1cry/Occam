/**
 * Transition Store
 *
 * 管理 Focus Leap 的飞行代理状态。
 *
 * 硬边界：
 * - FlyingProxy 不参与 SpatialCanvas 的 Node registry，不具有 nodeId
 *   或业务 Node data 的生命周期，也不参与 Projection、布局、选择和事件分发；
 * - 动画只表达 UI Scene State 变化，不表达业务成功；
 * - 动画位置永远不写回业务对象。
 */

import { create } from 'zustand';
import type { SceneFrame, SceneId } from '../core/types/scene';
import type { Rect } from '../lib/flip';

/**
 * 飞行代理
 * 独立于业务 Node 的临时转场视觉
 */
export interface FlyingProxyState {
  direction: 'enter' | 'exit';
  /** 源矩形（屏幕坐标） */
  sourceRect: Rect;
  /** 目标矩形（屏幕坐标，通常是左上角焦点锚点） */
  targetRect: Rect;
  /** 代理显示的文字（来自源节点视觉快照，不是业务数据） */
  label: string;
  /** 代理的强调色 */
  color: string;
  /** 进入动画期间需要暂时隐藏的源节点（业务坐标不变，只是不渲染第二个可交互节点） */
  sourceNodeId?: string;
}

interface TransitionStoreState {
  /** 飞行代理；为 null 表示没有进行中的飞行 */
  proxy: FlyingProxyState | null;

  /** 是否处于 measuring / flying 阶段（此期间冻结外层输入） */
  flying: boolean;

  /** 动画结束后要提交的场景切换；source 随帧一起入栈，供返回动画使用 */
  pending: {
    targetScene: SceneId;
    focusId: string;
    source: SceneFrame['source'];
    /** 焦点对象的状态文字，随帧入栈供锚点显示 */
    focusStateText?: string;
  } | null;

  /** 退出动画结束后要执行一次 SceneStack.pop() */
  pendingPop: boolean;

  /** 开始进入动画 */
  beginEnter: (params: {
    targetScene: SceneId;
    focusId: string;
    sourceRect: Rect;
    targetRect: Rect;
    label: string;
    color: string;
    sourceNodeId: string;
    stateText?: string;
  }) => void;

  /** 开始退出动画 */
  beginExit: (params: { sourceRect: Rect; targetRect: Rect; label: string; color: string }) => void;

  /** 动画结束：清除代理 */
  endFlight: () => void;

  /** 取走并清空 pending（由编排层调用） */
  consumePending: () => {
    targetScene: SceneId;
    focusId: string;
    source: SceneFrame['source'];
    focusStateText?: string;
  } | null;

  /** 取走并清空 pendingPop（由编排层调用） */
  consumePendingPop: () => boolean;
}

export const useTransitionStore = create<TransitionStoreState>((set, get) => ({
  proxy: null,
  flying: false,
  pending: null,
  pendingPop: false,

  beginEnter: ({ targetScene, focusId, sourceRect, targetRect, label, color, sourceNodeId, stateText }) => {
    set({
      proxy: { direction: 'enter', sourceRect, targetRect, label, color, sourceNodeId },
      flying: true,
      // 源矩形和源节点视觉快照随帧入栈：返回时按同一矩形飞回，不再重新推算
      pending: { targetScene, focusId, source: { rect: sourceRect, label, color }, focusStateText: stateText },
    });
  },

  beginExit: ({ sourceRect, targetRect, label, color }) => {
    set({
      proxy: { direction: 'exit', sourceRect, targetRect, label, color },
      flying: true,
      pending: null,
      pendingPop: true,
    });
  },

  endFlight: () => {
    set({ proxy: null, flying: false });
  },

  consumePending: () => {
    const pending = get().pending;
    if (pending) set({ pending: null });
    return pending;
  },

  consumePendingPop: () => {
    const pendingPop = get().pendingPop;
    if (pendingPop) set({ pendingPop: false });
    return pendingPop;
  },
}));
