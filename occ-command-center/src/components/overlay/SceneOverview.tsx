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
import { ANCHOR_POSITION } from '../../lib/flip';
import { BOTTOM_BAND, BOTTOM_PANEL_MIN } from '../../lib/overlayLayout';
import { useAnchorRect } from '../../hooks/useViewportFlags';
import { useScrollFade } from '../../hooks/useScrollFade';

/** 锚点下方留出一点间距，避免和锚点边框贴在一起 */
const STACK_GAP = 10;

/**
 * 概览栈宽度：**跟着内容走，上限跟着设备走**
 *
 * 写死 236px 的时候，配置舱那张卡实际只需要 110px——**中间 98px 是纯空白**，
 * 而行是 `justify-between`（标签钉左、值钉右），所以那段空白怎么调宽度都消不掉，
 * 只有让容器贴住内容才行。
 *
 * 三条一起满足：
 * - `w-max`（max-content）→ 容器等于**最宽那张卡的内容宽**，空白消失；
 * - 卡片在 `flex-col` 里默认 `stretch` → 两张卡共享这个宽度，**两端都对齐**，
 *   不会一张宽一张窄；
 * - `max-w-[min(236px,46vw)]` → 上限跟着设备走：桌面 236，窄屏按比例收，
 *   免得一条长值（诊断、长 task id）把卡片撑穿。
 *
 * 上限在实测里只有极窄时才咬得住：编排台那张卡内容要 179px（`映射` 那一行最长），
 * 配置舱只要 110px。
 *
 * **已知的落差**：上面那块锚点牌固定 208px（它是飞行终点，尺寸写在 `flip.ts` 里，
 * 不能跟着内容变），所以卡片会比它窄——两块左对齐、右边缘不齐。
 */
const STACK_WIDTH_CLASS = 'w-max max-w-[min(236px,46vw)]';

export interface SceneOverlayStackProps {
  children: ReactNode;
}

/**
 * 左上角概览栈容器
 *
 * 位置由 ANCHOR_* 常量派生，保证与飞行终点对齐。
 */
export function SceneOverlayStack({ children }: SceneOverlayStackProps) {
  const anchor = useAnchorRect();
  const [scrollref, scroll类] = useScrollFade<HTMLDivElement>();
  const top = anchor.y + anchor.height + STACK_GAP;
  /*
    **封顶，让它永远够不到左下角那个面板。** 矮视口上这是硬约束，不是美观问题：
    360 高时"锚点 + 栈"和"分区面板 + 底带"加起来要 513px，两样全尺寸摆不下
    （实测重叠 144px，`weather.daily` 整张卡被压住）。到点就自己滚，
    而不是压到别人身上。
  */
  const maxHeight = `calc(100vh - ${top + BOTTOM_BAND + BOTTOM_PANEL_MIN}px)`;

  return (
    <div
      data-scene-overlay-stack
      ref={scrollref}
      className={`fixed z-30 flex flex-col gap-2 overflow-y-auto overflow-x-hidden ${STACK_WIDTH_CLASS} ${scroll类}`}
      style={{ left: ANCHOR_POSITION.x, top, maxHeight }}
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
