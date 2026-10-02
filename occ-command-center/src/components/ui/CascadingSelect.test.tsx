import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CascadingSelect } from './CascadingSelect';
import type { SelectGroup } from '../../lib/selectGroups';

const GROUPS: SelectGroup[] = [
  {
    key: 'uniapi',
    label: 'uniapi',
    options: [
      { value: 'uniapi-a', label: 'A 模型' },
      { value: 'uniapi-b', label: 'B 模型' },
    ],
  },
  { key: 'localFunction', label: 'localFunction', options: [{ value: 'weather.collect', label: '每日天气采集' }] },
];

function selectors() {
  return screen.getAllByRole('combobox') as HTMLSelectElement[];
}

function optionTexts(select: HTMLSelectElement) {
  return Array.from(select.options).map((option) => option.textContent);
}

/**
 * 接住回写的父组件
 *
 * 光有 spy 不算受控：onChange 报了值而父组件不更新 `value`，下拉不会重渲染，
 * 联动就测不出来。真实调用端（NewTaskOverlay / ActionFormOverlay）都是把值存进
 * state 的，这里照做。
 */
function Controlled({ initial, onChange }: { initial: string; onChange?: (next: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <CascadingSelect
      groups={GROUPS}
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
      groupLabel="供应商"
      ariaLabel="执行者配置"
    />
  );
}

describe('CascadingSelect', () => {
  it('一级是分组，二级只列该组的选项', () => {
    render(<CascadingSelect groups={GROUPS} value="uniapi-a" onChange={() => {}} groupLabel="供应商" ariaLabel="执行者配置" />);
    const [provider, executor] = selectors();
    expect(provider.getAttribute('aria-label')).toBe('供应商');
    expect(executor.getAttribute('aria-label')).toBe('执行者配置');
    expect(optionTexts(provider)).toEqual(['uniapi', 'localFunction']);
    // 二级不含别的供应商的配置
    expect(optionTexts(executor)).toEqual(['A 模型', 'B 模型']);
  });

  it('换一级会换掉二级选项，并把该组第一个叶子报上去', () => {
    const onChange = vi.fn();
    render(<Controlled initial="uniapi-a" onChange={onChange} />);
    fireEvent.change(selectors()[0], { target: { value: 'localFunction' } });

    // 上报的必须是叶子，不是分组 key
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('weather.collect');
    expect(selectors()[0].value).toBe('localFunction');
    expect(optionTexts(selectors()[1])).toEqual(['每日天气采集']);
  });

  it('叶子只从二级来', () => {
    const onChange = vi.fn();
    render(<Controlled initial="uniapi-a" onChange={onChange} />);
    fireEvent.change(selectors()[1], { target: { value: 'uniapi-b' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('uniapi-b');
    // 分组跟着叶子走：选了 uniapi 的叶子，一级仍在 uniapi
    expect(selectors()[0].value).toBe('uniapi');
  });

  it('一个可选项都没有时只渲染二级的占位下拉', () => {
    render(<CascadingSelect groups={[]} value="" onChange={() => {}} groupLabel="供应商" ariaLabel="执行者配置" emptyLabel="没有可用的执行者配置" />);
    expect(selectors()).toHaveLength(1);
    expect(optionTexts(selectors()[0])).toEqual(['没有可用的执行者配置']);
  });

  it('当前叶子不见了：回落到第一组的第一个叶子，且不重复回写', () => {
    const onChange = vi.fn();
    // 每次渲染都给一个新的内联箭头：父组件这样写时 effect 每帧都会重跑，
    // 没有 ref 保护就会每帧回调一次
    const view = (value: string) => (
      <CascadingSelect groups={GROUPS} value={value} onChange={(next) => onChange(next)} groupLabel="供应商" ariaLabel="执行者配置" />
    );
    const { rerender } = render(view('gone'));
    rerender(view('gone'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('uniapi-a');
  });

  it('列表重读后一个执行者都没有：回写成空，让必填校验挡住提交', () => {
    const onChange = vi.fn();
    render(<CascadingSelect groups={[]} value="uniapi-a" onChange={onChange} groupLabel="供应商" ariaLabel="执行者配置" />);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('当前叶子还在就不回写', () => {
    const onChange = vi.fn();
    render(<CascadingSelect groups={GROUPS} value="uniapi-b" onChange={onChange} groupLabel="供应商" ariaLabel="执行者配置" />);
    expect(onChange).not.toHaveBeenCalled();
  });
});
