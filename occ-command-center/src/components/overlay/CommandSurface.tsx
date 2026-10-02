/**
 * CommandSurface
 *
 * 操作牌是节点上下文的一部分，只在 Selected 或 Focus 中出现；
 * 普通节点不常驻按钮列。
 *
 * 视觉层级（visual-system.md 第 9 节）：
 *   1. 当前主操作
 *   2. 次要只读操作
 *   3. 高风险操作及其后果
 *   4. 提交回执和真实状态等待
 *
 * 任何平台都不能用滑动直接批准、拒绝或取消。
 */

import { useState } from 'react';
import { Badge } from '../ui/Badge';
import { ActionPreview } from './ActionPreview';
import type { Command, CommandSurfaceModel } from '../../core/types/projection';
import type { CommandOutcome } from '../../lib/objectCommands';

export interface CommandSurfaceProps {
  model: CommandSurfaceModel;
  /** 目标对象显示名 */
  targetLabel?: string;
  /** 进入局部场景 */
  onEnterScene?: () => void;
  /**
   * 提交命令
   *
   * 返回 `{ submitted: false }` 表示这条命令没有提交任何东西
   * （只读 / 导航），此时**不显示回执**。返回失败时显示原因——
   * 提交失败也提示「Core 已接受」是在编造事实。
   */
  onExecute?: (command: Command) => Promise<CommandOutcome> | CommandOutcome;
  /**
   * `type === 'view'` 的那几条（查看结果 / 查看事件 / 查看取消记录）
   *
   * **它们不是后端命令**——`resolveTaskCommand` 对它们返回 null，落到 `onExecute`
   * 只会得到 `{submitted:false}` 然后静默返回：按钮看着能点，按下去什么都没发生，
   * 也没有回执。所以它们单独走这一条，由调用方去开对应的浮窗。
   */
  onView?: (command: Command) => void;
  /** 目标对象的状态修订号（有来源时才传） */
  stateVersion?: string;
}

/**
 * 命令执行回执
 *
 * `accepted` 上可以挂一句 `warning`：命令确实被接收了，但后端在回执里同时
 * 说了一件用户必须知道的事（比如「批准记下了，可自动恢复没做成」）。
 * 它不是一个新状态——`ok:false` 会把已经发生的事说成没发生。
 */
type Receipt =
  | { command: Command; status: 'accepted'; warning?: string }
  | { command: Command; status: 'rejected'; error: string };

export function CommandSurface({
  model,
  targetLabel = model.targetId,
  onEnterScene,
  onExecute,
  onView,
  stateVersion,
}: CommandSurfaceProps) {
  const [previewCommand, setPreviewCommand] = useState<Command | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const submit = async (command: Command) => {
    if (!onExecute) return;
    const outcome = await onExecute(command);
    if (!outcome || !outcome.submitted) return;
    setReceipt(
      outcome.ok
        ? { command, status: 'accepted', warning: outcome.warning }
        : { command, status: 'rejected', error: outcome.error }
    );
  };

  const runCommand = (command: Command) => {
    if (command.unavailable) return;

    // 第一层不直接执行高风险命令
    if (command.highRisk) {
      setPreviewCommand(command);
      return;
    }

    if (command.type === 'enter') {
      onEnterScene?.();
      return;
    }

    // 只读的那几条没有后端命令，交给调用方去开浮窗（见 `onView` 的说明）
    if (command.type === 'view') {
      onView?.(command);
      return;
    }

    void submit(command);
  };

  const confirmPreview = () => {
    if (!previewCommand) return;
    void submit(previewCommand);
    setPreviewCommand(null);
  };

  const primary = model.commands.filter((c) => !c.highRisk && c.type !== 'view');
  const reads = model.commands.filter((c) => c.type === 'view');
  const risky = model.commands.filter((c) => c.highRisk);

  return (
    <>
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 max-w-[720px]">
        <div
          className="rounded-2xl p-2.5 border"
          style={{
            borderColor: 'rgba(45,212,167,0.32)',
            background: 'linear-gradient(160deg, rgba(8,18,24,0.96), rgba(7,10,14,0.94))',
            boxShadow:
              '0 0 32px -10px rgba(45,212,167,0.55), 0 18px 42px -20px rgba(0,0,0,0.95)',
            backdropFilter: 'blur(18px)',
          }}
        >
          <div className="flex items-center gap-2 px-1.5 pb-2">
            <span className="label">操作牌</span>
            <span className="text-[12px] text-slate-200 truncate max-w-[240px]">
              {targetLabel}
            </span>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            {/* 第一层：当前事实允许的功能入口 */}
            {primary.map((command) => (
              <CommandButton
                key={command.id}
                command={command}
                tone="primary"
                onClick={() => runCommand(command)}
              />
            ))}

            {/* 第二层：次要只读操作 */}
            {reads.map((command) => (
              <CommandButton
                key={command.id}
                command={command}
                tone="secondary"
                onClick={() => runCommand(command)}
              />
            ))}

            {/* 第三层：高风险操作及其后果 */}
            {risky.map((command) => (
              <CommandButton
                key={command.id}
                command={command}
                tone="danger"
                onClick={() => runCommand(command)}
              />
            ))}
          </div>

          {/* 第四层：提交回执 */}
          {receipt && (
            <div className="mt-2 pt-2 px-1.5 border-t border-white/10 flex items-center gap-2">
              {receipt.status === 'accepted' ? (
                <>
                  <Badge variant="info" size="sm">
                    accepted
                  </Badge>
                  <span className="text-[11px] text-slate-400">
                    Core 已接受 {receipt.command.label}，正在重新读取对象与事件…
                  </span>
                  {/*
                    接受 ≠ 后续那一步也成了。后端在回执里明说的话必须显示出来，
                    否则用户以为批准生效了，而任务其实还停在 paused 上。
                  */}
                  {receipt.warning && (
                    <span className="w-full text-[11px] text-occ-warn break-words">
                      {receipt.warning}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <Badge variant="danger" size="sm">
                    rejected
                  </Badge>
                  <span className="text-[11px] text-occ-crit-light truncate">
                    {receipt.command.label} 未提交：{receipt.error}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 高风险命令一律先进预览 */}
      {previewCommand && (
        <ActionPreview
          targetId={model.targetId}
          targetLabel={targetLabel}
          command={previewCommand}
          stateVersion={stateVersion}
          onConfirm={confirmPreview}
          onCancel={() => setPreviewCommand(null)}
        />
      )}
    </>
  );
}

function CommandButton({
  command,
  tone,
  onClick,
}: {
  command: Command;
  tone: 'primary' | 'secondary' | 'danger';
  onClick: () => void;
}) {
  // 与 occ-web 的 .tactical-action 同款：同色淡底 + 同色描边 + 悬停提亮上浮
  const toneClass = {
    primary: 'border-occ-accent/40 bg-occ-accent/10 text-occ-accent hover:border-occ-accent/70',
    secondary: 'border-white/15 bg-white/[0.035] text-slate-300 hover:border-white/35 hover:text-white',
    danger: 'border-occ-crit/40 bg-occ-crit/10 text-occ-crit hover:border-occ-crit/70',
  }[tone];

  const disabled = Boolean(command.unavailable);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={command.description}
      className={`inline-flex items-center gap-1.5 min-h-[32px] px-2.5 py-1.5 rounded-lg border text-[12px] transition-all hover:-translate-y-px ${toneClass} ${
        disabled ? 'opacity-40 cursor-not-allowed hover:translate-y-0' : 'cursor-pointer'
      }`}
    >
      {command.label}
      {command.highRisk && !disabled && (
        <span className="text-[10px] opacity-70">需预览</span>
      )}
      {disabled && <span className="text-[10px] opacity-70">接口未就绪</span>}
    </button>
  );
}
