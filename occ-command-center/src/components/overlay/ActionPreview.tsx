/**
 * ActionPreview
 *
 * 不可逆动作必须先预览（focus-leap.md 第 6 节）：
 *   - 取消 Task
 *   - 拒绝审批
 *   - 批准可能立即触发能力调用的请求
 *   - 停用、删除或发布资源
 *   - 任何没有明确撤回契约的变更
 *
 * 预览显示目标对象、实际命令、影响字段、预计状态变化、是否可撤回、
 * 当前状态版本、当前事件版本、预览生成时间和是否过期。
 *
 * 状态或事件改变后，预览自动失效。
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { GlassPanel } from '../ui/GlassPanel';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import type { Command } from '../../core/types/projection';

export interface ActionPreviewProps {
  /** 目标对象 */
  targetId: string;
  targetLabel: string;
  command: Command;
  /**
   * 预览所依据的状态修订号
   *
   * 来自对象的真实 `state_version`。没有来源时**不显示这一行**——
   * 写一个固定的 `state-v1` 会让人以为预览对齐过某个真实版本。
   */
  stateVersion?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 预览有效期（毫秒）：过期后必须重新生成 */
const PREVIEW_TTL_MS = 60_000;

export function ActionPreview({
  targetId,
  targetLabel,
  command,
  stateVersion,
  onConfirm,
  onCancel,
}: ActionPreviewProps) {
  const [generatedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const expired = now - generatedAt > PREVIEW_TTL_MS;
  const remaining = Math.max(0, Math.ceil((PREVIEW_TTL_MS - (now - generatedAt)) / 1000));

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50">
      <GlassPanel variant="strong" className="w-[420px] p-5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-occ-warn" />
            <span className="text-base font-medium text-white">命令预览</span>
          </div>
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-white transition-smooth"
            aria-label="关闭预览"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <dl className="space-y-2 text-sm">
          <Row label="目标对象" value={`${targetLabel}（${targetId}）`} />
          <Row label="实际命令" value={command.id} mono />
          {/*
            三行都直接来自命令自带的申报。预览组件**不再按命令名兜底**：
            兜底的默认值是「无字段变更 / 只读，不改变状态」，而它会被套在
            真正不可逆的命令上——那是一句假话，而且是盖在闸门上的假话。
          */}
          <Row label="影响字段" value={command.preview.impact} />
          <Row label="预计状态变化" value={command.preview.transition} />
          <Row
            label="是否可撤回"
            value={command.preview.reversible ? '可撤回' : '不可撤回'}
          />
          {stateVersion && <Row label="状态修订号" value={stateVersion} mono />}
          <Row
            label="预览生成时间"
            value={new Date(generatedAt).toLocaleTimeString()}
            mono
          />
        </dl>

        <div className="mt-4 flex items-center justify-between">
          {expired ? (
            <Badge variant="danger" size="sm">
              预览已过期
            </Badge>
          ) : (
            <Badge variant="warning" size="sm">
              {remaining}s 后过期
            </Badge>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onCancel}>
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={onConfirm}
              disabled={expired}
            >
              确认提交
            </Button>
          </div>
        </div>

        <p className="mt-3 text-xs text-gray-500 leading-relaxed">
          提交后返回 accepted 只表示 Core 接受命令，不表示执行成功。
          真实状态以重新读取的 Task 和事件为准。
        </p>
      </GlassPanel>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-gray-400 shrink-0">{label}</dt>
      <dd className={`text-gray-200 text-right ${mono ? 'num' : ''}`}>{value}</dd>
    </div>
  );
}
