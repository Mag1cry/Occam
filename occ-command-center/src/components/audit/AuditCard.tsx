/**
 * AuditCard —— 审计面那套卡片的**唯一一份结构**
 *
 * 任务管理器的读法：**横向翻页的定宽大卡 + 卡片下方的身份标**（小方块 +
 * 名字 + 状态）。表面与画布节点同一套（状态色淡渐变 + 内高光 + 柔和投影）。
 *
 * ## 它从哪来
 *
 * 这套配方原来长在**调用卡**（`AgentCallCards`）里，那个组件已经删了——审计页
 * 现在画的是完整的人机交互，调用在里面。配方本身留着，**数值一个都没改**。
 *
 * ## 为什么它该独立存在
 *
 * 卡片是审计面共用的**呈现原语**：一条记录一张卡，翻过去看下一条。它不该属于
 * 某一个具体的视图——不然下一个视图要用，只能抄一遍，然后两套皮各自漂。
 *
 * 结构在本文件，尺寸与配色在 `auditCardStyle.ts`（和组件分开住是为了 Fast Refresh）。
 */

import type { ReactNode } from 'react';
import { CARD_WIDTH, STATUS_STYLE, hexAlpha, type CallStatus } from './auditCardStyle';

/**
 * 卡片表面
 *
 * 与画布节点同一套读法：状态色淡渐变 + 内高光 + 柔和投影；
 * 焦点卡（与时间线同步的那张）加一圈同色描边和更实的投影。
 */
export function CardSurface({
  children,
  accent,
  focused,
}: {
  children: ReactNode;
  accent: string;
  focused: boolean;
}) {
  const shadow = [
    'inset 0 1px 0 rgba(255,255,255,0.05)',
    focused
      ? '0 18px 44px -20px rgba(0,0,0,0.9)'
      : '0 12px 32px -20px rgba(0,0,0,0.8)',
  ];
  if (focused) shadow.push(`0 0 0 1px ${hexAlpha(accent, 0.65)}`);

  return (
    <div
      className={`${CARD_WIDTH} h-full min-h-0 rounded-2xl flex flex-col p-3 transition-smooth`}
      style={{
        background: `linear-gradient(160deg, ${hexAlpha(accent, focused ? 0.12 : 0.06)}, rgba(255,255,255,0.015))`,
        border: `1px solid ${hexAlpha(accent, focused ? 0.6 : 0.22)}`,
        boxShadow: shadow.join(', '),
      }}
    >
      {children}
    </div>
  );
}

/**
 * 身份标：卡片下方的「图标 + 名字 + 状态」，任务管理器的读法
 *
 * `glyph` 是方块里那个字。当前唯一的使用者给人机交互的角色首字
 * （系 / 人 / 模 / 具）。
 *
 * 原来这里还有一格 `count`（同一个工具连续调用聚成 `×N`）。**已经去掉**：
 * 审计页画的是完整的人机交互，每一次调用各占自己那一轮，"聚成一条"会把
 * 序列里真实的轮次藏起来——而"为什么这么干"恰恰要看那些轮次。
 */
export function CardCaption({
  glyph,
  name,
  status,
}: {
  glyph: string;
  name: string;
  /** 没有状态就不画那个点（比如"模型说了句话"没有成败可言） */
  status?: CallStatus;
}) {
  const style = status ? STATUS_STYLE[status] : null;
  return (
    <div className="shrink-0 flex items-center gap-2 px-1 pt-2.5">
      <span
        className={`w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-semibold shrink-0 border ${
          style?.glyph ?? 'border-white/15 bg-white/[0.04] text-slate-400'
        }`}
        aria-hidden
      >
        {glyph}
      </span>
      <span className="text-[12px] text-slate-200 truncate">{name}</span>
      {style && (
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: style.dot, boxShadow: `0 0 8px ${hexAlpha(style.dot, 0.67)}` }}
          />
          <span className="text-[11px] text-slate-400">{style.text}</span>
        </span>
      )}
    </div>
  );
}
