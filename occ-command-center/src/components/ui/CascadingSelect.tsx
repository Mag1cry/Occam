/**
 * CascadingSelect
 *
 * 两级联动下拉：一级选组，二级选组内的具体选项。
 *
 * 契约：**受控的是叶子值**，一级只是分组轴，永远不进 `value`／`onChange`。
 * 所以调用方拿到的就是真正要提交的那个引用（执行者配置的 id、日程的执行者……），
 * 不需要自己拼接，也不可能把「供应商」误当成提交值。
 *
 * 当前分组由叶子反推（`groupContaining`），不另存一份「选中的组」状态：
 * 两处都存就会不一致，而叶子才是后端认的那个值。
 *
 * 换成一级时立刻上报那一组的第一个叶子：受控的二级下拉必须永远落在真实选项上，
 * 不能出现「显示第一项、值却是上一组的」——`ActionFormOverlay` 里那条初值注释
 * 记的就是同一个坑。
 */

import { useEffect, useRef } from 'react';
import { firstOptionValue, groupContaining, type SelectGroup } from '../../lib/selectGroups';

const FIELD_CLASS =
  'px-3 py-2 rounded bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-occ-accent/50 transition-smooth';

export interface CascadingSelectProps {
  groups: SelectGroup[];
  /** 叶子值——真正提交给后端的引用 */
  value: string;
  onChange: (value: string) => void;
  /** 一级下拉的无障碍名（如「供应商」） */
  groupLabel: string;
  /** 二级下拉的无障碍名，通常就是字段名 */
  ariaLabel: string;
  /** 一个可选项都没有时的占位文案 */
  emptyLabel?: string;
  className?: string;
}

export function CascadingSelect({
  groups,
  value,
  onChange,
  groupLabel,
  ariaLabel,
  emptyLabel,
  className,
}: CascadingSelectProps) {
  // 当前叶子还在列表里就用它，否则回落到第一组的第一个叶子
  const resolved = groupContaining(groups, value) ? value : firstOptionValue(groups);
  const active = groupContaining(groups, resolved);

  /*
    快照重读后当前叶子可能已经不存在了（配置被删、扩展被停用）。

    回写必须**最多一次**：父组件若没接这个回写值，无保护的 effect 会在每次渲染
    都重新回写一遍，变成死循环。ref 记下「已经为哪个值回写过」。
  */
  const repairedFrom = useRef<string | null>(null);
  useEffect(() => {
    if (resolved === value) {
      repairedFrom.current = null;
      return;
    }
    if (repairedFrom.current === value) return;
    repairedFrom.current = value;
    // 列表空了就回写成空串：让必填校验去挡住提交，而不是在 state 里留一个假引用
    onChange(resolved);
  }, [resolved, value, onChange]);

  return (
    <div className={`flex gap-2 ${className ?? ''}`}>
      {/*
        一个供应商都没有时不画一级：空的下拉等于把「没有配置」画成「有一组空的」。
        两个 select 各带 aria-label 而不是共用一个 <label>——一个 label 只能绑一个控件，
        给两个控件加标题会让第二个没有可访问名。
      */}
      {groups.length > 0 && (
        <select
          aria-label={groupLabel}
          value={active?.key ?? ''}
          onChange={(event) => {
            const next = groups.find((group) => group.key === event.target.value);
            onChange(next?.options[0]?.value ?? '');
          }}
          className={`${FIELD_CLASS} w-2/5 shrink-0`}
        >
          {groups.map((group) => (
            <option key={group.key} value={group.key} className="bg-occ-bg">
              {group.label}
            </option>
          ))}
        </select>
      )}

      <select
        aria-label={ariaLabel}
        value={resolved}
        onChange={(event) => onChange(event.target.value)}
        className={`${FIELD_CLASS} flex-1 min-w-0`}
      >
        {(active?.options ?? []).map((option) => (
          <option key={option.value} value={option.value} className="bg-occ-bg">
            {option.label}
          </option>
        ))}
        {(active?.options.length ?? 0) === 0 && (
          <option value="" className="bg-occ-bg">
            {emptyLabel ?? '没有可选值'}
          </option>
        )}
      </select>
    </div>
  );
}
