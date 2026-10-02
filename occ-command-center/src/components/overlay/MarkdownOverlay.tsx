/**
 * MarkdownOverlay
 *
 * **一份可滚动的 Markdown 浮窗。** 它刻意做得很薄，因为有两处要用它：
 *
 * | 谁 | 里面装什么 |
 * | --- | --- |
 * | Task 的「查看结果」 | 执行者最后报上来的那段话（`Task.result_ref`） |
 * | 「审批申请」**（待做）** | 需要人批的工具调用，由 Agent 写一份申请—— |
 * | | 那一份还要在底下放「批准 / 拒绝」，所以这里留了 `footer` 插槽 |
 *
 * ## 为什么是浮窗而不是面板里那一小块
 *
 * 结果本来在 `TaskScene` 里有一小块常驻（`max-h-[132px]`），只够扫一眼。
 * 而执行者报上来的东西可以很长（一次调研、一份表格），要读它就得有地方摊开。
 * 所以：**空格子留给"扫一眼"，按钮打开浮窗用来"读它"**。
 *
 * ## 三条界面约定
 *
 * - **不点背景关闭**。这里装的是要读的正文，读到一半挥手点空处就没了会很烦；
 *   要关就按右上角那个 ✕（和 `NewTaskOverlay` 同一条规矩）。
 * - **正文区自己滚**，头和脚不动：头和脚是"这是什么"与"我能做什么"，
 *   它们跟着正文滚走之后，读到一半就说不清自己在看什么了。
 * - **空正文说清是空**，不画一个空白浮窗——空白看起来像加载失败。
 */

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { GlassPanel } from '../ui/GlassPanel';
import { Markdown } from '../ui/Markdown';

export interface MarkdownOverlayProps {
  /** 这是什么（如「执行结果」「审批申请」） */
  title: string;
  /** 它属于谁——问出"这是哪个的"要能在这里找到答案 */
  subtitle?: string;
  /** Markdown 原文 */
  content: string;
  /** 正文为空时那句话。缺省是一句中性的 */
  emptyLabel?: string;
  /** 底部操作区。审批申请会在这一格放「批准 / 拒绝」 */
  footer?: ReactNode;
  onClose: () => void;
}

export function MarkdownOverlay({
  title,
  subtitle,
  content,
  emptyLabel = '这一份没有正文',
  footer,
  onClose,
}: MarkdownOverlayProps) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50">
      {/*
        高度分配：面板 `max-h` + `flex-col`，正文区 `flex-1 min-h-0 overflow-auto`。
        `min-h-0` 是必须的——不加的话 flex 子项的最小高度是内容高度，
        `overflow-auto` 就永远不生效，长正文会把面板撑出屏幕。
      */}
      {/*
        宽度取 `min(760px, 92vw)`：**平板上固定 760px 会溢出**。窄屏时留出两边
        的边距，浮窗才不会被切掉一边。
      */}
      <GlassPanel variant="strong" className="flex max-h-[85vh] w-[min(760px,92vw)] flex-col p-5">
        <div className="flex shrink-0 items-start justify-between">
          <div className="min-w-0">
            <div className="text-[19px] font-medium text-white">{title}</div>
            {subtitle && (
              <div className="num mt-1 truncate text-[13px] text-gray-500">{subtitle}</div>
            )}
          </div>
          {/* 触摸目标给大一点：`h-4 w-4` 的图标在平板上不好点 */}
          <button
            onClick={onClose}
            className="-mr-1 -mt-1 ml-3 shrink-0 rounded p-2 text-gray-400 transition-smooth hover:bg-white/5 hover:text-white"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-auto rounded border border-white/10 bg-black/20 p-4">
          {content.trim()
            ? <Markdown content={content} />
            : <div className="text-[14px] text-slate-500">{emptyLabel}</div>}
        </div>

        {footer && <div className="mt-4 shrink-0">{footer}</div>}
      </GlassPanel>
    </div>
  );
}
