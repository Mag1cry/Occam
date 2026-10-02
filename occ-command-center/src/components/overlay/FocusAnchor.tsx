/**
 * FocusAnchor
 *
 * 左上角焦点锚点：不是关闭按钮，而是焦点对象的实体化返回锚点。
 * 它记住“我从哪个对象进入这里”。
 *
 * 返回、Esc、浏览器 Back、Pad 返回和本锚点统一执行 SceneStack.pop()。
 */

import { useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ANCHOR_POSITION, ANCHOR_SIZE } from '../../lib/flip';
import { useSceneStore } from '../../store/sceneStore';
import { useFocusLeap } from '../../hooks/useFocusLeap';

export function FocusAnchor() {
  const currentScene = useSceneStore((state) => state.currentScene);
  const stack = useSceneStore((state) => state.stack);
  const { exitScene, isFlying } = useFocusLeap();

  const frame = stack[stack.length - 1];
  const isChildScene = currentScene !== 'world';

  /**
   * 焦点身份直接用进入时记下的那一份
   *
   * 这里**不再反查业务投影**：源节点在进入时就在手上，名字、状态和颜色
   * 当时已经算好入栈（`SceneFrame.focusLabel` / `focusStateText` /
   * `source.color`）。反查要多一次查找，而且一旦数据源换成后端快照、
   * 或者对象在进入后被改过，锚点就会显示不出东西或显示成另一个状态——
   * 那正是「锚点说的是它，界面说的是别的」。
   */
  const label = frame?.focusLabel ?? frame?.focusId ?? '返回';
  const stateText = frame?.focusStateText ?? '返回上一场景';
  const color = frame?.source?.color ?? '#2dd4a7';

  // 辅助返回方式：Esc
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isChildScene && !isFlying) {
        exitScene();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isChildScene, isFlying, exitScene]);

  // 浏览器返回
  useEffect(() => {
    if (!isChildScene) return;

    window.history.pushState({ occScene: currentScene }, '');
    const handlePopState = () => {
      if (!isFlying) exitScene();
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isChildScene, currentScene, isFlying, exitScene]);

  // 只在子场景中显示
  if (!isChildScene) return null;

  return (
    <button
      type="button"
      onClick={() => !isFlying && exitScene()}
      disabled={isFlying}
      className="fixed z-50 rounded-xl glass-strong flex items-center gap-2.5 px-3 text-left transition-smooth hover:border-occ-accent/40 disabled:opacity-50"
      style={{
        left: ANCHOR_POSITION.x,
        top: ANCHOR_POSITION.y,
        width: ANCHOR_SIZE.width,
        height: ANCHOR_SIZE.height,
      }}
      aria-label="返回上一场景"
    >
      <ArrowLeft className="w-4 h-4 text-slate-400 shrink-0" />
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ background: color, boxShadow: `0 0 8px ${color}aa` }}
      />
      <span className="flex flex-col min-w-0">
        <span className="text-[13px] font-semibold text-slate-100 truncate">
          {label}
        </span>
        <span className="num text-[11px] text-slate-500 truncate">
          {stateText}
        </span>
      </span>
    </button>
  );
}
