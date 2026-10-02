/**
 * OutputOverlay —— **悬着的输出自己弹出来**
 *
 * 这是"前端那条输出路径"的送达方式：后端把悬着的东西放进快照（它是投影，
 * 无状态），这里看到**没弹过的那一条**就弹一个浮窗。
 *
 * ## 为什么是弹窗，不是徽标
 *
 * 徽标（待拍板 N）说的是"有这么几件事"，而它**不催你**——用户可能一整天不点开。
 * 一件等人拍板的事卡在那里，整条链就停在它上面（worker 已经 `paused`）。所以它
 * 该像任务管理器那样**跳出来**，而不是安静地挂在角落里。
 *
 * ## 弹过的记在哪儿
 *
 * 记在**这个组件的内存里**（`popped`）。所以：
 *
 * - 关掉它不等于处理它——它还悬着，但**不会立刻再弹**（不然一次刷新弹三遍）；
 * - **刷新页面会再弹一次**。这是故意的：它还悬着，而"我还欠着一件没拍板"值得被
 *   再说一遍。真要"关掉就永远别再提"，那是把它标记成已读——而**已读不是事实**，
 *   它只是某人此刻不想看，不该写进任何地方。
 *
 * ## 动作从哪来
 *
 * 不在这个文件里编：`actions` 是后端给的（`label` + `command`），这里只负责画。
 * 点下去走的还是**命令面那一条**（`approve` / `deny`）——"前端"这个身份只影响
 * 证据那一格（接入面会填 `web:<principal>`）。
 */
import { useEffect, useRef, useState } from 'react';
import { MarkdownOverlay } from './MarkdownOverlay';
import { Button } from '../ui/Button';
import { submitCommand } from '../../lib/objectCommands';
import { useGatewayStore } from '../../store/gatewayStore';
import type { LiveOutput } from '../../api/gateway';

/** `task:<id>` → `<id>`。目标那一格是引用，命令要的是 id */
function taskIdOf(targetRef: string): string {
  return targetRef.startsWith('task:') ? targetRef.slice('task:'.length) : targetRef;
}

export interface OutputOverlayProps {
  outputs: LiveOutput[];
}

export function OutputOverlay({ outputs }: OutputOverlayProps) {
  const load = useGatewayStore((state) => state.load);
  /** 弹过的那几条（内存里，见文件头） */
  const popped = useRef<Set<string>>(new Set());
  const [current, setCurrent] = useState<LiveOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (current !== null) return;                 // 正看着一条，别换
    const next = outputs.find((item) => !popped.current.has(item.ref));
    if (!next) return;
    popped.current.add(next.ref);
    setCurrent(next);
    setError(null);
  }, [outputs, current]);

  if (current === null) return null;

  const act = async (command: string) => {
    setBusy(true);
    setError(null);
    const outcome = await submitCommand(command, taskIdOf(current.target_ref));
    setBusy(false);
    if (!outcome.submitted || !outcome.ok) {
      setError(outcome.submitted ? outcome.error : '这条命令没有提交出去');
      return;
    }
    // 提交成功只表示 Core 已接收：它**不再悬着**这件事以重读的快照为准
    await load();
    setCurrent(null);
  };

  return (
    <MarkdownOverlay
      title={current.kind === 'approval' ? '有一件要你拍板' : '有一件事等你处理'}
      subtitle={current.title}
      content={current.summary}
      onClose={() => setCurrent(null)}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-occ-crit-light">{error ?? ''}</span>
          <div className="flex gap-2">
            {(current.actions ?? []).map((action) => (
              <Button
                key={action.ref}
                size="sm"
                variant={action.ref === 'deny' ? 'secondary' : 'primary'}
                disabled={busy || !action.command}
                onClick={() => void act(action.command ?? '')}
              >
                {busy ? '提交中…' : action.label}
              </Button>
            ))}
          </div>
        </div>
      }
    />
  );
}
