/**
 * 审计卡片的**尺寸、配色与状态表**——只有常量，没有组件。
 *
 * 和 `AuditCard.tsx` 分开住是给 Fast Refresh 让路：一个文件同时导出组件和常量时，
 * 改一下常量会让整个模块重挂载，而不是热替换。这条界线本来就是清楚的——
 * 「卡片长多大、状态什么颜色」是数据，「卡片怎么搭」是结构。
 *
 * 数值一个都没改，全部来自 `AgentCallCards` 原来那一份。
 */

/** 调用/消息的四种状态。颜色只作辅助，文字承担语义 */
export type CallStatus = 'success' | 'failed' | 'pending' | 'unknown';

/** 状态 → 那一小块的字、色、点 */
export const STATUS_STYLE: Record<
  CallStatus,
  { text: string; cls: string; dot: string; glyph: string; accent: string }
> = {
  success: {
    text: '成功',
    cls: 'border-occ-ok/40 bg-occ-ok/10 text-occ-ok',
    dot: '#2dd4a7',
    glyph: 'border-occ-ok/40 bg-occ-ok/10 text-occ-ok',
    accent: '#2dd4a7',
  },
  failed: {
    text: '失败',
    cls: 'border-occ-crit/40 bg-occ-crit/10 text-occ-crit',
    dot: '#ff5470',
    glyph: 'border-occ-crit/40 bg-occ-crit/10 text-occ-crit',
    accent: '#ff5470',
  },
  pending: {
    text: '等待响应',
    cls: 'border-occ-warn/40 bg-occ-warn/10 text-occ-warn',
    dot: '#ffb020',
    glyph: 'border-occ-warn/40 bg-occ-warn/10 text-occ-warn',
    accent: '#ffb020',
  },
  unknown: {
    text: '未知',
    cls: 'border-white/15 bg-white/[0.04] text-slate-400',
    dot: '#64748b',
    glyph: 'border-white/15 bg-white/[0.04] text-slate-400',
    accent: '#64748b',
  },
};

/** 卡片宽度：够宽才读得下参数与结果，同时露出下一张的一角 */
export const CARD_WIDTH = 'w-[288px] sm:w-[304px]';

/**
 * 卡片高度
 *
 * 撑满可用高度但封顶：任务管理器的卡片是有形的，无限拉长会把
 * 「内容只有两行」变成一大片空气。超长内容由卡片内部滚动消化。
 */
export const CARD_HEIGHT = 'flex-1 min-h-0 max-h-[440px]';

/** 翻页容器：横向吸附滚动，一次停在下一张上 */
export const CARD_DECK_CLASS =
  'flex gap-4 h-full overflow-x-auto overflow-y-hidden scroll-px-6 pb-1 snap-x snap-mandatory';

export function hexAlpha(hex: string, alpha: number): string {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
