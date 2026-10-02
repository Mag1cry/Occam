/**
 * GroupedSelect
 *
 * **单级**下拉：一个 `<select>`，组用 `<optgroup>` 表达。
 *
 * 与 `CascadingSelect` 的区别是那一级到底是不是一个选择步骤：
 *
 * - 两级级联（供应商 → 模型）是「先定一个轴，再在这个轴里选」——一级**必须是**
 *   用户的一次决定；
 * - 这里的一级只是把同一份列表**分组展示**（硬编码执行者 / 智能体）。它不是一个
 *   决定，做成两级反而会让用户以为「组」也是一个要提交的东西。
 *
 * 契约与 `CascadingSelect` 一样：**受控的是叶子值**，组永远不进 `value`／`onChange`。
 * 值不在列表里时回落到第一个叶子（回写最多一次，理由见 `CascadingSelect`：
 * 无保护的 effect 会在每次渲染都回写，变成死循环）；列表为空时回写成空串，
 * 让必填校验去挡住提交，而不是在 state 里留一个后端不认的引用。
 */

import { useEffect, useRef } from 'react';
import { firstOptionValue, type SelectGroup } from '../../lib/selectGroups';

const FIELD_CLASS =
  'px-3 py-2 rounded bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-occ-accent/50 transition-smooth';

export interface GroupedSelectProps {
  groups: SelectGroup[];
  /** 叶子值——真正提交给后端的引用 */
  value: string;
  onChange: (value: string) => void;
  /** 控件的无障碍名（如「执行者」） */
  ariaLabel: string;
  /** 一个可选项都没有时的占位文案 */
  emptyLabel?: string;
  className?: string;
}

export function GroupedSelect({
  groups,
  value,
  onChange,
  ariaLabel,
  emptyLabel,
  className,
}: GroupedSelectProps) {
  const options = groups.flatMap((group) => group.options);
  const resolved = options.some((option) => option.value === value) ? value : firstOptionValue(groups);

  const repairedFrom = useRef<string | null>(null);
  useEffect(() => {
    if (resolved === value) {
      repairedFrom.current = null;
      return;
    }
    if (repairedFrom.current === value) return;
    repairedFrom.current = value;
    onChange(resolved);
  }, [resolved, value, onChange]);

  return (
    <select
      aria-label={ariaLabel}
      value={resolved}
      onChange={(event) => onChange(event.target.value)}
      className={`w-full ${FIELD_CLASS} ${className ?? ''}`}
    >
      {options.length === 0 && (
        <option value="" className="bg-occ-bg">{emptyLabel ?? '没有可选值'}</option>
      )}
      {groups.map((group) => (
        /*
          **分组标题也要自己带底色。** 原生下拉那一层弹窗不在页面的背景里，
          不给它上色就按操作系统的默认走——在这个深色界面上就是一片白
          （`AgentEditorOverlay` 里那条注释记的是同一个坑）。

          `option` 一直带着 `bg-occ-bg`，漏的是 `optgroup` —— 而它恰恰是
          "硬编码执行者 / 智能体"那两行标题，颜色不对时最显眼。全仓只有这一处
          `optgroup`，所以只有这一处会白。
        */
        <optgroup key={group.key} label={group.label} className="bg-occ-bg">
          {group.options.map((option) => (
            <option key={option.value} value={option.value} className="bg-occ-bg">
              {option.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
