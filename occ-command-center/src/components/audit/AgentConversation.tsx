/**
 * AgentConversation
 *
 * **完整的人机交互**——系统提示、人的输入、模型每一轮说的话（含它要调什么）、
 * 工具回来了什么，按执行者账上存的顺序。
 *
 * ## 外观：和工具调用**同一套卡片**
 *
 * 一条记录一张卡，横向翻页，**身份标在卡片下方**（小方块 + 名字 + 状态）——
 * 任务管理器的读法。配方住在 `AuditCard.tsx`，这里只是换个名字去用它：
 * 工具卡写工具名，这里写角色名（系 / 人 / 模 / 具）。
 *
 * 两处长得一样是**故意的**：它们是同一类东西（一条审计记录），只是记的内容不同。
 * 各画各的会让"这两排是一回事"读不出来。
 *
 * ## 为什么不是一列竖排
 *
 * 竖排的读法适合"一封信"，而这里是一条**序列**：一条接一条、能翻、能看有多少条。
 * 横向卡片把"有多少条"和"现在看第几条"同时摆出来了。
 *
 * ## 工具调用在里面，不在另一排
 *
 * "要调什么"是模型那一轮卡片里的东西（名字 + 参数），"回来什么"是紧接着那张
 * 工具卡。它们本来就是同一串里的两条——单列一排会让它们从这条线里脱开。
 */

import type { AgentTurn } from '../../api/gateway';
import { Markdown } from '../ui/Markdown';
import { CardCaption, CardSurface } from './AuditCard';
import { CARD_DECK_CLASS, CARD_HEIGHT, type CallStatus } from './auditCardStyle';

export interface AgentConversationProps {
  turns: AgentTurn[];
}

const SLATE = '#64748b';
const ACCENT = '#2dd4a7';
const CRIT = '#ff5470';

/** 角色 → 方块里的字、名字、强调色。工具那一种按成败取色 */
function roleOf(turn: AgentTurn): { glyph: string; name: string; accent: string } {
  switch (turn.role) {
    case 'human':
      return { glyph: '人', name: '委托 · 人的输入', accent: ACCENT };
    case 'ai':
      return { glyph: '模', name: '模型', accent: SLATE };
    case 'tool':
      return { glyph: '具', name: turn.tool_id || '工具',
               accent: turn.status === 'success' ? ACCENT : CRIT };
    case 'system':
      return { glyph: '系', name: '系统提示', accent: SLATE };
    default:
      return { glyph: turn.role.slice(0, 1) || '·', name: turn.role, accent: SLATE };
  }
}

/** 只有工具那一条有成败可言；模型说了句话没有 */
function statusOf(turn: AgentTurn): CallStatus | undefined {
  if (turn.role !== 'tool') return undefined;
  if (turn.status === 'success') return 'success';
  return turn.status ? 'failed' : 'unknown';
}

export function AgentConversation({ turns }: AgentConversationProps) {
  if (turns.length === 0) {
    return <div className="text-[13px] text-slate-500">这份 checkpoint 里没有消息</div>;
  }

  return (
    <div data-audit-conversation className={CARD_DECK_CLASS}>
      {turns.map((turn, index) => {
        const { glyph, name, accent } = roleOf(turn);
        const isTool = turn.role === 'tool';

        return (
          // 序号进 key：同一条线程里模型可以说很多次话，内容可能一模一样
          <div key={`${index}-${turn.role}`} className="shrink-0 snap-center h-full flex flex-col">
            <div className={`${CARD_HEIGHT} flex flex-col`}>
              <CardSurface focused={false} accent={accent}>
                {/*
                  **卡片里不写"这是谁说的"。** 身份标在卡片下方——那一行才是这张卡
                  的名字。两处都写，同一个名字会在屏幕上出现两次（任务管理器也不在
                  卡片里再印一遍进程名）。
                */}
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {isTool ? (
                    // 工具多半回的是 JSON：原文 + 等宽，排版过的反而看不清结构
                    <div className="num whitespace-pre-wrap break-words text-[12px] leading-[1.6] text-slate-200">
                      {turn.text || '（空）'}
                    </div>
                  ) : (
                    <Markdown content={turn.text || '（空）'} />
                  )}

                  {/*
                    模型这一轮要调的工具：名字 + 参数。**结果不在这儿**——
                    它在紧接着的那张工具卡上。
                  */}
                  {(turn.calls ?? []).map((call) => (
                    <div
                      key={call.call_id || call.tool_id}
                      className="mt-2 rounded-lg border border-white/10 bg-black/25 px-2 py-1.5"
                    >
                      <div className="text-[10px] text-slate-500">要调用</div>
                      <div className="num text-[12px] text-occ-accent break-all">
                        {call.tool_id}
                      </div>
                      <div className="num text-[11px] text-slate-400 break-all">
                        {JSON.stringify(call.args ?? {})}
                      </div>
                    </div>
                  ))}
                </div>
              </CardSurface>
            </div>

            <CardCaption glyph={glyph} name={name} status={statusOf(turn)} />
          </div>
        );
      })}
    </div>
  );
}
