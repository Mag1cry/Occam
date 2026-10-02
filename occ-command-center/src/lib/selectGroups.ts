/**
 * 两级下拉的通用形状
 *
 * 这里不认识任何领域对象：谁都可以把自己的目录切成「组 + 组内选项」两段。
 * 领域映射在各自的地方做（执行者配置见 `executorGroups.ts`），
 * 这样下拉组件和 `ActionFormOverlay` 都不用知道执行者是什么。
 *
 * 一级（组）只是分组轴，**永远不是提交值**；提交的只有二级的 `value`。
 */

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectGroup {
  /** 一级下拉的 value。同一份列表里必须唯一 */
  key: string;
  label: string;
  options: SelectOption[];
}

/**
 * 第一组的第一个叶子：下拉的初值规则。
 *
 * 列表为空就返回空串——没有可选项时不猜一个值出来，让必填校验去挡住提交。
 */
export function firstOptionValue(groups: SelectGroup[]): string {
  return groups[0]?.options[0]?.value ?? '';
}

/**
 * 叶子值属于哪一组：受控的一级下拉靠它反推当前分组，不另存一份状态。
 *
 * 不在任何一组里就返回 null——调用方据此决定是回落还是回写空值，
 * 这里不替它选。
 */
export function groupContaining(groups: SelectGroup[], value: string): SelectGroup | null {
  return groups.find((group) => group.options.some((option) => option.value === value)) ?? null;
}
