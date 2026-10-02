/**
 * ActionFormOverlay
 *
 * 需要参数、没法一键提交的命令——今天用它的是日程的创建与编辑
 * （`ScheduleEditorOverlay` 把一条日程翻译成一列字段，其余一概不管）。
 *
 * 为什么不复用 ActionPreview：那是「一键命令的确认闸门」，只显示影响，不接受输入。
 * 这里是「必须给参数才能提交」的命令，提交按钮前用户已经看过命令和参数，
 * 所以表单本身就是 `focus-leap.md` 第 6 节要求的那个确认步骤——
 * 但它只负责收集参数，提交结果仍按真实回执显示。
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import { GlassPanel } from '../ui/GlassPanel';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { CascadingSelect } from '../ui/CascadingSelect';
import { FilePickerButton } from '../ui/FilePickerButton';
import { firstOptionValue, type SelectGroup, type SelectOption } from '../../lib/selectGroups';

interface ActionFormFieldBase {
  name: string;
  label: string;
  placeholder?: string;
  /** number 会把输入原样交给后端，由后端校验范围；前端不替它做主 */
  type?: 'text' | 'number';
  defaultValue?: string;
  hint?: string;
  required?: boolean;
  /**
   * 这一格是**工作区里的路径**：旁边给一个「选择文件」
   *
   * 这是这个表单唯一一处偏向领域的地方，而且是**故意的**：两张表单（新建任务、
   * 日程）都要它，与其让两个调用方各拼一遍"按钮 + 隐藏 input + 上传"，不如收在
   * 一处。它只加一个按钮，不改变这一格的读写方式——手打的路径照样能用。
   */
  workspaceFile?: boolean;
}

/**
 * 字段的三种形状互斥：文本 / 一级下拉 / 两级下拉。
 *
 * 写成判别联合而不是「两个可选字段」：`options` 和 `groups` 同时给
 * 在类型上就不可表达，渲染分支也就能可靠地收敛。
 *
 * 两级下拉里**只有二级是提交值**（写进 `values[field.name]`），
 * 一级只是分组轴——所以这个表单依然是领域无关的，它只知道「有两级」，
 * 不知道执行者是什么。
 */
export type ActionFormField = ActionFormFieldBase &
  (
    | { options?: SelectOption[]; groups?: undefined; groupsLabel?: undefined }
    | { groups: SelectGroup[]; groupsLabel: string; options?: undefined }
  );

export interface ActionFormOverlayProps {
  title: string;
  description: string;
  /** 实际提交的命令名，显示给用户看 */
  command: string;
  fields: ActionFormField[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<void>;
  onClose: () => void;
}

export function ActionFormOverlay({
  title,
  description,
  command,
  fields,
  submitLabel,
  onSubmit,
  onClose,
}: ActionFormOverlayProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [
      field.name,
      // 下拉框必须落到一个真实存在的选项上：留空时受控 select 会「显示第一项、
      // state 里却是空串」，必填校验于是永远不过。
      // 两级下拉的初值就是第一组的第一个叶子——同样必须是真实选项。
      field.defaultValue
        ?? (field.groups ? firstOptionValue(field.groups) : field.options?.[0]?.value)
        ?? '',
    ]))
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missing = fields.filter((field) => field.required && !values[field.name]?.trim());
  const canSubmit = missing.length === 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(values);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50">
      <GlassPanel variant="strong" className="w-[460px] p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-base font-medium text-white">{title}</div>
            <div className="text-xs text-gray-500 mt-1">{description}</div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-smooth"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          {fields.map((field) => {
            if (field.groups) {
              // 两级下拉不能塞进 <label>：一个 label 只能绑一个控件，两个 select
              // 共用标题会让第二个没有可访问名。字段名改挂在二级上，取值查询照旧能用。
              return (
                <div key={field.name} className="block">
                  <span className="text-xs text-gray-400">{field.label}</span>
                  <CascadingSelect
                    groups={field.groups}
                    value={values[field.name] ?? ''}
                    onChange={(next) =>
                      setValues((prev) => ({ ...prev, [field.name]: next }))
                    }
                    groupLabel={field.groupsLabel}
                    ariaLabel={field.label}
                    className="mt-1"
                  />
                  {field.hint && (
                    <span className="block text-[11px] text-gray-500 mt-1">{field.hint}</span>
                  )}
                </div>
              );
            }
            const write = (value: string) =>
              setValues((prev) => ({ ...prev, [field.name]: value }));
            return (
            <label key={field.name} className="block">
              <span className="text-xs text-gray-400">{field.label}</span>
              {field.options ? (
                <select
                  value={values[field.name] ?? ''}
                  onChange={(event) => write(event.target.value)}
                  className="num mt-1 w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-occ-accent/50 transition-smooth"
                >
                  {field.options.length === 0 && <option value="" className="bg-occ-bg">没有可选值</option>}
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value} className="bg-occ-bg">
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                // 工作区路径那一格多一个「选择文件」；其余仍是一行文本输入
                <div className={field.workspaceFile ? 'mt-1 flex items-center gap-2' : ''}>
                  <input
                    type={field.type ?? 'text'}
                    value={values[field.name] ?? ''}
                    onChange={(event) => write(event.target.value)}
                    placeholder={field.placeholder}
                    className={`${field.workspaceFile ? 'flex-1 min-w-0' : 'mt-1 w-full'} num px-3 py-2 rounded bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-occ-accent/50 transition-smooth`}
                  />
                  {field.workspaceFile && (
                    <FilePickerButton
                      onPicked={write}
                      onError={setError}
                      disabled={submitting}
                    />
                  )}
                </div>
              )}
              {field.hint && (
                <span className="block text-[11px] text-gray-500 mt-1">{field.hint}</span>
              )}
            </label>
            );
          })}
        </div>

        {error && (
          <div className="mt-3 text-[11px] text-occ-crit-light break-words">提交失败：{error}</div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <Badge variant="info" size="sm">
            {command}
          </Badge>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button size="sm" onClick={() => void handleSubmit()} disabled={!canSubmit}>
              {submitting ? '提交中…' : submitLabel}
            </Button>
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}
