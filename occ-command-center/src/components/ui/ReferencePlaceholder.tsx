/**
 * ReferencePlaceholder
 *
 * 引用解析不到时的**最小占位**（ADR-024）：引用本身 + 已下线/未知标记 + 原因。
 *
 * 三件事都不许做：
 *
 * - **不许换成一个看起来正常的对象**。找不到就用另一条配置顶替，界面会显示成一个
 *   完好的东西，而它根本不是用户引用的那个——那是最难查的一类错；
 * - **不许塌成「未知」**。`offline` 与 `unknown` 对用户是两件事：前者是「它被停用了」
 *   或者「它起不来」（系统说得出原因），后者是「系统里没有这个引用」（只能承认不知道）。
 *   两句不同的话，用户才知道下一步是该去把它开回来，还是该去改那个名字；
 * - **不许什么都不显示**。引用查不到就直接消失，会让「它下线了」和「这条记录本来
 *   就没有这个字段」长得一模一样。
 */

import { Unplug, HelpCircle } from 'lucide-react';
import type { ReferenceView } from '../../core/types/node';
import { referenceStateText } from '../../lib/nodeVisual';

export interface ReferencePlaceholderProps {
  view: ReferenceView;
  /** 这个引用是干什么的（如「执行者」「模型」「所属包」），让占位自己说清身份 */
  role?: string;
  /** chip 用于信息行（一行放得下），block 用于画布节点里 */
  variant?: 'chip' | 'block';
}

export function ReferencePlaceholder({ view, role, variant = 'chip' }: ReferencePlaceholderProps) {
  // 可解析的东西不该走占位：占位是给「找不到」用的，能找到就显示对象本身
  if (view.state === 'resolvable') return null;

  const offline = view.state === 'offline';
  const Icon = offline ? Unplug : HelpCircle;
  const toneClass = offline
    ? 'border-occ-warn/30 bg-occ-warn/10 text-occ-warn'
    : 'border-white/15 bg-white/[0.04] text-slate-400';
  // 占位不伪造名称：系统知道的只有那个键，就把键给出来
  const label = view.object_ref || view.ref;

  if (variant === 'block') {
    return (
      <div className={`mt-2 rounded border px-2 py-1.5 ${toneClass}`}>
        <div className="flex items-center gap-1.5">
          <Icon className="w-3 h-3 shrink-0" />
          <span className="num text-[11px] break-all">{label}</span>
          <span className="text-[10px] opacity-80 shrink-0">{referenceStateText(view.state)}</span>
        </div>
        {view.reason && (
          <div className="text-[10px] opacity-90 mt-1 break-words">{view.reason}</div>
        )}
      </div>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-md border ${toneClass}`}
      title={view.reason}
    >
      {role && <span className="opacity-70">{role}</span>}
      <Icon className="w-3 h-3 shrink-0" />
      <span className="num">{label}</span>
      <span className="opacity-80">{referenceStateText(view.state)}</span>
      {/* 原因是占位的一半：只说「已下线」而说不出为什么，用户没有下一步 */}
      {view.reason && <span className="opacity-90">· {view.reason}</span>}
    </span>
  );
}
