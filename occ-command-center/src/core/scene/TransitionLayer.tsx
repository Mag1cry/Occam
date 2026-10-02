/**
 * TransitionLayer
 *
 * 只负责渲染 FlyingProxy。它是临时转场视觉，不参与场景投影、
 * 布局、选择和事件分发。
 *
 * 流程（rendering-architecture.md 第 3 节）：
 *   真实 Node → getBoundingClientRect()
 *   → 暂时隐藏源 Node
 *   → FlyingProxy 飞向焦点锚点
 *   → 切换 SceneStack
 *   → FlyingProxy 消失
 *
 * 动画失败或测量失败时降级为淡入淡出；prefers-reduced-motion 只淡入淡出。
 */

import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { useTransitionStore } from '../../store/transitionStore';

/** 与 flip.ts 中的 ANCHOR_SIZE 保持一致 */
const FALLBACK_SIZE = { width: 208, height: 56 };

export function TransitionLayer() {
  const proxy = useTransitionStore((state) => state.proxy);
  const endFlight = useTransitionStore((state) => state.endFlight);
  const reduceMotion = useReducedMotion();

  // 进入动画期间暂时隐藏源节点：飞行中只保留一个可交互实例
  useEffect(() => {
    if (!proxy || proxy.direction !== 'enter' || !proxy.sourceNodeId) return;

    const escaped = proxy.sourceNodeId.replace(/"/g, '\\"');
    const element = document.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${escaped}"]`
    );
    if (!element) return;

    const previous = element.style.visibility;
    element.style.visibility = 'hidden';
    return () => {
      element.style.visibility = previous;
    };
  }, [proxy]);

  /**
   * 用 transform 实现 FLIP：代理按目标尺寸布局，
   * 通过 scale 从源尺寸过渡到目标尺寸，避免逐帧触发布局。
   */
  const frames = useMemo(() => {
    if (!proxy) return null;
    const { sourceRect, targetRect } = proxy;

    const targetWidth = targetRect.width || FALLBACK_SIZE.width;
    const targetHeight = targetRect.height || FALLBACK_SIZE.height;

    // 测量失败（宽高为 0）→ 降级为淡入淡出
    const degraded = targetWidth <= 0 || targetHeight <= 0;

    return {
      degraded,
      targetWidth,
      targetHeight,
      from: {
        x: sourceRect.x,
        y: sourceRect.y,
        scaleX: degraded ? 1 : sourceRect.width / targetWidth,
        scaleY: degraded ? 1 : sourceRect.height / targetHeight,
        opacity: degraded ? 0 : 0.85,
      },
      to: {
        x: targetRect.x,
        y: targetRect.y,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
      },
    };
  }, [proxy]);

  if (!proxy || !frames) return null;

  /**
   * prefers-reduced-motion：只淡入淡出，不做任何位移或缩放
   */
  const from = reduceMotion
    ? { x: frames.to.x, y: frames.to.y, scaleX: 1, scaleY: 1, opacity: 0 }
    : frames.from;

  return createPortal(
    <motion.div
      // 代理不参与事件分发，也不具有 nodeId 或业务 Node data 的生命周期
      aria-hidden
      className="fixed left-0 top-0 z-[60] pointer-events-none rounded-lg glass-strong flex items-center px-4"
      style={{
        width: frames.targetWidth,
        height: frames.targetHeight,
        borderColor: proxy.color,
        boxShadow: `0 0 0 1px ${proxy.color}55`,
        transformOrigin: 'top left',
      }}
      initial={{
        x: from.x,
        y: from.y,
        scaleX: from.scaleX,
        scaleY: from.scaleY,
        opacity: from.opacity,
      }}
      animate={{
        x: frames.to.x,
        y: frames.to.y,
        scaleX: frames.to.scaleX,
        scaleY: frames.to.scaleY,
        opacity: frames.to.opacity,
      }}
      transition={{
        duration: reduceMotion ? 0.2 : 0.42,
        ease: [0.4, 0, 0.2, 1],
      }}
      onAnimationComplete={endFlight}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ background: proxy.color, boxShadow: `0 0 8px ${proxy.color}aa` }}
        />
        <span className="text-sm text-white truncate">{proxy.label}</span>
      </div>
    </motion.div>,
    document.body
  );
}
