/**
 * 节点表面派生
 *
 * 与 occ-web 的 `priorityMeta` 同一套配方：**视觉重量跟着状态走**。
 *
 * - 表面是「状态色的淡渐变 + 内高光 + 柔和投影」，不是一块死板的玻璃；
 * - 边框用状态色描出来，越需要你注意越实；
 * - 需要响应的节点额外加同色外发光；
 * - 宽度也随注意力变化（越要紧越宽），和 occ-web 一样。
 *
 * 颜色只作辅助：字形、形状、文字仍然承担语义（visual-system.md 第 4 节）。
 */

import type { AttentionLevel } from '../core/types/state';

export interface NodeSurface {
  /** 卡片背景：状态色淡渐变 */
  background: string;
  /** 卡片边框色 */
  border: string;
  /** 投影：内高光 + 深投影（+ 注意力外发光） */
  boxShadow: string;
  /** 卡片宽度 */
  width: number;
  /** 状态强调色，供子元素复用 */
  accent: string;
}

/** 三态 + 已收敛的强调色 */
const ACCENT: Record<AttentionLevel, string> = {
  'needs-decision': '#ffb020',
  attention: '#ff5470',
  active: '#2dd4a7',
  settled: '#64748b',
};

const INNER_HIGHLIGHT = 'inset 0 1px 0 rgba(255,255,255,0.05)';
const DEEP_SHADOW = '0 8px 24px -16px rgba(0,0,0,0.85)';

/** 宽度：越需要你注意越宽 */
const WIDTH: Record<AttentionLevel, number> = {
  'needs-decision': 208,
  attention: 200,
  active: 190,
  settled: 180,
};

/** 边框不透明度：越需要你注意越实 */
const BORDER_ALPHA: Record<AttentionLevel, number> = {
  'needs-decision': 0.6,
  attention: 0.85,
  active: 0.35,
  settled: 0.18,
};

/** 背景渐变起点不透明度 */
const BG_ALPHA: Record<AttentionLevel, number> = {
  'needs-decision': 0.14,
  attention: 0.18,
  active: 0.09,
  settled: 0.05,
};

/** 外发光：只有需要响应的节点才发光 */
const GLOW: Partial<Record<AttentionLevel, string>> = {
  'needs-decision': '0 0 30px -8px rgba(255,176,32,0.6)',
  attention: '0 0 34px -8px rgba(255,84,112,0.65)',
};

function rgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 派生节点表面
 *
 * `selected` 时不换成另一种配色，而是提高对比度并加一圈强调色——
 * 选中是「锁定」，不是「换了状态」。
 */
export function nodeSurface(
  attention: AttentionLevel,
  options: { selected?: boolean; dimmed?: boolean } = {}
): NodeSurface {
  const accent = ACCENT[attention];
  const border = rgba(accent, BORDER_ALPHA[attention]);
  const background = `linear-gradient(160deg, ${rgba(accent, BG_ALPHA[attention])}, rgba(255,255,255,0.015))`;

  const parts = [INNER_HIGHLIGHT, DEEP_SHADOW];
  const glow = GLOW[attention];
  if (glow) parts.push(glow);

  if (options.selected) {
    // 选中：一圈实心强调环 + 更高对比
    parts.push(`0 0 0 1px ${rgba(accent, 0.9)}`);
    parts.push('0 10px 30px -14px rgba(0,0,0,0.9)');
  }

  return {
    background,
    border: options.selected ? rgba(accent, 0.9) : border,
    boxShadow: parts.join(', '),
    width: WIDTH[attention],
    accent,
  };
}

/** 状态点的辉光：occ-web 的状态点都带自身颜色的光 */
export function dotGlow(color: string): string {
  return `0 0 8px ${rgba(color, 0.67)}`;
}

export { ACCENT as SURFACE_ACCENT };
