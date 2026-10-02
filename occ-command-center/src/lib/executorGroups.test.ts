import { describe, expect, it } from 'vitest';
import { groupExecutorsByProvider, UNLABELED_PROVIDER_LABEL } from './executorGroups';
import { firstOptionValue, groupContaining } from './selectGroups';
import type { GatewayExecutor } from '../api/gateway';
import { buildMockSnapshot } from '../mock/snapshot';

function executor(id: string, provider_id?: string, display_name?: string): GatewayExecutor {
  return { id, provider_id, ...(display_name ? { display_name } : {}) };
}

describe('groupExecutorsByProvider', () => {
  it('按 provider_id 分组，组顺序就是首次出现的顺序', () => {
    const groups = groupExecutorsByProvider([
      executor('a', 'uniapi'),
      executor('b', 'deepseek'),
      executor('c', 'uniapi'),
    ]);
    expect(groups.map((group) => group.key)).toEqual(['uniapi', 'deepseek']);
    expect(groups[0].options.map((option) => option.value)).toEqual(['a', 'c']);
    expect(groups[1].options.map((option) => option.value)).toEqual(['b']);
  });

  it('提交的是带作用域的引用，且它的作用域必须等于所在分组的 key', () => {
    // 引用的作用域和分组轴是同一件事：后端按 `供应商:裸 id` 存引用，
    // 一级下拉按 provider_id 分组。两者对不上，用户就会在 A 组里选到 B 组的配置。
    const groups = groupExecutorsByProvider([
      executor('uniapi:gpt-5', 'uniapi'),
      executor('uniapi:claude-opus-5', 'uniapi'),
      executor('deepseek:deepseek-v4-pro', 'deepseek'),
    ]);

    for (const group of groups) {
      for (const option of group.options) {
        expect(option.value.split(':')[0]).toBe(group.key);
      }
    }
    // 同名模型分属两个供应商时，value 靠作用域区分，人读名称交给 display_name
    expect(groups[0].options.map((option) => option.value)).toEqual([
      'uniapi:gpt-5',
      'uniapi:claude-opus-5',
    ]);
  });

  it('缺 provider_id / 空串 / 只有空白 → 未标注供应商，按首次出现位置排', () => {
    const groups = groupExecutorsByProvider([
      executor('a'),
      executor('b', 'uniapi'),
      executor('c', '   '),
    ]);
    // 保序划分：a 排在最前，所以「未标注供应商」这一组也在最前
    expect(groups.map((group) => group.key)).toEqual(['', 'uniapi']);
    expect(groups[0].label).toBe(UNLABELED_PROVIDER_LABEL);
    expect(groups[0].options.map((option) => option.value)).toEqual(['a', 'c']);
  });

  it('前后空白不另立一组', () => {
    const groups = groupExecutorsByProvider([executor('a', ' uniapi '), executor('b', 'uniapi')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('uniapi');
    expect(groups[0].options).toHaveLength(2);
  });

  it('没有 id 的执行者不成选项，也不会留下空供应商', () => {
    expect(groupExecutorsByProvider([{ provider_id: 'uniapi' }])).toEqual([]);
    const groups = groupExecutorsByProvider([executor('a', 'uniapi'), { provider_id: 'deepseek' }]);
    expect(groups.map((group) => group.key)).toEqual(['uniapi']);
  });

  it('label 用 display_name，缺了才落到 id', () => {
    const groups = groupExecutorsByProvider([executor('deepseek-flash', 'deepseek')]);
    expect(groups[0].options[0].label).toBe('deepseek-flash');

    const named = groupExecutorsByProvider([executor('deepseek-flash', 'deepseek', 'DeepSeek Flash')]);
    expect(named[0].options[0].label).toBe('DeepSeek Flash');
  });

  it('一个叶子都不剩就是空列表', () => {
    expect(groupExecutorsByProvider([])).toEqual([]);
  });

  it('初值恒等于快照里的第一条（保序划分）', () => {
    const list = [executor('first', 'deepseek'), executor('second', 'uniapi')];
    expect(firstOptionValue(groupExecutorsByProvider(list))).toBe('first');
  });

  it('groupContaining 认得出归属组，认不出就是 null', () => {
    const groups = groupExecutorsByProvider([executor('a', 'uniapi'), executor('b', 'deepseek')]);
    expect(groupContaining(groups, 'b')?.key).toBe('deepseek');
    expect(groupContaining(groups, 'nope')).toBeNull();
  });
});

describe('离线夹具的供应商分布', () => {
  it('夹具真的带来了多于一个供应商，否则两级下拉测不出联动', () => {
    const groups = groupExecutorsByProvider(buildMockSnapshot().executors ?? []);
    expect(groups.map((group) => group.key)).toEqual(['uniapi', 'deepseek', 'localFunction']);
    expect(groups.map((group) => group.options.length)).toEqual([3, 1, 1]);
    // 第一条仍然是 config-001：默认选中的配置不变
    expect(firstOptionValue(groups)).toBe('config-001');
  });
});
