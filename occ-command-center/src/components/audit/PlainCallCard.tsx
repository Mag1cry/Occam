/**
 * PlainCallCard
 *
 * **固定代码那种执行者的"审计"**：它没有过程可看，只有一次输入一次输出。
 *
 * 智能体（`langgraph.agent` 那种）跑一轮是一串消息——模型说了什么、要了哪个工具、
 * 判定是什么——所以它有**多卡**（完整的人机交互）。固定代码跑一次就是
 * "给它一句话、它回一句话"，中间没有别的东西。
 *
 * 两种都如实，只是形状不同：**多卡不是"更完整"，单卡也不是"读不到"。**
 * 以前这里只画一句"审计资料不可用"，那把一个正常的事实说成了故障。
 *
 * ## 外观：和交互卡**同一套**
 *
 * 同一份配方（`AuditCard.tsx`）、同一个翻页容器、身份标同样在卡片下方——
 * 它只是"记录"正好只有一条。两处长得一样是故意的：它们是同一类东西
 * （一条审计记录），只是记的内容不同。
 *
 * **不给状态点**：这一条的成功失败就是**这次运行**的成功失败，而它已经写在
 * 屏幕顶端的状态环里了；卡片上再点一次是把同一件事说两遍。
 *
 * 输入只到**委托摘要**为止：输入引用那份文件的正文在前端手里没有（它是宿主读给
 * worker 的，不进快照），所以这里不画它，也不编一个。
 */

import { Markdown } from '../ui/Markdown';
import { CardCaption, CardSurface } from './AuditCard';
import { CARD_DECK_CLASS, CARD_HEIGHT } from './auditCardStyle';

/** 中性色：这条记录既不是"人的输入"也不是"模型说的话"，不该抢这两者的颜色 */
const SLATE = '#64748b';

export interface PlainCallCardProps {
  /** 委托摘要——给执行者的那句话 */
  summary: string;
  /** 执行结果 */
  output: string;
  /** 执行者的人读名称，写进卡片下方那一行。缺省时说"这一次运行" */
  executorLabel?: string;
}

export function PlainCallCard({ summary, output, executorLabel }: PlainCallCardProps) {
  const name = executorLabel?.trim() || '这一次运行';

  return (
    <div className={CARD_DECK_CLASS}>
      <div className="shrink-0 snap-center h-full flex flex-col">
        <div className={`${CARD_HEIGHT} flex flex-col`}>
          <CardSurface focused={false} accent={SLATE}>
            <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
              <section>
                <div className="label mb-1.5">
                  委托摘要 · <span className="label-en">Input</span>
                </div>
                {summary.trim()
                  ? (
                    <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-slate-200">
                      {summary}
                    </p>
                  )
                  : <div className="text-[13px] text-slate-500">这份委托没有摘要</div>}
              </section>

              <div className="h-px bg-white/10" />

              <section>
                <div className="label mb-1.5">
                  执行结果 · <span className="label-en">Output</span>
                </div>
                {output.trim()
                  ? <Markdown content={output} />
                  : <div className="text-[13px] text-slate-500">这一轮没有输出</div>}
              </section>
            </div>
          </CardSurface>
        </div>

        <CardCaption glyph={name.slice(0, 1).toUpperCase()} name={name} />
      </div>
    </div>
  );
}
