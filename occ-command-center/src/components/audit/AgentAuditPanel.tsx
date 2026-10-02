/**
 * AgentAuditPanel
 *
 * Agent Audit Timeline 与 Agent Call Cards 共享同一个审计焦点：
 * 点击任一方都更新另一方。
 *
 * 两条信息线不能混：
 *   Core Event Log  → 内核控制事实
 *   Agent Audit     → 外围 Agent 执行资料
 *
 * 视觉与 occ-web 同源：
 * - 切换用分段控件（同色实心滑块 + 黑字），不是两个描边按钮；
 * - 「Agent 审计」那一页是**完整的人机交互**：一条记录一张卡、横向翻页，
 *   身份标在卡片下方（任务管理器的读法，配方在 `AuditCard.tsx`）；
 * - 小字号（11–13px）+ 等宽数字 + 字距拉开的大写小标签。
 *
 * 审计投影不能直接改变 Core Task 状态，也不能伪造 Core Event。
 */

import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { AgentTurn } from '../../api/gateway';
import type { ControlEvent } from '../../api/gateway';
import { CoreEventLog } from './CoreEventLog';
import { AgentConversation } from './AgentConversation';
import { PlainCallCard } from './PlainCallCard';

export interface AgentAuditPanelProps {
  events: ControlEvent[];
  /**
   * **完整的人机交互**——系统提示、人的输入、模型每一轮说的话（含它要调什么）、
   * 工具回来了什么，按执行者账上存的顺序。
   *
   * 不再单收一份 `calls`：工具调用本来就在这条序列里面（"要调什么"是模型那一轮，
   * "回来什么"是紧接着的那一轮）。单列一份只会让它们从交互里脱开，变成另一件事。
   */
  turns?: AgentTurn[];
  /** 外围审计资料是否可用 */
  auditAvailable: boolean;
  /**
   * 这个执行者是哪一种——**由后端答**（`read_agent_audit` 那份答复里的 `kind`）。
   *
   * - `agent`：多卡（完整的人机交互）
   * - `plain`：单卡（输入 → 输出）
   * - `undefined`：**还没读到**，既不说"不可用"也不画单卡——那两种都是在
   *   信息到手之前就替用户下了结论
   *
   * `kind === 'plain'` 和 `auditAvailable === false` 是**两件事**：前者是"这个东西
   * 本来就没有中间过程"，后者是"该有过程，但这次读不到"。混成一句会把**正常说成
   * 故障**——而固定代码的执行者本来就只该有一次输入一次输出。
   */
  kind?: 'agent' | 'plain';
  /** `kind === 'plain'` 时那张单卡的内容（输入侧只有摘要，见 `PlainCallCard`） */
  plain?: { summary: string; output: string; executorLabel?: string };
}

type Tab = 'audit' | 'core';

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: 'audit', label: 'Agent 审计', hint: '外围执行资料 · 完整的人机交互' },
  { key: 'core', label: '内核事件', hint: '内核控制事实 · 按追加顺序查看' },
];

/**
 * 分段控件
 *
 * 胶囊容器 + 滑块；滑块用共享 layout 动画移动，位置变化本身就是「切到哪一条」的反馈。
 * prefers-reduced-motion 下不做位移动画，只换底色。
 */
function SegmentedControl({ value, onChange }: { value: Tab; onChange: (tab: Tab) => void }) {
  const reduceMotion = useReducedMotion();

  return (
    <div className="inline-flex items-center gap-1 bg-white/[0.04] border border-white/10 rounded-lg p-1 shrink-0">
      {TABS.map((item) => {
        const active = value === item.key;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            aria-pressed={active}
            className={`relative h-7 px-3.5 rounded-md text-[12px] transition-all ${
              active ? 'text-black' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {active && (
              <motion.span
                layoutId="audit-segment"
                className="absolute inset-0 rounded-md bg-occ-accent"
                transition={
                  reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }
                }
              />
            )}
            <span className="relative z-10">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function AgentAuditPanel({
  events,
  turns,
  auditAvailable,
  kind,
  plain,
}: AgentAuditPanelProps) {
  const [tab, setTab] = useState<Tab>('audit');
  const activeTab = TABS.find((item) => item.key === tab)!;

  return (
    <div className="flex flex-col h-full min-h-0 gap-4">
      {/* 两条信息线的切换：不混成一条事件带 */}
      <div className="flex items-center gap-3 shrink-0">
        <SegmentedControl value={tab} onChange={setTab} />
        <span className="text-[11px] text-slate-500 truncate">{activeTab.hint}</span>
      </div>

      {tab === 'audit' ? (
        kind === 'plain' ? (
          // 固定代码的执行者：本来就没有中间过程，画单卡（输入 → 输出）
          <PlainCallCard summary={plain?.summary ?? ''} output={plain?.output ?? ''}
                         executorLabel={plain?.executorLabel} />
        ) : !auditAvailable ? (
          /*
            `kind` 落在这一支有两种情形，都不该猜：
            - **智能体但这次没读成**（后端会明说 `kind: "agent"`）
            - **整份答复都没拿到**（`kind` 是 undefined）——那会儿我们连它是哪一种
              都不知道，画单卡就是替它下结论。说"读不到"才是如实。
          */
          <div className="flex-1 flex items-center justify-center text-[12px] text-slate-500">
            审计资料不可用 —— 不显示 Core Event 补出的 Agent 参数或流程
          </div>
        ) : (turns ?? []).length === 0 ? (
          // 「投影可用但没有消息」和「投影不可用」是两件事，
          // 不能都显示成不可用：那会把「没有」说成「拿不到」
          <div className="flex-1 flex items-center justify-center text-[12px] text-slate-500">
            审计投影可用，这一轮没有可显示的消息
          </div>
        ) : (
          /*
            **这一页的正文就是完整的人机交互**——系统提示、人的输入、模型每一次
            说的话、它要调什么、工具回来了什么，按执行者账上存的顺序，一条一张卡。

            工具调用**不另起一段**：它本来就在交互里面（"要调什么"是模型那一轮
            说的话，"回来什么"是紧接着的那一轮）。以前只画调用、把它当成另一件事，
            整条"它为什么这么干"的线就都没了。
          */
          /*
            不给 `overflow-auto`：卡片组自己横向翻页，竖向由每张卡内部消化。
            外面再套一层滚动会让"翻页"和"滚动"两套手势打架。
          */
          <div className="flex-1 min-h-0">
            <AgentConversation turns={turns ?? []} />
          </div>
        )
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <CoreEventLog events={events} />
        </div>
      )}
    </div>
  );
}
