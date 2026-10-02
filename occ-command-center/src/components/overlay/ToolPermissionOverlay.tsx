/**
 * ToolPermissionOverlay
 *
 * 改一个能力的**声明**（写在它所属扩展包的 `manifest.yaml` 里，ADR-033：manifest
 * 是唯一的声明事实，不设镜像）。
 *
 * 三件事必须在界面上说清：
 *
 * 1. **改的是哪个包的哪个工具**。工具自己的权限编辑也是改包的文件，说不清这一步
 *    用户就不知道自己在动谁；
 * 2. **只有那几个字段能改**：身份与绑定（`tool_id` / `entrypoint` / `kind`）不是
 *    配置，后端会拒；
 * 3. **保存成功 ≠ 已生效**。后端改完会立刻重载该包，重载的结果（started / loaded /
 *    already / failed…）是这件事的另一半——只说「保存成功」，用户会以为改动已经
 *    在跑了，而它可能没加载起来。
 *
 * 没显式声明过的字段（继承自 defaults）会被后端拒，原因原样显示：凭空加一个字段
 * 等于改变声明本身，那不该是一次点按的结果。
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import { GlassPanel } from '../ui/GlassPanel';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import {
  EDITABLE_TOOL_FIELDS,
  TOOL_FIELD_KIND,
  setToolField,
  type ActivationOutcome,
  type EditableToolField,
  type GatewayCapability,
  type LiveDeclaration,
} from '../../api/gateway';
import { activationFailureText } from '../../lib/nodeVisual';
import { useGatewayStore } from '../../store/gatewayStore';

export interface ToolPermissionOverlayProps {
  /** 扩展包目录名：后端按目录去定位 manifest，不是 `extension.<id>` 那个引用 */
  extensionId: string;
  /** 工具在快照里的记录；没有记录时字段留空，不猜当前值 */
  capability?: GatewayCapability;
  /** 声明原文：改一条**列表里**的条目要整列交回去（见 `setToolField`） */
  declarations?: LiveDeclaration[];
  onClose: () => void;
}

const FIELD_CLASS =
  'num mt-1 w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-occ-accent/50 transition-smooth';

/** 布尔字段的当前值 → 表单值。快照没给这一项时是空串（没选，不是「否」） */
function boolValue(value: boolean | undefined): string {
  return value === undefined ? '' : value ? 'true' : 'false';
}

function fieldValueOf(field: EditableToolField, capability?: GatewayCapability): string {
  switch (field) {
    case 'approval_required':
      return boolValue(capability?.approval_required);
    case 'idempotency':
      // 快照里没有这一项：留在空态，由用户给出值；不替后端填一个默认值
      return '';
    case 'enabled':
      // 能出现在快照里的工具必然是启用着的，所以这里的当前值是真的
      return 'true';
  }
}

export function ToolPermissionOverlay({
  extensionId,
  capability,
  declarations = [],
  onClose,
}: ToolPermissionOverlayProps) {
  const load = useGatewayStore((state) => state.load);
  const toolId = capability?.tool_id ?? '';

  const [field, setField] = useState<EditableToolField>('approval_required');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(EDITABLE_TOOL_FIELDS.map((name) => [name, fieldValueOf(name, capability)]))
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 保存成功之后的**重载结果**：它是「已生效」那一半，必须显示 */
  const [reloaded, setReloaded] = useState<ActivationOutcome | null>(null);
  const [saved, setSaved] = useState(false);

  const kind = TOOL_FIELD_KIND[field];
  const current = values[field] ?? '';
  const canSubmit = Boolean(toolId) && current.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const outcome = await setToolField({
        extensionId,
        toolId,
        field,
        value: kind === 'boolean' ? current === 'true' : current.trim(),
      }, declarations);
      setReloaded(outcome.reloaded);
      setSaved(true);
      // 重载改变了注册表：重读快照，画布上的能力与包才会跟着变
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50">
      <GlassPanel variant="strong" className="w-[480px] p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-base font-medium text-white">编辑权限</div>
            <div className="mt-1 text-xs text-gray-500">
              改的是 <span className="num text-slate-300">{extensionId}</span> 这个包里的
              <span className="num text-slate-300"> {toolId || '（未知工具）'}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-smooth"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {saved ? (
          <div className="space-y-2">
            <div className="text-sm text-slate-200">
              已写入 manifest：{toolId} 的 {field}
            </div>
            {/*
              「保存成功」与「已生效」之间不能不说清楚：这一步的结果是重载，
              而重载可能失败（诊断会说为什么），也可能需要重启。
            */}
            {reloaded ? (
              <div className="text-[12px] text-slate-400">
                已经重载该包：<span className="num">{reloaded.status}</span>
                {activationFailureText(reloaded) && (
                  <div className="mt-1 text-occ-crit-light">
                    {activationFailureText(reloaded)}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[12px] text-slate-400">本次没有重载该包</div>
            )}
            <div className="pt-2 flex justify-end">
              <Button size="sm" onClick={onClose}>完成</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <label className="block">
                <span className="text-xs text-gray-400">字段</span>
                <select
                  value={field}
                  onChange={(event) => setField(event.target.value as EditableToolField)}
                  className={FIELD_CLASS}
                >
                  {EDITABLE_TOOL_FIELDS.map((name) => (
                    <option key={name} value={name} className="bg-occ-bg">
                      {name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-xs text-gray-400">值</span>
                {kind === 'boolean' ? (
                  <select
                    value={current}
                    onChange={(event) =>
                      setValues((prev) => ({ ...prev, [field]: event.target.value }))
                    }
                    className={FIELD_CLASS}
                  >
                    {/* 快照没说当前值时不预选：不替用户决定这一格是什么 */}
                    {current === '' && <option value="" className="bg-occ-bg">（请选一个）</option>}
                    <option value="true" className="bg-occ-bg">是</option>
                    <option value="false" className="bg-occ-bg">否</option>
                  </select>
                ) : (
                  <input
                    value={current}
                    onChange={(event) =>
                      setValues((prev) => ({ ...prev, [field]: event.target.value }))
                    }
                    className={FIELD_CLASS}
                  />
                )}
              </label>
            </div>

            <p className="mt-3 text-[11px] text-gray-500 leading-relaxed">
              可改的只有声明字段。tool_id / entrypoint / kind 是身份与绑定，不是配置；
              没有显式声明过的字段（继承自 defaults）会被后端拒绝。
            </p>

            {error && (
              <div className="mt-3 text-[11px] text-occ-crit-light break-words">{error}</div>
            )}

            <div className="mt-4 flex items-center justify-between">
              <Badge variant="info" size="sm">manifest.set_tool_field</Badge>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
                  取消
                </Button>
                <Button size="sm" onClick={() => void handleSubmit()} disabled={!canSubmit}>
                  {submitting ? '提交中…' : '写入并重载'}
                </Button>
              </div>
            </div>
          </>
        )}
      </GlassPanel>
    </div>
  );
}
