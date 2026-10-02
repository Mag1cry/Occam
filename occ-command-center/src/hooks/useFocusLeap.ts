/**
 * useFocusLeap
 *
 * 编排 Focus Leap 的进入和返回。
 *
 * 状态机（focus-leap.md 第 7.2 节）：
 *   global → measuring-enter → flying-in → focus
 *          → measuring-exit → flying-out → global
 *
 * 任何 measuring 或 flying 状态都禁止：重复选择对象、提交命令、
 * 改变全局排序、生成第二个飞行节点、把动画位置写回 Task 数据。
 */

import { useCallback, useEffect } from 'react';
import { useSceneStore } from '../store/sceneStore';
import { useLayoutStore } from '../store/layoutStore';
import { useTransitionStore } from '../store/transitionStore';
import { useSelectionStore } from '../store/selectionStore';
import type { SceneId } from '../core/types/scene';
import {
  ANCHOR_RECT,
  computeNodeScreenRect,
  measureNodeById,
  type Rect,
} from '../lib/flip';

/**
 * 现读当前选中
 *
 * 不用渲染期的闭包值：进入场景和转场提交之间隔了一次动画，
 * 闭包里的选中可能已经过期，快照必须反映提交那一刻的真实选中。
 */
function currentSelection(): string | null {
  return useSelectionStore.getState().selectedNodeId;
}

/** 飞行兜底时长：略长于动画时长，超时按“动画失败”降级处理 */
const FLIGHT_TIMEOUT_MS = 900;

/**
 * 进入子场景
 */
export function useFocusLeap() {
  const { push, pop, stack, currentScene } = useSceneStore();
  const getPosition = useLayoutStore((state) => state.getPosition);
  const getViewport = useLayoutStore((state) => state.getViewport);
  const { beginEnter, beginExit, consumePending, consumePendingPop, flyState, endFlight } =
    useTransitionFlyBridge();

  /**
   * 动画失败降级
   *
   * onAnimationComplete 不保证一定会回调（组件卸载、浏览器不触发 rAF、
   * 测量异常等）。这里给出兜底：超时后强制结束飞行，保证导航不会卡住，
   * 也不影响任何数据和命令。
   */
  useEffect(() => {
    if (!flyState.flying) return;
    const timer = window.setTimeout(() => {
      endFlight();
    }, FLIGHT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [flyState.flying, endFlight]);

  /**
   * 由 World 画布调用：测量源节点并开始飞入
   */
  const enterScene = useCallback(
    (params: {
      nodeId: string;
      targetScene: SceneId;
      label: string;
      color: string;
      /** 源对象的状态文字；锚点靠它显示「从什么状态进来」 */
      stateText?: string;
    }) => {
      const { nodeId, targetScene, label, color, stateText } = params;

      const currentFrame = stack[stack.length - 1];
      const sourceRect = measureNodeById(nodeId);

      // 测量失败 → 降级：直接切换场景，不播放飞行动画
      if (!sourceRect) {
        push(targetScene, nodeId, {
          viewport: currentFrame.viewport,
          selection: { selectedNodeId: currentSelection() },
          focusLabel: label,
          focusStateText: stateText,
          // 没有矩形可以飞，但源对象的名字和颜色仍然要留下来
          source: { rect: null, label, color },
        });
        return;
      }

      beginEnter({
        targetScene,
        focusId: nodeId,
        sourceRect,
        targetRect: ANCHOR_RECT,
        label,
        color,
        sourceNodeId: nodeId,
        stateText,
      });
    },
    [stack, push, beginEnter]
  );

  /**
   * 返回上一场景：先飞回源节点位置，动画结束后 pop
   */
  const exitScene = useCallback(() => {
    if (stack.length <= 1) return;

    const currentFrame = stack[stack.length - 1];
    // 要回到的是上一层场景，不是写死的 world：从编排台进入的 Task 属于编排台
    const returnFrame = stack[stack.length - 2];
    const source = currentFrame.source;

    // 源画布尚未重新挂载，无法直接测量
    const fallbackRect: Rect | null = (() => {
      const nodePosition = getPosition(returnFrame.sceneId, currentFrame.focusId);
      if (!nodePosition) return null;
      return computeNodeScreenRect({
        viewport: getViewport(returnFrame.sceneId),
        nodePosition,
      });
    })();

    beginExit({
      sourceRect: ANCHOR_RECT,
      // 进入时测到的矩形优先：返回时源场景视口与进入前一致，节点就在原处
      targetRect: source?.rect ?? fallbackRect ?? ANCHOR_RECT,
      label: source?.label ?? currentFrame.focusId,
      color: source?.color ?? '#2dd4a7',
    });
  }, [stack, getPosition, getViewport, beginExit]);

  /**
   * 转场完成后的提交
   *
   * 进入：SceneStack.push()，外层帧被冻结在栈中，返回时按快照恢复
   * 返回：SceneStack.pop()
   */
  useEffect(() => {
    if (flyState.flying) return;

    const pendingPop = consumePendingPop();
    if (pendingPop) {
      pop();
      return;
    }

    const pending = consumePending();
    if (pending) {
      const currentFrame = stack[stack.length - 1];
      push(pending.targetScene, pending.focusId, {
        viewport: currentFrame.viewport,
        selection: { selectedNodeId: currentSelection() },
        focusLabel: pending.source?.label,
        focusStateText: pending.focusStateText,
        source: pending.source,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyState.flying]);

  return { enterScene, exitScene, isFlying: flyState.flying, currentScene };
}

/**
 * 从转场 store 中取出编排所需的切片
 */
function useTransitionFlyBridge() {
  const flying = useTransitionStore((state) => state.flying);
  const beginEnter = useTransitionStore((state) => state.beginEnter);
  const beginExit = useTransitionStore((state) => state.beginExit);
  const consumePending = useTransitionStore((state) => state.consumePending);
  const consumePendingPop = useTransitionStore((state) => state.consumePendingPop);
  const endFlight = useTransitionStore((state) => state.endFlight);

  return {
    beginEnter,
    beginExit,
    consumePending,
    consumePendingPop,
    endFlight,
    flyState: { flying },
  };
}
