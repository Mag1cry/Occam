/**
 * 离线快照夹具
 *
 * 把 `src/mock/` 的既有数据装配成一份后端网关快照。它只服务两件事：
 *
 * 1. `VITE_DATA_SOURCE=mock` 的离线开发与截图；
 * 2. 测试里 stub `fetch` 的返回值。
 *
 * 关键在于它**走的是同一条运行时链路**：投影只认快照，没有第二套
 * 「原型分支」。所以离线跑通不等于另一套代码跑通，而是同一套代码
 * 在夹具数据上的结果。
 *
 * 形状对齐后端 `gateway.Gateway.snapshot()`。
 */

import type {
  ControlEvent,
  GatewayAbility,
  GatewayAgent,
  GatewayCapability,
  GatewayDispatch,
  GatewayExecutor,
  GatewayObject,
  GatewaySchedule,
  GatewaySnapshot,
} from '../api/gateway';
import { allCoreTasks } from './coreTasks';
import { mockCoreEvents } from './events';
import { mockExecutorConfigurations, mockExtensions, mockCapabilities, mockExtensionCapabilities } from './configurations';
import { mockOccurrences } from './scheduleChildren';
import { mockScheduleSeeds } from './schedules';

function scheduleFixtures(): GatewaySchedule[] {
  return mockScheduleSeeds.map((seed) => ({
    schedule_id: seed.id,
    name: seed.label,
    summary: seed.rule_summary,
    // 快照里的规则就是 cron 表达式本身（后端 automation store 的字段），
    // 人读的规则摘要由外围侧提供，两者不互相顶替
    cron: seed.cron,
    enabled: seed.enabled,
    executor_config_ref: '',
    task_ref: seed.id,
  }));
}

/**
 * 派发记录
 *
 * occurrence 在快照里的公开形态就是 DispatchRecord（外围派发，不等于执行成功）。
 * 触发时间缺失的 occurrence 不补时间，updated_at 留空。
 */
function dispatchFixtures(): GatewayDispatch[] {
  return Object.values(mockOccurrences)
    .flat()
    .map((occurrence) => ({
      occurrence_key: occurrence.occurrence_id,
      schedule_id: occurrence.schedule_id,
      task_ids: [occurrence.task_id],
      status: occurrence.dispatch_status === 'dispatched' ? 'dispatched' : 'unknown',
      updated_at: occurrence.triggered_at ?? undefined,
    }));
}

/**
 * 夹具里每条配置的供应商
 *
 * 后端由 `executor_loader.resolve_provider_id()` 定：manifest 的 `provider:`
 * 优先，没有声明且没有模型段的归 `localFunction`。夹具照这个分布编，
 * 好让两级下拉在离线模式下也有多于一个供应商可切。
 *
 * 不放进 `mock/configurations.ts`：那是投影资料（`projection.test.ts` 钉住了
 * 它的 id/label），供应商是网关快照的字段，属于这一层。
 */
/**
 * 供应商：怎么连 + 一张模型目录
 *
 * 新模型里**模型属于供应商**（`extensions/_providers/<name>.yaml` 的 `models[]`），
 * 所以智能体那个"用哪个模型"的选择器读的是这里，不是执行者列表。
 */
/*
  返回类型**不带那个 `?`**：快照上 `providers` 是可选字段，而夹具永远给一份数组。
  照抄快照的类型会让 `providerFixtures().map(...)` 变成"可能在 undefined 上取 map"。
*/
function providerFixtures(): NonNullable<GatewaySnapshot['providers']> {
  return [
    { name: 'uniapi', base_url: 'https://uniapi.example/v1', enabled: true,
      models: [{ name: 'qwen-max' }, { name: 'deepseek-v3' }] },
    { name: 'deepseek', base_url: 'https://api.deepseek.com/v1', enabled: true,
      models: [{ name: 'deepseek-v4-pro' }] },
  ];
}

const MOCK_PROVIDER_BY_CONFIG: Record<string, string> = {
  'config-001': 'uniapi',
  'config-002': 'uniapi',
  'config-003': 'deepseek',
  'config-004': 'localFunction',
  'config-005': 'uniapi',
  // 被停用的那条：它在公开目录里不出现，但配置状态里还留着它那一行
  'uniapi:legacy-research': 'uniapi',
};

function executorFixtures(): GatewayExecutor[] {
  // 被用户停用的 profile **不出现在这里**（后端 `_executors_snapshot` 就是这条规矩）：
  // 这是「能不能被新建引用」的清单，不等于「它不存在」。它仍然在 `objects` 里有一行，
  // 配置舱据此把它画成一个占位节点、把开关拨回来。
  return mockExecutorConfigurations
    .filter((config) => !MOCK_DISABLED_OBJECTS.has(`executor.${config.id}`))
    .map((config) => ({
      id: config.id,
      // **引用就是名字**，和真后端同一格（`snapshot.py` 给的是 `executor.name`）。
      // 少了它，`<option>` 的 value 全是空串——下拉看着有内容、选哪一个都等于没选。
      ref: config.id,
      display_name: config.label,
      description: config.summary ?? '',
      // 与真后端同一格：`snapshot.py` 里非智能体的执行者就是 'worker'
      type: 'worker',
      // 要模型的是跑 LLM 循环的那些；config-004（本地写死的那台）不用模型——
      // 后端的规矩是"登记时没有模型就拒"，所以这一格是真契约，不是显示偏好
      needs_llm: config.id !== 'config-004',
      provider_id: MOCK_PROVIDER_BY_CONFIG[config.id],
    }));
}

/**
 * 夹具里被用户停用的可配置对象
 *
 * 开关是**配置状态**里的一行（ADR-028），不是资料节点上的一个字段——所以它
 * 在这里，键就是配置状态的键（`extension.<id>` / `executor.<qualified>`）。
 * 与 `executorFixtures()` 的过滤同源：一处说它停用了，另一处就不能还列着它。
 */
const MOCK_DISABLED_OBJECTS = new Set<string>(['executor.uniapi:legacy-research']);

/**
 * 夹具里每个扩展包在后端的类别
 *
 * 真目录里 `type: executor` 底下有两种东西，靠**声明的 profile 数**分开：
 * 实现包一条都不声明（`executor_ids: []`），供应商目录
 * 带着整份模型清单。这里把两种都编进来，类别徽标才测得出区别。
 *
 * `capability_ids` 不在这里写：它必须和 `mockExtensionCapabilities` 同源，
 * 两处各写一遍迟早对不上。
 */
const MOCK_ABILITY_FACTS: Record<string, { type: string; executor_ids?: string[]; description: string }> = {
  'ext-001': { type: 'ability', description: 'AWS 云服务扩展' },
  'ext-002': { type: 'capability', description: '数据库访问扩展' },
  'ext-003': { type: 'ability', description: '支付网关扩展' },
  // 只声明执行者、不声明工具的包。**它照样单独成节点**：一个包和一家供应商
  // 是两件事（一个是代码目录，一份是连接 + 模型清单），谁也不是谁的第二格
  'ext-004': { type: 'executor', executor_ids: ['config-003'], description: '只声明执行者配置的包' },
};

function abilityFixtures(): GatewayAbility[] {
  return mockExtensions.map((extension) => {
    const declared = mockExtensionCapabilities[extension.id] ?? [];
    const facts = MOCK_ABILITY_FACTS[extension.id];
    return {
      ability: {
        // **与真后端同一个形状**：包的引用是 `extension.<目录名>`，不是裸目录名。
        // 夹具要是自己另用一种，离线跑绿的用例到真后端上会静默错位。
        ability_ref: `extension.${extension.id}`,
        kind: 'extension',
        version: '1',
        source: 'manifest',
        label: extension.label,
        // 能出现在注册表里的包都是加载着的：被停用的包**不加载**（ADR-029），
        // 它只会留在下面的 objects 视图里
        state: 'online',
        health: 'ok',
        metadata: {
          type: facts?.type ?? 'extension',
          description: facts?.description ?? extension.summary ?? '',
          enabled: true,
          diagnostics: [],
          executor_ids: facts?.executor_ids ?? [],
          // 与下面的 capabilities 同源：声明了几个就是几个
          capability_ids: declared,
        },
      },
      capabilities: declared,
      // `tools_from` 写的是**供给名**，不是配置状态里的引用——两件事
      supply: extension.id,
    };
  });
}

/**
 * 夹具里的工具，声明了哪个要审批
 *
 * 与 `mockCapabilities` 同源（工具清单只有一份）。支付这一类能力声明必须审批，
 * 好让智能体的工具三列在离线模式下也看得出差别：
 * 「这条是能力钉死的」「这条是我收紧的」「这条我没动」。
 */
const MOCK_APPROVAL_REQUIRED = new Set(['cap-004']);

function capabilityFixtures(): GatewayCapability[] {
  return mockCapabilities.map((capability) => ({
    tool_id: capability.id,
    function_name: capability.label,
    ability_ref: Object.keys(mockExtensionCapabilities).find((extensionId) =>
      (mockExtensionCapabilities[extensionId] ?? []).includes(capability.id)
    ) ?? '',
    approval_required: MOCK_APPROVAL_REQUIRED.has(capability.id),
    risk_level: MOCK_APPROVAL_REQUIRED.has(capability.id) ? 'high' : 'low',
    active: true,
  }));
}

/**
 * 智能体夹具
 *
 * 契约里的智能体 =（一个模型 + 一段 system_prompt + 一组扩展包 + 收紧后的权限）。
 * 两份定义各自展示一种工具三列：一个号自己收紧了 `cap-002`（声明说不用审批），
 * 一个号手上的 `cap-004` 是能力钉死要审批的——两种都不需要它自己再收紧。
 *
 * `tools` 的三列**由夹具算出来**，不是手写的：手写会和 `mockExtensionCapabilities`
 * 与 `MOCK_APPROVAL_REQUIRED` 漂开，而测试正靠它们看三列的区别。
 */
function agentFixtures(): GatewayAgent[] {
  const definitions = [
    { agent_ref: 'agent.ops', label: '只读员', model: 'uniapi:qwen-max',
      prompt: '你只读，不写。', packages: ['ext-001'], tighten: ['cap-002'],
      description: '只读的巡检员', package: 'ops' },
    { agent_ref: 'agent.payments', label: '支付员', model: 'deepseek:deepseek-v4-pro',
      prompt: '付款前必须说清金额和收款方。', packages: ['ext-003'], tighten: [],
      description: '处理支付', package: 'payments' },
  ];

  return definitions.map((definition, index) => {
    const toolIds = definition.packages.flatMap(
      (packageRef) => mockExtensionCapabilities[packageRef] ?? []);
    return {
      agent_ref: definition.agent_ref,
      label: definition.label,
      description: definition.description,
      package: definition.package,
      // 基座：基于哪段代码（**智能体的模型不在这一格**，它在 model_ref 里）
      executor_config_ref: 'config-001',
      model_ref: definition.model,
      system_prompt: definition.prompt,
      packages: definition.packages,
      parameters: {},
      revision: index + 1,
      tool_ids: toolIds,
      tools: toolIds.map((toolId) => {
        const declared = MOCK_APPROVAL_REQUIRED.has(toolId);
        const tightened = definition.tighten.includes(toolId);
        return {
          tool_id: toolId,
          declared,
          effective: declared || tightened,
          tightened_by_agent: tightened,
        };
      }),
      activation: 'enabled',
    };
  });
}

/**
 * 配置状态：每个可配置对象一行
 *
 * **意图（activation）与观测（observed）分开**——合成一个布尔值就说不清
 * 「你要它开着，但它起不来」。`observed` 对没有生命周期的对象（执行者 / 智能体）
 * 是空串：它们不是「问了答不上来」，而是没有可观测的东西。
 *
 * 夹具里没有「有诊断」的对象：诊断属于**运行期事实**，编一条假的会让所有
 * 拿它当证据的测试都在为不存在的数据鼓掌。需要那一格的用例自己带一份快照。
 *
 * 最后一行是**只剩下配置状态那一行**的智能体：定义被删了，那一行留着，
 * 于是历史引用能解析成「已下线」而不是「查不到」。配置舱把它画成最小占位。
 */
function objectFixtures(): GatewayObject[] {
  const rows: GatewayObject[] = [];

  for (const extension of mockExtensions) {
    rows.push({
      object_ref: `extension.${extension.id}`,
      kind: 'package',
      activation: 'enabled',
      observed: 'online',
      health: 'ok',
      source: 'seed',
      seed_value: true,
      last_error: '',
      // 没有诊断：null 表示**没有这一条**，不是「一切正常」
      diagnostic: null,
    });
  }

  for (const config of mockExecutorConfigurations) {
    const disabled = MOCK_DISABLED_OBJECTS.has(`executor.${config.id}`);
    rows.push({
      object_ref: `executor.${config.id}`,
      kind: 'executor',
      activation: disabled ? 'disabled' : 'enabled',
      // 执行者没有生命周期：没有可观测的东西，给空串（不是 unknown）
      observed: '',
      health: '',
      // 被用户停用的那一行是**用户**改过的，来源如实标出来
      source: disabled ? 'user' : 'seed',
      seed_value: true,
      last_error: '',
      diagnostic: null,
    });
  }

  for (const agent of agentFixtures()) {
    rows.push({
      object_ref: agent.agent_ref,
      kind: 'agent',
      activation: 'enabled',
      observed: '',
      health: '',
      source: 'seed',
      seed_value: true,
      last_error: '',
      diagnostic: null,
    });
  }

  rows.push({
    object_ref: 'agent.legacy',
    kind: 'agent',
    activation: 'enabled',
    observed: '',
    health: '',
    source: 'seed',
    seed_value: true,
    last_error: '',
    diagnostic: null,
  });

  return rows;
}

/**
 * 声明原文（离线模式那一边）
 *
 * 改一条**列表里**的条目要整列交回去，所以快照必须带着那一列。真后端给的是
 * 磁盘上那份声明；这里按同一形状造一份——**供给名就是工具全名里 `.` 前那半截**，
 * 与真后端同一条约定。
 */
/* 同 `providerFixtures`：快照上这一格可选，夹具永远给一份数组 */
function declarationFixtures(): NonNullable<GatewaySnapshot['declarations']> {
  const byPackage = new Map<string, { tools: Record<string, unknown>[]; executors: Record<string, unknown>[] }>();
  for (const item of capabilityFixtures()) {
    const packageId = extensionIdOfAbility(item.ability_ref ?? '');
    const bucket = byPackage.get(packageId) ?? { tools: [], executors: [] };
    bucket.tools.push({
      name: item.tool_id.split('.')[0],
      approval_required: item.approval_required ?? false,
      url: '',
      entrypoint: `provider.py:${item.tool_id.split('.')[0]}`,
      idempotency: 'safe-retry',
      enabled: true,
    });
    byPackage.set(packageId, bucket);
  }
  for (const executor of mockExecutorConfigurations) {
    const bucket = byPackage.get('ext-001') ?? { tools: [], executors: [] };
    bucket.executors.push({
      name: executor.id, enabled: true,
      worker: { entrypoint: 'worker.py:worker_entry' },
    });
    byPackage.set('ext-001', bucket);
  }
  return [...byPackage].map(([id, bucket]) => ({
    id, enabled: true, name: id, ...bucket,
  }));
}

/** `extension.ext-001` → `ext-001`（与 `ConfigurationScene` 那一处同一约定） */
function extensionIdOfAbility(abilityRef: string): string {
  return abilityRef.startsWith('extension.') ? abilityRef.slice('extension.'.length) : abilityRef;
}

/**
 * 配置舱那棵树（离线模式那一边）
 *
 * **与后端 `web/snapshot.py::_console` 同一条规则**：目录 / 包 / 条目 / 供应商 /
 * 模型，每个节点都带 `kind` 和它在磁盘上那份文件。这里从上面那几份夹具**现算**，
 * 不另编一份——离线模式下两份数据一样会漂移，而配置舱只读这一份。
 */
function consoleFixtures(): GatewaySnapshot['console'] {
  const directory = (name: string, nodes: NonNullable<GatewaySnapshot['console']>): NonNullable<GatewaySnapshot['console']>[number] =>
    ({ kind: 'directory', name, path: name, nodes });

  return [
    directory('_providers', providerFixtures().map((provider) => ({
      kind: 'provider' as const,
      name: provider.name,
      enabled: provider.enabled,
      path: `_providers/${provider.name}.yaml`,
      base_url: provider.base_url,
      nodes: (provider.models ?? []).map((model) => ({
        kind: 'model' as const,
        name: String((model as { name?: unknown }).name ?? ''),
        owned_by: String((model as { owned_by?: unknown }).owned_by ?? ''),
        nodes: [],
      })),
    }))),
    directory('_schedules', []),
    ...declarationFixtures().map((item) => ({
      kind: 'package' as const,
      name: String(item.id ?? ''),
      enabled: item.enabled !== false,
      path: `${String(item.id ?? '')}/manifest.yaml`,
      // 清单里的 `name:`。夹具用扩展的 label 当它（`ext-001` → `AWS Extension`）
      label: mockExtensions.find((ext) => ext.id === String(item.id))?.label
        ?? String(item.id ?? ''),
      description: mockExtensions.find((ext) => ext.id === String(item.id))?.summary ?? '',
      nodes: [
        ...((item.tools ?? []) as { name?: unknown }[]).map((tool) => ({
          kind: 'entry' as const, name: String(tool.name ?? ''),
          full: String(tool.name ?? ''), entries: ['tool'], nodes: [],
        })),
        ...((item.executors ?? []) as { name?: unknown }[]).map((executor) => ({
          kind: 'entry' as const, name: String(executor.name ?? ''),
          full: String(executor.name ?? ''), entries: ['executor'], nodes: [],
        })),
      ],
    })),
  ];
}

/** 离线快照：与后端 `GET /api/gateway/snapshot` 同形 */
export function buildMockSnapshot(): GatewaySnapshot {
  const events: Record<string, ControlEvent[]> = { ...mockCoreEvents };

  return {
    // 快照里的 tasks 已经是前端形状（api/gateway.ts 负责把后端形状映射过来），
    // 外层 Task 与 Schedule 子 Task 都是真实 Core Task，一起给。
    tasks: allCoreTasks,
    events,
    controllers: {},
    capabilities: capabilityFixtures(),
    abilities: abilityFixtures(),
    executors: executorFixtures(),
    providers: providerFixtures(),
    declarations: declarationFixtures(),
    // 配置舱那棵树：**结构由后端给**，所以离线这边也得有，而且与声明同源
    console: consoleFixtures(),
    // 配置舱的数据面：意图 + 观测 + 诊断，一个对象一行
    objects: objectFixtures(),
    // 智能体：定义 + 展开后的工具三列
    agents: agentFixtures(),
    /*
      **悬着的输出**：夹具里唯一一条——`task-002`（"部署生产环境"）停在待拍板。

      **手写一份，不在这儿重算**：派生的规则归后端（`gateway/output/output.py::for_task`），
      前端再算一遍就是第二条推导路径——而两条路径会漂开（真后端上"什么算悬着"
      变了，夹具却还是老样子的话，测试会为不存在的数据鼓掌）。
    */
    outputs: [
      {
        ref: 'task:task-002:approval',
        kind: 'approval',
        target_ref: 'task:task-002',
        title: '部署生产环境',
        summary: '要调用 `deploy.production`（approval:deploy.production）',
        actions: [
          { ref: 'approve', label: '批准', command: 'approve' },
          { ref: 'deny', label: '拒绝', command: 'deny' },
        ],
      },
    ],
    schedules: scheduleFixtures(),
    dispatches: dispatchFixtures(),
    mcp: [],
    devices: [],
    access: { principal_ref: 'local-owner', access_mode: 'trusted_local' },
  };
}
