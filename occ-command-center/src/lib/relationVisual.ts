/**
 * 连线视觉派生
 *
 * 权威来源：visual-system.md 第 6 节
 * - 连线只表达真实关系；
 * - 默认低对比度，选中相关对象时提高对比度；
 * - 与焦点对象无关的线降低对比度，但不伪造断裂；
 * - 连线动画只表示已确认的事件反馈，不表示猜测中的执行进度。
 *
 * 只派生视觉，不改变关系本身：任何筛选都不删除关系，只是降低对比度。
 */

import type { Relation, RelationType } from '../core/types/node';

/** 关系类型 → 基础线条 */
const BASE_STYLE: Record<RelationType, { stroke: string; dash?: string }> = {
  // 组织关系（Schedule / Configuration 内部）
  has: { stroke: '#475569' },
  references: { stroke: '#475569' },
  declares: { stroke: '#475569' },
  // 供应商与它名下的配置同为组织关系
  provides: { stroke: '#475569' },
  // 行动关系（Task 与其引用）
  uses: { stroke: '#475569' },
  awaits: { stroke: '#ffb020', dash: '2 4' },
  // 产生关系：虚线，表示「外围产生 / 物化」，不表示执行进度
  creates: { stroke: '#334155', dash: '4 4' },
  materializes: { stroke: '#334155', dash: '4 4' },
  observed_by: { stroke: '#334155', dash: '2 4' },
};

/** 无选中时的线条样式 */
const FALLBACK_STYLE = { stroke: '#475569' };

export interface RelationEdgeStyle {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  /** 无关连线降低对比度；不改成断裂虚线，避免被读成关系不存在 */
  opacity: number;
}

export interface RelationLabelStyle {
  fill: string;
  fontSize: number;
  opacity: number;
}

/**
 * 是否与当前焦点对象相关
 */
export function isRelationFocused(relation: Relation, selectedNodeId: string | null): boolean {
  if (!selectedNodeId) return false;
  return relation.source === selectedNodeId || relation.target === selectedNodeId;
}

/**
 * 派生连线样式
 */
export function relationEdgeStyle(
  relation: Relation,
  selectedNodeId: string | null
): RelationEdgeStyle {
  const base = BASE_STYLE[relation.type] ?? FALLBACK_STYLE;
  const hasFocus = Boolean(selectedNodeId);
  const related = !hasFocus || isRelationFocused(relation, selectedNodeId);

  if (hasFocus && !related) {
    return {
      stroke: base.stroke,
      strokeWidth: 1.5,
      strokeDasharray: base.dash,
      opacity: 0.3,
    };
  }

  return {
    stroke: hasFocus ? '#94a3b8' : base.stroke,
    strokeWidth: hasFocus ? 2 : 1.5,
    strokeDasharray: base.dash,
    opacity: 1,
  };
}

/**
 * 派生连线标签样式
 */
export function relationLabelStyle(
  relation: Relation,
  selectedNodeId: string | null
): RelationLabelStyle {
  const hasFocus = Boolean(selectedNodeId);
  const emphasized = hasFocus && isRelationFocused(relation, selectedNodeId);

  return {
    fill: emphasized ? '#cbd5e1' : '#64748b',
    fontSize: 10,
    opacity: hasFocus && !emphasized ? 0.4 : 1,
  };
}
