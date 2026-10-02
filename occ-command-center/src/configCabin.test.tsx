/**
 * 配置舱：配置状态（意图 + 观测 + 诊断）与智能体
 *
 * 这一版要能说出来的话是三句，而它们以前长得一模一样：
 *
 *   用户停用   → 配置状态说「意图：已停用」
 *   它坏了     → 诊断说「它为什么没起来」（意图仍然是「已启用」）
 *   它起不来且代码已经进过进程 → 还要说「重启后端才卸得掉」
 *
 * 做法是把「意图」和「观测」当成**两个字段**：合成一个布尔值之后，
 * 「你要它开着，但它起不来」就退化成「它被停用了」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ConfigurationScene } from './scenes/ConfigurationScene/ConfigurationScene';
import { projectLiveConfiguration } from './core/projection/LiveConfigurationProjection';
import { referenceStateOf } from './core/projection/referenceState';
import { buildMockSnapshot } from './mock/snapshot';
import { doubleTapNode, tapNode } from './test/interactions';
import { activationFailureText, configColumns, diagnosticColumn, referenceStateText } from './lib/nodeVisual';
import { executeConfigCommand } from './lib/objectCommands';
import { ReferencePlaceholder } from './components/ui/ReferencePlaceholder';
import { AgentEditorOverlay } from './components/overlay/AgentEditorOverlay';
import { useSelectionStore } from './store/selectionStore';
import { agentManifest, type GatewayObject, type GatewaySnapshot } from './api/gateway';
import type { Command } from './core/types/projection';

const SNAPSHOT = buildMockSnapshot();

/** 夹具里被用户停用的那个 profile（只剩配置状态里那一行） */
const DISABLED_EXECUTOR = 'uniapi:legacy-research';

/** 一条配置状态的记录；只写这个用例关心的字段，其余给中性的默认值 */
function objectRow(over: Partial<GatewayObject> & { object_ref: string }): GatewayObject {
  return {
    kind: 'package',
    activation: 'enabled',
    observed: '',
    health: '',
    source: 'seed',
    seed_value: true,
    last_error: '',
    diagnostic: null,
    ...over,
  };
}

/**
 * 「用户要它开着，但它起不来」
 *
 * 包里没有任何注册记录（ADR-029：加载失败就不会进来），配置状态里却有一行
 * 说用户是开着它的，还带着一条诊断。这就是那句以前说不出来的话。
 */
const BROKEN_SNAPSHOT: GatewaySnapshot = {
  ...SNAPSHOT,
  objects: [
    ...(SNAPSHOT.objects ?? []),
    objectRow({
      object_ref: 'extension.weather',
      diagnostic: {
        stage: 'import',
        error_type: 'ModuleNotFoundError',
        message: '缺少依赖 requests',
        imported: false,
        created_at: '2026-09-25T02:00:00Z',
      },
    }),
  ],
};

const CONFIG_SWITCH: Command = {
  id: 'config-disable',
  label: '停用',
  type: 'config-disable',
  highRisk: true,
  preview: { impact: 'activation: enabled → disabled', transition: '它不再可用', reversible: true },
};

/**
 * 记录每一次网关命令
 *
 * 桩打在 **HTTP 一层**，不打在 `sendGatewayCommand` 的模块边界上：组件内部
 * 那条链在自己模块里调用它，模块边界的桩拦不住（`newTask.test.tsx` 的说明
 * 记着同一条教训）。打到 HTTP 一层，测到的才是真正会跑的那段代码。
 */
function stubGateway(responses: Record<string, unknown>) {
  const calls: { command: string; taskId: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    // 没有 body 的是对象重读（`GET /api/objects/{ref}`）
    if (!init?.body) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          kind: '', name: '', state: 'unknown', detail: '系统里没有这个引用的任何记录',
          readable: false, referable: false,
        }),
      };
    }
    // **命令面只有两个字段**：命令名 + 载荷（`task_id` 是载荷的一部分）
    const request = JSON.parse(String(init.body)) as {
      command: string;
      payload?: Record<string, unknown>;
    };
    const payload = request.payload ?? {};
    calls.push({ command: request.command, taskId: String(payload.task_id ?? ''), payload });
    const body = (responses[request.command] ?? { ok: true, data: {} }) as { ok?: boolean };
    // **拒绝是 400**：新后端把"校验没过"和"服务端自己炸了"分开说，
    // 前端照着分开处理（`sendGatewayCommand` 把它翻成 CommandRejectedError）
    const rejected = body.ok === false;
    return { ok: !rejected, status: rejected ? 400 : 200, json: async () => body };
  }));
  return calls;
}

beforeEach(() => {
  // 选中态是全局的：上一个用例选中的节点会让这一个用例的轻点变成「取消选中」
  useSelectionStore.setState({ selectedNodeId: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('配置状态的两栏', () => {
  it('用户停用说的是「意图」，与「它坏了」是两句不同的话', () => {
    // 用户停用：只有意图那一句，没有诊断
    const disabled = configColumns(objectRow({
      object_ref: `executor.${DISABLED_EXECUTOR}`,
      kind: 'executor',
      activation: 'disabled',
    }));
    expect(disabled).toEqual([{ label: '意图', value: '已停用', tone: 'warning' }]);

    // 它坏了：意图仍然说「已启用」，观测说「失败」，诊断另说为什么——三句，不合并
    const broken = objectRow({
      object_ref: 'extension.weather',
      activation: 'enabled',
      observed: 'failed',
      diagnostic: {
        stage: 'import', error_type: 'x', message: '缺少依赖 requests',
        imported: false, created_at: '',
      },
    });
    expect(configColumns(broken).map((column) => `${column.label}:${column.value}`))
      .toEqual(['意图:已启用', '观测:失败']);
    // **诊断不在卡片上**：一句报错印在每张卡上，整块画布就是一片读不完的字
    expect(diagnosticColumn(broken)?.label).toBe('诊断');
    expect(diagnosticColumn(broken)?.value).toContain('缺少依赖 requests');
    // 没坏就没有这一句——不补一个空的
    expect(diagnosticColumn(objectRow({ object_ref: 'extension.x' }))).toBeNull();
  });

  it('观测为空串时不画那一格：没有可观测的东西，不是「未知」', () => {
    // 执行者/智能体没有生命周期，observed 是空串
    expect(configColumns(objectRow({ object_ref: 'executor.x', kind: 'executor' })))
      .toEqual([{ label: '意图', value: '已启用', tone: 'default' }]);

    // 有生命周期的东西照实给观测，且它和意图是两栏
    const columns = configColumns(objectRow({ object_ref: 'extension.x', observed: 'failed' }));
    expect(columns.map((column) => `${column.label}:${column.value}`)).toEqual([
      '意图:已启用', '观测:失败',
    ]);
  });

  it('没有配置状态那一行就什么都不画：不补一个「已启用」冒充用户的选择', () => {
    expect(configColumns(undefined)).toEqual([]);
  });

  it('诊断全文在左上角说，不印在节点卡片上', () => {
    render(<ConfigurationScene configurationId="" snapshot={BROKEN_SNAPSHOT} />);

    /*
      **卡片上没有「诊断」那一栏了**：一句报错可能是一整段，而卡片上那一格只有
      十几个字宽——印上去的结果是每张卡都矮一截、字挤成几行，整块画布变成一片
      读不完的字。坏了的东西观测那一栏是红色的「失败」，一眼看得出哪一格有问题。

      （节点上那个「解析不到引用」的占位是另一回事：它说的是"这条引用读不回来"，
        只有那几格挂着它，而且它是那一格唯一的线索。）
    */
    expect(screen.queryAllByText('诊断')).toEqual([]);

    // 点它，左上角那块「场景事实」就把全文说出来——**不截断**
    act(() => { tapNode('extension.weather'); });
    expect(screen.getAllByText('诊断').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/缺少依赖 requests/).length).toBeGreaterThan(0);
  });

  it('左上角跟着选中的走，说的是这一格的意图与观测', () => {
    render(<ConfigurationScene configurationId="" snapshot={BROKEN_SNAPSHOT} />);

    // 没点的时候说的是场景自己（第一格）
    expect(screen.queryAllByText('已启用').length).toBeGreaterThan(0);

    // 点被停用的那条：左上角换成**它**的意图，而不是继续念第一格
    doubleTapNode('ext-001');
    act(() => { tapNode(DISABLED_EXECUTOR); });

    expect(screen.getAllByText('已停用').length).toBeGreaterThan(0);
    expect(screen.getAllByText(DISABLED_EXECUTOR).length).toBeGreaterThan(0);
  });

  it('只剩配置状态那一行的对象仍然画出来，否则「停用」是单向门', () => {
    // 它在**声明它的那个包里**（公开目录里没有它，声明里还在——那正是"被用户停用"
    // 的样子），展开就看得见。拨回去的那一行就在那儿，不必先猜它藏在哪一家底下。
    const model = projectLiveConfiguration(SNAPSHOT, '', new Set(['ext-001']));
    const placeholder = model.projection.nodes.find((node) => node.id === DISABLED_EXECUTOR);

    expect(placeholder).toBeDefined();
    // 最小占位：引用 + 已下线 + 原因；没有伪造的名称
    expect(placeholder?.type === 'resource' && placeholder.label).toBe(DISABLED_EXECUTOR);
    expect(placeholder?.type === 'resource' && placeholder.reference?.state).toBe('offline');
    expect(placeholder?.type === 'resource' && placeholder.reference?.reason).toContain('停用');
    // 开关拨得回来：装这一行的资料节点给的是「启用」（当前是停用）
    expect(placeholder?.type === 'resource' && placeholder.config?.activation).toBe('disabled');
  });
});

describe('开关失败时要说的话', () => {
  it('失败但意图仍在：说清「已接受但没生效」，还要说重启那一句', () => {
    // 要关而没关掉：已禁用，但代码已经进来了
    const disable = activationFailureText({
      enabled: false, status: 'failed', diagnostic: '卸不掉', restart_required: true,
    });
    expect(disable).toContain('已禁用');
    expect(disable).toContain('重启后端');
    expect(disable).toContain('卸掉');

    // 要开而没开起来：**不能**说「已禁用」（上面那一栏写的是「已启用」），
    // 但重启那一句照样要说
    const enable = activationFailureText({
      enabled: true, status: 'failed', diagnostic: '缺少依赖 requests', restart_required: true,
    });
    expect(enable).toContain('没有起来');
    expect(enable).toContain('重启后端');
    expect(enable).not.toContain('已禁用');

    // 没有 restart_required 时不说重启：它根本没被加载进来
    const plain = activationFailureText({
      enabled: true, status: 'failed', diagnostic: 'manifest 校验失败', restart_required: false,
    });
    expect(plain).toContain('manifest 校验失败');
    expect(plain).not.toContain('重启');

    // 成功了就没有保留
    expect(activationFailureText({ enabled: true, status: 'loaded' })).toBeNull();
  });

  it('开关是**改声明里那一行**，回执只说"已提交"', async () => {
    /*
      新模型里没有"配置状态"那一份记录：关掉一个东西就是改它声明里的 `enabled`。
      所以回执**不报**"生效了没有"——那由重读的快照说（`intentColumns` 那两列）。
      命令只有两种下场：写进去了，或者被拒（400，带原因）。
    */
    const calls = stubGateway({ set_enabled: { ok: true, data: {} } });

    const outcome = await executeConfigCommand(CONFIG_SWITCH, objectRow({
      object_ref: 'extension.weather', activation: 'disabled',
    }));

    expect(outcome).toEqual({ submitted: true, ok: true });
    expect(calls[0]).toEqual({
      command: 'set_enabled',
      taskId: '',
      payload: { target: 'package', name: 'weather', enabled: false },
    });
  });

  it('被拒绝时显示后端给的原因，不显示成已接受', async () => {
    stubGateway({
      set_enabled: { ok: false, error: 'weather 的 manifest 校验没过: 缺少 entrypoint' },
    });

    const outcome = await executeConfigCommand(CONFIG_SWITCH, objectRow({
      object_ref: 'extension.weather', kind: 'package',
    }));

    expect(outcome).toEqual({
      submitted: true, ok: false, error: 'weather 的 manifest 校验没过: 缺少 entrypoint',
    });
  });

  it('关掉了但代码还在进程里：那一列要说出来', () => {
    /*
      包内实现的工具是**跑在宿主进程里**的 Python。禁用会把它从列表里摘掉，
      但已经 import 的模块要重启才真的卸掉——这一句得在节点上说，
      否则用户会以为"关掉"等于"它没了"。

      它**不再挂在开关的回执上**：那是"当前生效失败"的旧说法（配置状态库的产物），
      而新模型里"代码还在"是这件事的正常后果，不是一次失败。
    */
    const columns = configColumns(objectRow({
      object_ref: 'extension.weather', activation: 'disabled', restart_required: true,
    }));
    const residual = columns.find((column) => column.label === '残留');
    expect(residual?.value).toContain('重启');

    // 没加载过代码的（执行者那类）不说这一句
    expect(configColumns(objectRow({
      object_ref: 'executor.weather.collect', kind: 'executor', activation: 'disabled',
    })).some((column) => column.label === '残留')).toBe(false);
  });

  it('开关命令带的是**哪个容器、哪个名字、什么方向**', async () => {
    const calls = stubGateway({ set_enabled: { ok: true, data: {} } });

    await executeConfigCommand(CONFIG_SWITCH, objectRow({
      object_ref: 'extension.weather', kind: 'package', activation: 'enabled',
    }));

    expect(calls[0]).toEqual({
      command: 'set_enabled', taskId: '',
      payload: { target: 'package', name: 'weather', enabled: false },
    });
  });

  it('执行者的开关是**整列重写**（它是包里的条目，不是顶层那一行）', async () => {
    const calls = stubGateway({ 'manifest.write': { ok: true, data: {} } });

    await executeConfigCommand(CONFIG_SWITCH, objectRow({
      object_ref: 'executor.weather.collect', kind: 'executor', activation: 'enabled',
    }), [{
      id: 'weather', enabled: true, name: '天气',
      tools: [], executors: [{ name: 'weather.collect', enabled: true,
                               worker: { entrypoint: 'worker.py:collect' } }],
    }]);

    const payload = calls[0].payload as { field: string; value: { name: string; enabled: boolean;
                                                                  worker: unknown }[] };
    expect(calls[0].command).toBe('manifest.write');
    expect(payload.field).toBe('executors');
    // **整列交回去，而且一个字都不许丢**（worker 那一段必须还在）
    expect(payload.value).toEqual([
      { name: 'weather.collect', enabled: false, worker: { entrypoint: 'worker.py:collect' } },
    ]);
  });
});

describe('智能体是一等对象', () => {
  it('节点带模型引用与逐工具三列，工具由包集并集而来', () => {
    const model = projectLiveConfiguration(SNAPSHOT, '');
    const agent = model.agents.find((node) => node.id === 'agent.ops');

    expect(agent).toBeDefined();
    expect(agent?.agent?.model.state).toBe('resolvable');
    expect(agent?.agent?.packages).toEqual(['ext-001']);
    // ext-001 声明 cap-001 / cap-002；agent.ops 自己收紧了 cap-002
    expect(agent?.agent?.tools.map((tool) => tool.tool_id)).toEqual(['cap-001', 'cap-002']);
    expect(agent?.agent?.tools[1]).toEqual({
      tool_id: 'cap-002', declared: false, effective: true, tightened_by_agent: true,
    });
  });

  it('编辑页每一行给的是**权限本身**：选中的那个就是生效值', () => {
    /*
      以前并排三列（声明 / 生效 / 我收紧的），读的人得自己在三个值之间推关系。
      回答的其实只有一件事：调这条工具之前要不要先问你——所以那一格就是这两个
      权限值本身。

      谁能改也一眼看得出：**改得动的是我定的，改不了的是包定的**。
    */
    render(<ConfigurationScene configurationId="agent.ops" snapshot={SNAPSHOT} />);

    act(() => { tapNode('agent.ops'); });
    act(() => { fireEvent.click(screen.getByText('编辑', { selector: 'button' })); });

    // 改的是哪个智能体、它的模型是什么，都要看得见
    expect(screen.getByText('编辑智能体')).toBeTruthy();
    expect(screen.getByText(/agent\.ops/)).toBeTruthy();

    // cap-002 声明不需要审批，我给它上了审批 → 那一格就是「要审批」
    const tightened = screen.getByLabelText('cap-002 的权限') as HTMLSelectElement;
    expect(tightened.value).toBe('approve');
    expect(tightened.disabled).toBe(false);

    // cap-001 我没动过它，声明也不要审批 → 那一格是「不用审批」
    const untouched = screen.getByLabelText('cap-001 的权限') as HTMLSelectElement;
    expect(untouched.value).toBe('free');

    // 改一格 = 改这一条工具的收紧名单
    fireEvent.change(untouched, { target: { value: 'approve' } });
    expect(untouched.value).toBe('approve');
  });

  it('认出来是智能体的包，就不再在「扩展」带里出现第二次', () => {
    /*
      智能体是一个包（`manifest.create` 建的包目录），所以它在 `console` 声明树里
      也是 `kind === 'package'`；而它同时是注册表里一条 `based_on` 非空的执行者
      （`snapshot.agents`）。两处都收的话，同一个东西在配置舱里画两遍。

      **拿掉整个包是安全的**：智能体不对外提供工具——它的 `tools_from` 引用的是
      别人家的供给，自己那个包里只有一条 `executor:`。
    */
    const agent = (SNAPSHOT.agents ?? [])[0];
    const consoleWithAgentPackage = [
      ...(SNAPSHOT.console ?? []),
      { kind: 'package' as const, name: agent.package },
    ];

    const model = projectLiveConfiguration({ ...SNAPSHOT, console: consoleWithAgentPackage });

    // 它作为智能体照常出现
    expect(model.agents.some((node) => node.id === agent.agent_ref)).toBe(true);
    // 但不再作为扩展包出现第二次
    expect(model.abilities.some((node) => node.id === agent.package)).toBe(false);

    // 对照：同一个包名，只要它**不是**智能体，就照常出现在「扩展」带
    const control = projectLiveConfiguration({
      ...SNAPSHOT, agents: [], console: consoleWithAgentPackage,
    });
    expect(control.abilities.some((node) => node.id === agent.package)).toBe(true);
  });

  it('一个单位只有一格：智能体、它的包、它那条执行者配置是同一个东西', () => {
    /*
      真后端上这三样**同时在场**（实测的一份快照）：

        agent.weatherToday        智能体带那一格
        weatherToday              公开执行者目录里那条 `based_on` 非空的配置
        extension.weatherToday    声明树里那个包 + 配置状态里那一行

      三个名字指的是同一个包 —— 而它以前在画布上画了**三格**：智能体一格、一条
      "只剩配置状态那一行"的执行者配置、再加一个说「扩展包 · 已下线」的占位
      （那个包好好的，是漏登记把它算成了孤儿）。

      这里用 `agent.ops` 造出同样的三份：它既是智能体，也出现在公开执行者目录里，
      它的包在声明树和配置状态里各有一份。
    */
    const agent = (SNAPSHOT.agents ?? [])[0];
    const threeFaces: GatewaySnapshot = {
      ...SNAPSHOT,
      console: [...(SNAPSHOT.console ?? []),
        { kind: 'package' as const, name: agent.package, nodes: [] }],
      executors: [...(SNAPSHOT.executors ?? []),
        // 与 `mapLiveState` 的同一条换算：`id` 就是执行者名（裸 id），
        // `type: 'agent'` 说的就是 `based_on` 非空
        { id: agent.package, ref: agent.package, display_name: agent.label,
          type: 'agent', provider_id: 'uniapi', package: agent.package }],
      objects: [...(SNAPSHOT.objects ?? []),
        objectRow({ object_ref: `extension.${agent.package}`, kind: 'package' })],
    };

    const model = projectLiveConfiguration(threeFaces, '');
    const ids = model.projection.nodes.map((node) => node.id);

    // 它作为智能体出现，而且**只有一格**
    expect(ids.filter((id) => id === agent.agent_ref)).toHaveLength(1);
    // 不再作为执行者配置出现第二次
    expect(ids).not.toContain(agent.package);
    expect(model.executorConfigurations.map((node) => node.id)).not.toContain(agent.package);
    // 它那个包也不被当成"只剩配置状态那一行"的占位画出来
    expect(ids).not.toContain(`extension.${agent.package}`);

    // 三类的徽标各说各的：扩展包 / 智能体 / 供应商
    // （只挑资料节点：`projection.nodes` 是个联合类型，Task 那几类没有这一格）
    const byId = new Map(model.projection.nodes
      .filter((node) => node.type === 'resource')
      .map((node) => [node.id, node]));
    expect(byId.get(agent.agent_ref)?.category).toBe('智能体');
    expect(byId.get(model.abilities[0].id)?.category).toBe('扩展包');
    expect(byId.get(model.providers[0].id)?.category).toBe('供应商');
  });

  it('供应商那一格就是那个单位：声明文件与配置状态都不另画一格', () => {
    /*
      一家供应商的身份只有一份（`_providers/<name>.yaml`）：模型目录挂在那一格上，
      谁在用它的模型由 `provides` 连线说。

      同名的一个**包**和一家**供应商**是两件事（一个是代码目录，一份是连接 + 模型
      清单），所以这里不比名字——比的是"同一个单位会不会从另一条路上再画一格"：
      配置状态里那一行 `provider.<name>` 不该变成节点。
    */
    const withProviderRow: GatewaySnapshot = {
      ...SNAPSHOT,
      objects: [...(SNAPSHOT.objects ?? []),
        objectRow({ object_ref: 'provider.uniapi', kind: 'provider' })],
    };

    const ids = projectLiveConfiguration(withProviderRow, '')
      .projection.nodes.map((node) => node.id);

    expect(ids.filter((id) => id === 'provider:uniapi')).toHaveLength(1);
    expect(ids).not.toContain('provider.uniapi');
  });

  it('新建时基座默认落在第一项：不留「请选择」的空档', () => {
    /*
      留一个空档等于逼人点一下下拉，而"值是空的"这件事在这一格上没有任何意义
      ——一台执行者都没有的话，表单本来也交不出去（`canSubmit` 仍要求非空）。
      右边模型那一格早就自己填了第一项，两格行为不一致才像坏掉。
    */
    render(<AgentEditorOverlay agent={null} creating snapshot={SNAPSHOT} onClose={() => {}} />);

    const base = screen.getByLabelText('基座') as HTMLSelectElement;
    expect(base.value).toBe(SNAPSHOT.executors?.[0].ref);
    // 没有空值那一档：选哪一个都会真的改到值
    expect(Array.from(base.options).map((option) => option.value)).not.toContain('');
  });

  it('基座已不在系统里时，把它画成一格而不是静默换成第一项', () => {
    /*
      基础包被删了（或被停用）之后，定义里的 `executor:` 还指着它。受控的 select
      落到第一项上显示的话，那一格看起来选了 A、值却还是 B，而保存会把这个错位
      写回声明——和模型那一格同一条规矩：**现存的定义要看得见**。
    */
    const agent = {
      ...(SNAPSHOT.agents ?? [])[0],
      executor_config_ref: 'gone.executor',
    };
    render(<AgentEditorOverlay agent={agent} snapshot={SNAPSHOT} onClose={() => {}} />);

    const base = screen.getByLabelText('基座') as HTMLSelectElement;
    expect(base.value).toBe('gone.executor');
    expect(Array.from(base.options).map((option) => option.value)).toContain('gone.executor');
  });

  it('标识不合法：那一格当场报错，按钮旁边一直写着还差什么', () => {
    /*
      现场：新建智能体配置时点「保存」没有任何反应。根因是标识填了中文、
      校验不过、按钮被禁用——而 `handleSubmit` 第一行就是 `if (!canSubmit) return;`，
      所以既没发请求也没有报错，用户只能猜自己哪里填错了。

      按钮会禁用是设计，**静默**不是。所以两处都必须说话：
      不合格的那一格自己冒红，按钮旁边一直写着还差哪几格。
    */
    render(<AgentEditorOverlay agent={null} creating snapshot={SNAPSHOT} onClose={() => {}} />);

    // 一上来就说得清：名称和标识都还空着，那句「还差……」就是这句反馈的兜底
    expect(screen.getByText(/还差：/).textContent).toContain('名称');

    const 标识 = screen.getByPlaceholderText('ops-readonly');
    fireEvent.change(标识, { target: { value: '天气助手' } });

    // 填了不合法的东西 → 错在那一格上，而且说得清为什么
    expect(screen.getByRole('alert').textContent).toContain('只能字母数字');
    expect(标识.getAttribute('aria-invalid')).toBe('true');

    // 改对了 → 提示自己消失
    fireEvent.change(标识, { target: { value: 'weather-today' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('系统提示留空照样能保存：留空即继承基座', () => {
    /*
      后端的规矩本来就允许留空——`extensions/executors.py::configured()` 是
      `entry.prompt or base.prompt`，基座 `langgraph.agent` 也声明了 prompt.system。
      界面以前却要求它非空，**比后端更严**：用户合理地留空，保存按钮就永久禁用，
      而那一格上没有任何提示说它必填。
    */
    render(<AgentEditorOverlay agent={null} creating snapshot={SNAPSHOT} onClose={() => {}} />);

    const 名称 = screen.getByLabelText('名称');
    fireEvent.change(名称, { target: { value: '今日天气' } });
    fireEvent.change(screen.getByPlaceholderText('ops-readonly'), { target: { value: 'weather-today' } });

    const 系统提示 = screen.getByPlaceholderText('留空则用基座声明的那份系统提示');
    expect((系统提示 as HTMLTextAreaElement).value).toBe('');

    const 保存 = screen.getByText('保存', { selector: 'button' }) as HTMLButtonElement;
    expect(保存.disabled).toBe(false);
  });

  it('模型那一格由基座决定出不出现：一段写死的代码不问模型', () => {
    /*
      后端的规矩（`extensions/executors.py::check`）：基座写着 `needs_llm: true`
      而这条配置没给模型，**登记那一步就拒**。所以这段代码要模型就必须问。

      反过来，`needs_llm: false` 的基座（`weather.collect` 那种固定代码）问它要
      模型是假问题：填了没人读，而"选了模型"会让人以为这条配置归某个模型管。
    */
    render(<ConfigurationScene configurationId="agent.ops" snapshot={SNAPSHOT} />);
    act(() => { tapNode('agent.ops'); });
    act(() => { fireEvent.click(screen.getByText('编辑', { selector: 'button' })); });

    // config-001 要模型 → 问
    expect(screen.getByLabelText('模型')).toBeTruthy();

    // 换到 config-004（本地写死的那台）→ 不问，而且理由写在原来那一格的位置上
    fireEvent.change(screen.getByLabelText('基座'), { target: { value: 'config-004' } });
    expect(screen.queryByLabelText('模型')).toBeNull();
    expect(screen.getByText(/固定代码，不用模型/)).toBeTruthy();

    // 换回去 → 又问
    fireEvent.change(screen.getByLabelText('基座'), { target: { value: 'config-001' } });
    expect(screen.getByLabelText('模型')).toBeTruthy();
  });

  it('不要模型的基座，不填模型也能存：不给就不写那一栏', () => {
    /*
      没有模型就不该往声明里写 `model: {provider: "", name: ""}`——那是一份
      "看着配了模型、其实一个字段都没有"的声明，而且它会**盖掉基座自己声明过的
      模型**（`configured()` 里 model 是"配置优先、缺省继承基座"）。
    */
    render(<ConfigurationScene configurationId="agent.ops" snapshot={SNAPSHOT} />);
    act(() => { tapNode('agent.ops'); });
    act(() => { fireEvent.click(screen.getByText('编辑', { selector: 'button' })); });

    fireEvent.change(screen.getByLabelText('基座'), { target: { value: 'config-004' } });
    // 换基座那一刻，原来选的模型就被清掉了：它跟这条定义已经无关
    expect((screen.getByLabelText('基座') as HTMLSelectElement).value).toBe('config-004');

    const manifest = agentManifest({
      id: 'probe', label: '探针', description: '', base: 'config-004',
      modelRef: '', system_prompt: '你只读。', packages: [], tighten: [], creating: true,
    });
    const entry = (manifest.executors as Record<string, unknown>[])[0];
    expect('model' in entry).toBe(false);

    // 要模型的那条照写
    const withModel = agentManifest({
      id: 'probe', label: '探针', description: '', base: 'config-001',
      modelRef: 'uniapi:qwen-max', system_prompt: '你只读。', packages: [], tighten: [],
      creating: true,
    });
    const withModelEntry = (withModel.executors as Record<string, unknown>[])[0];
    expect(withModelEntry.model).toEqual({ provider: 'uniapi', name: 'qwen-max' });
  });

  it('下拉里每一格都自带底色：白底白字等于那一格看不见', () => {
    /*
      用户报的「基座是空的」，空的是**那层弹窗**：原生下拉的弹窗不在页面的背景
      里，`option` 不给底色就按操作系统的默认走（浅色主题下是白的）；而 `option`
      的文字颜色是从 `select` 继承来的——`text-white`。白底白字，一排全看不见。

      所以每一条 `option` 都得自己带 `bg-occ-bg`（其余下拉都是这么写的，基座漏了）。
      jsdom 里量不到颜色，量得到 class——而 class 正是漏掉的那一样。
    */
    render(<ConfigurationScene configurationId="agent.ops" snapshot={SNAPSHOT} />);
    act(() => { tapNode('agent.ops'); });
    act(() => { fireEvent.click(screen.getByText('编辑', { selector: 'button' })); });

    const options = Array.from(document.querySelectorAll('option'));
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect([option.textContent, option.className.includes('bg-occ-bg')])
        .toEqual([option.textContent, true]);
    }
  });

  it('编辑页的基座落在候选里：夹具的拼法要和真后端同形', () => {
    /*
      快照里执行者的引用是 `executor.name`（后端 `snapshot.py` 给的名字），
      定义里的基座也是同一个东西。夹具少写这一格，`<option>` 的 value 就全是
      空串：**下拉看着有内容，选哪一个都等于没选**（而编辑时当前基座落不到
      任何一格，那一格显示为空）。
    */
    render(<ConfigurationScene configurationId="agent.ops" snapshot={SNAPSHOT} />);
    act(() => { tapNode('agent.ops'); });
    act(() => { fireEvent.click(screen.getByText('编辑', { selector: 'button' })); });

    const base = screen.getByLabelText('基座') as HTMLSelectElement;
    expect(base.value).toBe('config-001');
    expect(Array.from(base.options).map((option) => option.value)).toContain('config-001');
  });

  it('能力钉死要审批的工具不给收紧（那是放宽的反方向，后端也会拒）', () => {
    render(<ConfigurationScene configurationId="agent.payments" snapshot={SNAPSHOT} />);

    act(() => { tapNode('agent.payments'); });
    act(() => { fireEvent.click(screen.getByText('编辑', { selector: 'button' })); });

    // cap-004 在夹具里声明必须审批：它不是「我收紧的」，而且改不了
    // （把它拨成「不用审批」是放宽的反方向，后端也会拒）
    const pinned = screen.getByLabelText('cap-004 的权限') as HTMLSelectElement;
    expect(pinned.value).toBe('approve');
    expect(pinned.disabled).toBe(true);
    // 锁着的那一格自己说明是谁定的——不然用户只会以为界面卡住了
    expect(pinned.options[0].textContent).toContain('扩展包钉死');
  });

  it('保存被拒时显示后端给的中文原因', async () => {
    /*
      保存 = **写一份声明**（`manifest.write`）：智能体就是一个包。
      后端拒绝时给一句中文原因，前端原样显示——裹成「保存失败」等于把那句话丢了。
    */
    stubGateway({
      'manifest.write': {
        ok: false,
        error: '这些工具的能力声明已经是「必须审批」，不能也不需要再收紧: cap-004',
      },
    });

    render(<ConfigurationScene configurationId="agent.ops" snapshot={SNAPSHOT} />);
    act(() => { tapNode('agent.ops'); });
    act(() => { fireEvent.click(screen.getByText('编辑', { selector: 'button' })); });
    await act(async () => {
      fireEvent.click(screen.getByText('保存', { selector: 'button' }));
    });

    expect(screen.getByText(/不能也不需要再收紧/)).toBeTruthy();
  });
});

describe('能力的权限编辑指向哪个包的哪个工具', () => {
  it('能力节点带所属包，编辑页把那两个名字都写出来', () => {
    render(<ConfigurationScene configurationId="cap-001" snapshot={SNAPSHOT} />);

    // 带着能力的引用进来，声明它的包自动展开（否则用户点的是一件事，看到的是另一件）
    expect(document.querySelector('.react-flow__node[data-id="cap-001"]')).toBeTruthy();

    act(() => { tapNode('cap-001'); });
    act(() => { fireEvent.click(screen.getByText('编辑权限', { selector: 'button' })); });

    // 包目录名与工具名同时可见：说不清这一步用户就不知道自己在动谁
    // （两处都有 `ext-001` 是对的——卡上那个节点、编辑页那一句，说的是同一个包）
    expect(screen.getAllByText(/ext-001/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/cap-001/).length).toBeGreaterThan(0);
  });

  it('可改字段只放开那几个，且布尔字段送真的是布尔值', async () => {
    const calls = stubGateway({ 'manifest.write': { ok: true, data: {} } });

    render(<ConfigurationScene configurationId="cap-001" snapshot={SNAPSHOT} />);
    act(() => { tapNode('cap-001'); });
    act(() => { fireEvent.click(screen.getByText('编辑权限', { selector: 'button' })); });

    /*
      字段清单就是**契约表允许的那一份**。`risk_level` / `cancellable` /
      `target_type` / `function_name` 现在是**未知键**——写进去会被写前校验拒掉，
      所以界面上根本不该放它们出来（从前它们在这里，后端一律拒）。
    */
    const fields = Array.from(
      (screen.getByLabelText('字段') as HTMLSelectElement).options
    ).map((option) => option.value);
    expect(fields).toEqual(['approval_required', 'idempotency', 'enabled']);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('值'), { target: { value: 'true' } });
      fireEvent.click(screen.getByText('写入并重载', { selector: 'button' }));
    });

    /*
      改一条**列表里**的条目 = 整列交回去（声明只有顶层字段可改）。
      而且布尔字段送的是**真值**，不是字符串——写进 YAML 就成了一份语义漂移的声明。
      整列来自**快照给的声明原文**：`entrypoint` 那一栏一个字都不许丢。
    */
    expect(calls[0].command).toBe('manifest.write');
    const payload = calls[0].payload as { field: string; value: Record<string, unknown>[] };
    expect(payload.field).toBe('tools');
    // 条目名是**供给名**（工具全名里 `.` 前那半截），工具全名 = 供给名.函数名
    expect(payload.value[0]).toMatchObject({
      name: 'cap-001', approval_required: true, entrypoint: 'provider.py:cap-001',
    });
  });
});

describe('引用解析的三态', () => {
  it('offline 与 unknown 是两句不同的话', () => {
    // 系统知道它曾经是什么：被用户停用了
    const offline = referenceStateOf(DISABLED_EXECUTOR, SNAPSHOT);
    expect(offline.state).toBe('offline');
    expect(offline.object_ref).toBe(`executor.${DISABLED_EXECUTOR}`);

    // 系统不知道它是什么：连一条记录都没有
    const unknown = referenceStateOf('nobody:knows', SNAPSHOT);
    expect(unknown.state).toBe('unknown');
    expect(unknown.object_ref).toBe('');

    // 两句不同的话：一个说得出原因，一个只能承认不知道
    expect(offline.reason).not.toBe(unknown.reason);
    expect(referenceStateText(offline.state)).toBe('已下线');
    expect(referenceStateText(unknown.state)).toBe('未知');
  });

  it('智能体的两种拼法指同一个对象', () => {
    // `agent.ops` 是配置键，`agent:ops` 是执行者引用（与 uniapi:qwen-max 同形）
    expect(referenceStateOf('agent:ops', SNAPSHOT).state).toBe('resolvable');
    expect(referenceStateOf('agent.ops', SNAPSHOT).object_ref).toBe('agent.ops');
    expect(referenceStateOf('agent:ops', SNAPSHOT).object_ref).toBe('agent.ops');
  });

  it('人的执行者引用解析成已下线时给最小占位，不塌成「未知」', () => {
    const offline = referenceStateOf(DISABLED_EXECUTOR, SNAPSHOT);
    const unknown = referenceStateOf('nobody:knows', SNAPSHOT);

    const { unmount } = render(<ReferencePlaceholder view={offline} role="Executor" />);
    expect(screen.getByText('已下线')).toBeTruthy();
    // 占位把系统知道的那个键给出来（引用本身就是线索），原因也一起说
    expect(screen.getByText(`executor.${DISABLED_EXECUTOR}`)).toBeTruthy();
    expect(screen.getByText(/用户已停用它/)).toBeTruthy();
    unmount();

    render(<ReferencePlaceholder view={unknown} role="Executor" />);
    expect(screen.getByText('未知')).toBeTruthy();
    // unknown 说不出「它曾经是什么」：连键都没有
    expect(screen.queryByText(`executor.${DISABLED_EXECUTOR}`)).toBeNull();
    expect(screen.getByText(/没有这个引用的任何记录/)).toBeTruthy();
  });
});
