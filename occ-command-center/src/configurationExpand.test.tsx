/**
 * 配置舱：**结构全部来自后端那棵树**（`snapshot.console`）
 *
 * 前端只出渲染器——它不分组、不补兜底桶、不拼路径。所以这里验的是
 * "拿到那棵树之后画成了什么"，不是"前端怎么组织它"。
 *
 * 三件事：
 * - 一级并排铺开，**包默认收着**，双击才把它声明的那几条铺出来；
 * - 收起时画布上没有条目，但总数照实说（不能因为没展开就不报）；
 * - 带着某个引用进来时，它必须看得见，不能被静默回落到别处。
 */

import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { ConfigurationScene } from './scenes/ConfigurationScene/ConfigurationScene';
import { projectLiveConfiguration } from './core/projection/LiveConfigurationProjection';
import { buildMockSnapshot } from './mock/snapshot';
import { doubleTapNode, tapNode } from './test/interactions';
import { useSelectionStore } from './store/selectionStore';
import type { Node, ResourceKind, ResourceNode } from './core/types/node';
import type { GatewaySnapshot } from './api/gateway';

const SNAPSHOT = buildMockSnapshot();

/** 投影输出是节点联合类型，按资料类别取子集 */
function ofKind(nodes: Node[], kind: ResourceKind): ResourceNode[] {
  return nodes.filter(
    (node): node is ResourceNode => node.type === 'resource' && node.resource_kind === kind
  );
}

function nodeIds(): string[] {
  return Array.from(document.querySelectorAll('.react-flow__node')).map(
    (element) => element.getAttribute('data-id') ?? ''
  );
}

function idsMatching(prefix: string): string[] {
  return nodeIds().filter((id) => id.startsWith(prefix));
}

describe('配置舱的一级节点', () => {
  it('默认画智能体、包、供应商；条目收在包里', () => {
    render(<ConfigurationScene configurationId="" snapshot={SNAPSHOT} />);

    // 智能体是一级，**直接展示**——它不是"某个包里的东西"，是配置舱最常动手的对象
    expect(nodeIds()).toEqual(expect.arrayContaining(['agent.ops']));
    expect(nodeIds()).toEqual(expect.arrayContaining(['ext-001']));
    expect(nodeIds()).toEqual(expect.arrayContaining(['provider:uniapi']));
    // 条目是真二级：收在包里，默认一个都不画
    expect(idsMatching('cap-')).toEqual([]);
    expect(idsMatching('config-')).toEqual([]);
  });

  it('双击包就地展开它声明的条目，不把别人的带出来', () => {
    render(<ConfigurationScene configurationId="" snapshot={SNAPSHOT} />);

    doubleTapNode('ext-002');

    // ext-002 只声明了 cap-003；cap-001/002 在 ext-001 里
    expect(idsMatching('cap-').sort()).toEqual(['cap-003']);
    expect(idsMatching('config-')).toEqual([]);
  });

  it('再双击一次收起', () => {
    render(<ConfigurationScene configurationId="" snapshot={SNAPSHOT} />);

    doubleTapNode('ext-002');
    expect(idsMatching('cap-')).toEqual(['cap-003']);

    doubleTapNode('ext-002');
    expect(idsMatching('cap-')).toEqual([]);
  });

  it('双击供应商打开的是它的模型目录，一个模型都不铺到画布上', () => {
    render(<ConfigurationScene configurationId="" snapshot={SNAPSHOT} />);

    doubleTapNode('provider:uniapi');

    const panel = document.querySelector('[data-provider-catalog]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('qwen-max');
  });

  it('换个供应商再双击，小窗换成那一家的目录', () => {
    render(<ConfigurationScene configurationId="" snapshot={SNAPSHOT} />);

    doubleTapNode('provider:uniapi');
    doubleTapNode('provider:deepseek');

    const panel = document.querySelector('[data-provider-catalog]');
    expect(panel?.textContent).toContain('deepseek-v4-pro');
    expect(panel?.textContent).not.toContain('qwen-max');
  });

  it('打开供应商的小窗不影响包那边的展开', () => {
    render(<ConfigurationScene configurationId="" snapshot={SNAPSHOT} />);

    doubleTapNode('ext-002');
    doubleTapNode('provider:uniapi');

    expect(idsMatching('cap-')).toEqual(['cap-003']);
    expect(document.querySelector('[data-provider-catalog]')).not.toBeNull();
  });

  it('画布上没有「无供应商」这样一个节点', () => {
    /*
      它曾经在那儿：那是"执行者按供应商分出来的组"的兜底桶，桶底是不带模型的
      执行者。**那不是一家供应商**——用一棵树表达一个分组，等于在画布上造一个
      不存在的东西。供应商那一栏现在是"声明的那些，一个不多一个不少"。
    */
    const model = projectLiveConfiguration(SNAPSHOT, '');

    expect(model.providers.map((node) => node.id))
      .toEqual(['provider:uniapi', 'provider:deepseek']);
  });
});

describe('左上角那两块卡片', () => {
  it('上面说这一屏有多少，下面说你正看着的那一个', () => {
    /*
      混在一张卡上的时候，"总共几个"和"这一个怎么了"是同一个字号、同一个间距，
      扫一眼分不出哪几行在说全场景、哪几行在说手上这一格。
    */
    render(<ConfigurationScene configurationId="" snapshot={SNAPSHOT} />);

    const cards = () => document.querySelectorAll('[data-scene-overlay-stack] > div');

    // **没选中就没下面那块。** 没点任何东西的时候它无论说什么都是替用户挑了一个
    //（它以前回落到画布上的第一格，于是那格看起来像是被选中了，而用户没碰过它）
    expect(cards().length).toBe(1);
    const overview = cards()[0].textContent ?? '';
    expect(overview).toContain('智能体');
    expect(overview).toContain('供应商');
    expect(overview).not.toContain('意图');

    // 点一个包：下面那块才出现，说你正看着的那一个（连"在哪份文件里"一起报）
    act(() => { tapNode('ext-001'); });
    expect(cards().length).toBe(2);
    const detail = cards()[1].textContent ?? '';
    expect(detail).toContain('ext-001');
    expect(detail).toContain('ext-001/manifest.yaml');
    expect(detail).toContain('意图');

    // 点空白：它跟着收掉
    act(() => { useSelectionStore.setState({ selectedNodeId: null }); });
    expect(cards().length).toBe(1);
  });
});

describe('条目卡只说名字', () => {
  it('状态（意图 / 类型）都归左上角，卡片上不背', () => {
    /*
      条目一多，每张卡都背着一小段状态文字，整块画布就变成一片读不完的字。
      而"这一格现在什么样"这个问题，只有在正在看某一格的时候才有对象。
    */
    render(<ConfigurationScene configurationId="" snapshot={SNAPSHOT} />);
    act(() => { doubleTapNode('ext-001'); });

    const card = (id: string) =>
      document.querySelector(`.react-flow__node[data-id="${id}"]`)?.textContent ?? '';

    expect(card('config-001')).toContain('config-001');
    expect(card('config-001')).not.toContain('意图');
    expect(card('config-001')).not.toContain('Executor');
    // **名字只印一遍**：以前 label 和 summary 是同一个词，一行说两遍
    expect(card('config-001').split('config-001')).toHaveLength(2);

    // 点它：左上角那块卡把它的状态说全
    act(() => { tapNode('config-001'); });
    const detail =
      document.querySelectorAll('[data-scene-overlay-stack] > div')[1].textContent ?? '';
    expect(detail).toContain('执行者');
    expect(detail).toContain('意图');
    expect(detail).toContain('已启用');
  });
});

describe('配置舱投影', () => {
  it('包收着时条目不在画布上，但条数照实给', () => {
    const model = projectLiveConfiguration(SNAPSHOT, '');

    expect(model.providers).toHaveLength(2);
    expect(model.abilities.map((node) => node.id)).toEqual(['ext-001', 'ext-002', 'ext-003']);
    expect(ofKind(model.projection.nodes, 'capability')).toEqual([]);
    expect(ofKind(model.projection.nodes, 'executor-config')).toEqual([]);
    // 包上写着它声明了几条——收起时也看得出这一格背后有多少东西
    expect(model.abilities.every((node) => (node.child_count ?? 0) > 0)).toBe(true);
  });

  it('包的**身份是目录名，标题是清单里那个名字**', () => {
    /*
      以前这个节点是前端拿"供给"现造的，身份成了 `supply:ext-001`；包本身只在配置
      状态里露一个 `extension.ext-001` 的影子。**包在文件树里是一个目录。**

      两者都得在：目录名是**引用**（`tools_from` / `Task.executor_ref` / 删除都按它走，
      改不得），而人认的是自己写在清单里的那个名字。
    */
    const model = projectLiveConfiguration(SNAPSHOT, '');
    const node = model.abilities[0];

    expect(node.id).toBe('ext-001');
    expect(node.label).toBe('AWS Extension');
    // 它在磁盘上哪一份文件里——后端读出来的，不是前端按名字拼的
    expect(node.path).toBe('ext-001/manifest.yaml');
  });

  it('供应商那一格带的是它的模型目录，计数就是模型数', () => {
    const model = projectLiveConfiguration(SNAPSHOT, '');
    const uniapi = model.providers.find((node) => node.id === 'provider:uniapi');

    expect(uniapi?.catalog?.models.map((entry) => entry.name))
      .toEqual(['qwen-max', 'deepseek-v3']);
    expect(uniapi?.child_count).toBe(2);
  });

  it('展开的条目进入画布并连上声明它的包', () => {
    const model = projectLiveConfiguration(SNAPSHOT, '', new Set(['ext-002']));

    const shownCaps = ofKind(model.projection.nodes, 'capability').map((node) => node.id).sort();
    expect(shownCaps).toEqual(['cap-003']);
    const declares = model.projection.relations.filter((relation) => relation.type === 'declares');
    expect(declares.map((relation) => [relation.source, relation.target]))
      .toEqual([['ext-002', 'cap-003']]);
  });

  it('执行者和供应商之间是引用连线，只连给**真的引用了**的那几条', () => {
    // 展开 ext-001 才看得到它名下的执行者（夹具把所有执行者都挂在它下面）
    const model = projectLiveConfiguration(SNAPSHOT, '', new Set(['ext-001']));
    const provides = model.projection.relations.filter((relation) => relation.type === 'provides');

    // config-001/002/005 用的是 uniapi，config-003 是 deepseek；
    // config-004 不带模型，**不连给任何一家**
    expect(provides.map((relation) => [relation.source, relation.target]).sort())
      .toEqual([
        ['provider:deepseek', 'config-003'],
        ['provider:uniapi', 'config-001'],
        ['provider:uniapi', 'config-002'],
        ['provider:uniapi', 'config-005'],
      ]);
  });

  it('不画没在画布上的东西的连线', () => {
    // 包收着 -> 它名下的执行者一个都不在画布上 -> 一条 provides 都不该有
    const model = projectLiveConfiguration(SNAPSHOT, '');

    expect(model.projection.relations.filter((relation) => relation.type === 'provides'))
      .toEqual([]);
  });

  it('带着引用进来时，焦点落在它自己身上，不静默回落到第一格', () => {
    // 从「条目」进来：它收在包下面，得先把那个包展开
    const byCapability = projectLiveConfiguration(SNAPSHOT, 'cap-003');
    expect(byCapability.focused?.id).toBe('cap-003');
    expect(byCapability.abilities.find((node) => node.id === 'ext-002')?.expanded).toBe(true);

    // 从「智能体」进来：它是一级，不需要谁替它展开
    const byAgent = projectLiveConfiguration(SNAPSHOT, 'agent.ops');
    expect(byAgent.focused?.id).toBe('agent.ops');
  });

  it('聚焦供应商时聚合它名下配置的引用，不因为聚焦的是供应商就说没有', () => {
    const single = projectLiveConfiguration(SNAPSHOT, 'config-001').referencedByTaskIds;
    const aggregated = projectLiveConfiguration(SNAPSHOT, 'provider:uniapi').referencedByTaskIds;

    expect(single.length).toBeGreaterThan(0);
    expect(aggregated).toEqual(expect.arrayContaining(single));
  });

  it('被停用的那条执行者仍然看得见，而且开关拨得回来', () => {
    /*
      它公开目录里没有（那份清单答的是"能不能被新建引用"），配置状态里却还留着
      那一行。**所以它照样是一个条目**——画出来才拨得回开关，只画公开目录的话，
      「停用」就是一道单向门。
    */
    const model = projectLiveConfiguration(SNAPSHOT, '', new Set(['ext-001']));
    const node = model.projection.nodes.find((item) => item.id === 'uniapi:legacy-research');

    expect(node).toBeDefined();
    expect(node?.type === 'resource' && node.config?.activation).toBe('disabled');
    // 公开目录里确实没有它——这条断言同时在说"两件事不是一回事"
    expect((SNAPSHOT.executors ?? []).some((item) => item.id === 'uniapi:legacy-research'))
      .toBe(false);
  });
});

describe('离线夹具与后端同源', () => {
  it('夹具的树与它自己的声明对得上', () => {
    /*
      离线那份 `console` 是**从同一份声明夹具现算**的，不是另手写一份——
      两份数据一定会漂移，而配置舱只读这一份。
    */
    const tree = SNAPSHOT.console ?? [];
    const packages = tree.filter((node) => node.kind === 'package');
    const declared = new Map((SNAPSHOT.declarations ?? []).map((item) => [String(item.id), item]));

    expect(packages.length).toBeGreaterThan(0);
    for (const item of packages) {
      const declaration = declared.get(item.name);
      expect([item.name, declaration !== undefined]).toEqual([item.name, true]);
      expect(item.nodes?.length).toBe(
        ((declaration?.tools ?? []) as unknown[]).length
        + ((declaration?.executors ?? []) as unknown[]).length);
    }
  });
});

/** 只用到类型，别让 lint 说它没被读过 */
export type _Snapshot = GatewaySnapshot;
