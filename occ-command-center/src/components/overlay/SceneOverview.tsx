/**
 * SceneOverview
 *
 * 局部场景的概览栈：贴在左上角焦点锚点正下方。
 *
 * 为什么放在左上角而不是顶部中央：
 * - 顶部中央是 HUD 的位置（fixed 屏幕坐标的注意力 Overlay），
 *   局部场景的摘要放在那里会和 HUD 抢同一块屏幕，被挡住；
 * - 设计里「委托摘要」本来就由画布中央的对象节点承担
 *   （focus-leap.md 3.1 的焦点对象框），不需要再有一条固定条重复它；
 * - 左上角是焦点对象实体化返回锚点的位置，摘要紧贴锚点，
 *   「我在哪里、我在看什么、它现在什么状态」集中在一处。
 *
 * 画布仍然独占全屏：这里只是锚点下方的一小块 Overlay。
 */

import type { ReactNode } from 'react';
import { ANCHOR_POSITION, ANCHOR_SIZE } from '../../lib/flip';

/** 锚点下方留出一点间距，避免和锚点边框贴在一起 */
const STACK_GAP = 10;

/** 概览栈宽度；锚点是 ANCHOR_SIZE.width，这里略宽以便容纳事实文字 */
const STACK_WIDTH = 236;

export interface SceneOverlayStackProps {
  children: ReactNode;
}

/**
 * 左上角概览栈容器
 *
 * 位置由 ANCHOR_* 常量派生，保证与飞行终点对齐。
 */
export function SceneOverlayStack({ children }: SceneOverlayStackProps) {
  return (
    <div
      data-scene-overlay-stack
      className="fixed z-30 flex flex-col gap-2"
      style={{
        left: ANCHOR_POSITION.x,
        top: ANCHOR_POSITION.y + ANCHOR_SIZE.height + STACK_GAP,
        width: STACK_WIDTH,
      }}
    >
      {children}
    </div>
  );
}

/**
 * 一条事实
 *
 * 只承载真实字段；字段缺失时不传，不显示占位值。
 */
export interface SceneFact {
  label: string;
  value: string;
  /** 语气；颜色只作辅助，文字本身必须能独立表达 */
  tone?: 'default' | 'info' | 'warning' | 'danger' | 'success';
  /**
   * 值很长时**换行说全**，而不是截断
   *
   * 默认那一行是「标签在左、值在右、放不下就截断」——短事实一眼扫得完，那样最稳。
   * 但有一类值是一整句话（诊断就是），截断之后用户读到的是半句，而**半句诊断
   * 比没有诊断更糟**：它看着像说清了，其实把最关键的后半截吃掉了。
   */
  wrap?: boolean;
}

const TONE_CLASS: Record<NonNullable<SceneFact['tone']>, string> = {
  default: 'text-slate-200',
  info: 'text-occ-accent',
  warning: 'text-occ-warn',
  danger: 'text-occ-crit',
  success: 'text-occ-ok',
};

export interface SceneFactsProps {
  /** 分组标题（例如编排台名称）；缺省时不显示标题行 */
  title?: string;
  facts: SceneFact[];
  children?: ReactNode;
}

/**
 * 场景事实面板
 */
export function SceneFacts({ title, facts, children }: SceneFactsProps) {
  if (!title && facts.length === 0 && !children) return null;

  return (
    <div className="glass rounded-xl px-3 py-2.5">
      {title && (
        <div className="text-[12px] font-semibold text-slate-100 mb-2 truncate topline pb-1.5">
          {title}
        </div>
      )}

      <div className="space-y-1">
        {facts.map((fact) => (
          <div
            key={fact.label}
            className={fact.wrap
              ? 'block'
              : 'flex items-baseline justify-between gap-3'}
          >
            <span className="text-[11px] text-slate-500 shrink-0">{fact.label}</span>
            <span
              className={`text-[11px] ${fact.wrap ? 'block mt-0.5 break-words'
                : 'num text-right truncate'} ${TONE_CLASS[fact.tone ?? 'default']}`}
            >
              {fact.value}
            </span>
          </div>
        ))}
      </div>

      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}
