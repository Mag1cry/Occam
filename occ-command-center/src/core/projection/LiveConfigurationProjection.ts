import type { GatewayAgent, GatewayObject, GatewaySnapshot, LiveConsoleNode } from '../../api/gateway';
import type { ResourceNode } from '../types/node';
import type { ProjectionOutput } from '../types/projection';
import { executorCatalog } from './executorCatalog';
import { offlineViewOf, referenceStateOf } from './referenceState';
import { agentExecutorRef, agentId } from '../../lib/agents';

export interface LiveConfigurationModel {
  focused: ResourceNode | null;
  /** 供应商节点：配置目录的一级 */
  providers: ResourceNode[];
  /**
   * 全部执行者配置（含未展开的供应商名下的、以及被停用后只剩配置状态那一行的）
   *
   * **不含智能体**：它们由智能体带那几格代表（见 `agentIdentities`），两处都收
   * 就是同一个单位数了两遍。
   */
  executorConfigurations: ResourceNode[];
  /** 扩展节点：可操作的一级 */
  abilities: ResourceNode[];
  /** 全部能力（含未展开的扩展名下的），用于计数 */
  capabilities: ResourceNode[];
  /** 智能体：配置舱里的一等对象（不是可进入的 Scene） */
  agents: ResourceNode[];
  referencedByTaskIds: string[];
  projection: ProjectionOutput;
}

/**
 * 布局
 *
 * 各占一条**带**，带内按列换行，从原点开始向下铺：
 *
 * ```
 * 智能体（一等对象，也是最常编辑的东西）
 * 扩展（可操作的一级）
 *   └ 展开的扩展名下的能力
 * 供应商（配置目录的一级）
 *   └ 展开的供应商名下的执行者配置
 * ```
 *
 * 三点是必须的：
 * - **换行**：Executor Configuration 可能有几百项（这个仓库里 uniapi-agent
 *   就声明了两百多个 profile），排成一行的宽度会让取景把整个场景缩成一片点；
 * - **可操作的在前**：智能体、扩展是能动手的对象，供应商和执行者是配置目录。
 *   所以它们排在原点附近，默认取景落在能动手的地方；
 * - **一级并排、二级按需展开**：一级节点全部并排铺开（「一共有几家」本身
 *   就是信息），二级收在它下面，双击才铺出来。归属由连线表达，不靠列位置暗示。
 */
const COLUMNS = 6;
const COLUMN_GAP = 260;
const ROW_GAP = 120;
const BAND_GAP = 80;

/**
 * 供应商节点 ID
 *
 * 展开集合的 key 直接就是节点 ID，不需要再从别处反解一个 key 出来——
 * 两边各拼一次字符串，迟早会出现「双击了但没反应」这种查不出原因的错位。
 */
const PROVIDER_ID_PREFIX = 'provider:';

export function providerNodeId(providerKey: string): string {
  return `${PROVIDER_ID_PREFIX}${providerKey}`;
}

function resource(id: string, kind: ResourceNode['resource_kind'], label: string, summary: string): ResourceNode {
  return { type: 'resource', id, resource_kind: kind, label, x: 0, y: 0, summary };
}

/**
 * 谁在画布上代表谁 —— **一个单位只有一格**
 *
 * 配置舱里有三种身份，而**同一个单位可能三种都在场**：
 *
 * ```text
 * 供应商   `_providers/<name>.yaml`   → provider:<name>（模型目录挂在它身上）
 * 扩展包   `extensions/<目录名>/`      → <目录名>
 * 智能体   一个包 + 一条 based_on 执行者 → agent.<id>
 * ```
 *
 * 智能体尤其容易画两遍、三遍：`manifest.create` 建的是一个**包目录**（声明树里
 * `kind: 'package'`），而它同时是注册表里一条 `based_on` 非空的**执行者**，
 * 配置状态里还另有一行 `agent.<id>`。三份都收，同一件事就在画布上出现三格。
 *
 * 所以规矩是**先定身份、再画**：
 *
 * | 它是什么 | 谁代表它 | 谁不再画 |
 * | --- | --- | --- |
 * | 智能体 | 智能体带那一格 | 它的包、它那条执行者配置 |
 * | 扩展包 | 扩展带那一格 | —— |
 * | 供应商 | 供应商带那一格 | 它那份声明文件（本来也不成包） |
 *
 * 这不是"消重"（同一个 id 画两遍那种，`projection.nodes` 里本来就没有），而是
 * **同一个单位换了三个名字**：`agent.weatherToday`、`weatherToday`、
 * `extension.weatherToday` 指的都是同一个包。按 id 去重一个都拦不住。
 */
function agentIdentities(snapshot: GatewaySnapshot): { ids: Set<string>; packages: Set<string> } {
  const ids = new Set<string>();
  const packages = new Set<string>();
  for (const agent of snapshot.agents ?? []) {
    // 执行者目录里的名字是裸 id（`weatherToday`），节点 ID 是 `agent.weatherToday`——
    // 换算只有 `lib/agents.ts` 那一处
    ids.add(agentId(agent.agent_ref));
    /*
      它那个包的目录名。**后端不一定给**（历史对象可能只剩配置状态那一行），
      所以缺了就缺了：没有包名就没有要挡的那一格，别的照旧。
    */
    if (agent.package) packages.add(agent.package);
  }
  return { ids, packages };
}

/**
 * 配置状态里这一行的原样引用
 *
 * 节点上带的是**快照 objects 里的那一行**，不是前端另拼一份：意图、观测、诊断、
 * 种子来源都在里面，两处各拼一份迟早对不上。没有这一行就是没有——不补一个
 * 「已启用」，那会把「后端没报」显示成「用户要它开着」。
 */
function configOf(objectRef: string, rows: Map<string, GatewayObject>): GatewayObject | undefined {
  return rows.get(objectRef);
}

/**
 * Ability 资料节点
 *
 * MCP 服务器也是 Ability（kind = mcp，ref = mcp.<server_id>），启动/停止走的是
 * 同一组 `ability.*` 命令——`mcp.start` 在后端就是 `ability.start` 的语法糖。
 * 所以这里不需要为 MCP 单开一类节点或一套命令。
 *
 * 开关**不从 `state` 反推**：`state` 是运行期观测，不是「用户要不要它开着」。
 * 那个事实在配置状态里，从 `objects` 视图读。
 */
function packageResource(
  item: LiveConsoleNode,
  rows: Map<string, GatewayObject>
): ResourceNode {
  // **身份就是目录名**（`weather`），不是注册表里那个引用（`extension.weather`）。
  // 包在文件树里是一个目录，人打开它的时候说的是"我改 weather 那个包"。
  /*
    **标题写清单里那个名字，身份还是目录名。**

    两者都得在：目录名是引用（`tools_from` / `Task.executor_ref` / 删除都按它走，
    改不得），而人认的是自己写的那个名字——智能体就是一个包，它的名字写在
    `manifest.yaml` 的 `name:` 里。
  */
  const node = resource(item.name, 'extension', item.label || item.name, item.path ?? '');
  // 开关那两栏从**配置状态**读（意图 / 观测分开说），不从 `enabled` 反推一句话
  node.config = configOf(`extension.${item.name}`, rows);
  // 清单里那句说明归**左上角那块卡**——它是描述，不是诊断，卡片上不印
  node.panel_note = item.description;
  // 它就是**一个包**：文件树里不按类型分家，所以不再有"能力包/工具包/执行者实现"
  // 这套分类——那是"按类型组织"那一侧的词汇，前端不该把它搬到文件树上
  // （徽标上那一格只说三件事之一：扩展包 / 智能体 / 供应商）
  node.category = '扩展包';
  node.path = item.path;
  // 条目的数目就是"这个包里声明了几条"。计数先给上，节点自己的说明在别处
  node.child_count = item.nodes?.length ?? 0;
  return node;
}

/**
 * 一个包条目（`manifest.yaml` 里的一条）→ 画布上的节点
 *
 * **它是哪一类由 `entries` 说**：`tool` 的按能力画（权限写在包清单里），
 * `executor` 的按执行者画。同一个名字两个身份都在时报「执行者」——那是它能被
 * Task 引用的一面，也是更"重"的那一面。
 *
 * 详情去**注册表**里按全名取：文件树说的是"这条在哪个文件里"，而"它要不要批、
 * 能不能跑"在那四个列表里。两边看的是同一份事实，所以拼得上。
 */
function entryResource(
  item: LiveConsoleNode,
  packageId: string,
  snapshot: GatewaySnapshot,
  rows: Map<string, GatewayObject>
): ResourceNode {
  const full = item.full || item.name;
  const isExecutor = (item.entries ?? []).includes('executor');

  if (isExecutor) {
    const executor = (snapshot.executors ?? []).find((candidate) => candidate.id === full);
    // **只印名字**：短名写一遍就够，状态那几栏归左上角那块卡
    const node = resource(full, 'executor-config', item.name, '');
    node.compact = true;
    node.category = '执行者';
    // 「它为什么跑不了」也是一句说明，不是诊断——同样归左上角那块卡
    node.panel_note = executor?.why_not;
    /*
      它可能只剩**配置状态那一行**了：声明还在清单里，公开目录里却没有它——
      那正是"被用户停用"的样子（`_executors_snapshot` 那条规矩：那份清单答的是
      "能不能被新建引用"，不是"它存不存在"）。所以引用照旧按名字找，找不到就是没有。
    */
    node.config = configOf(
      executor?.type === 'agent' ? `agent.${full}` : `executor.${full}`, rows);
    if (!executor) {
      const row = rows.get(`executor.${full}`);
      // 只剩配置状态那一行的：给最小占位（引用 + 已下线 + 原因），
      // 于是「被停用」与「从来没存在过」在画布上长得不一样
      if (row) node.reference = offlineViewOf(row);
    }
    return node;
  }

  const node = resource(full, 'capability', item.name, '');
  node.compact = true;
  node.category = '工具';
  /*
    权限写在**声明它的那个包**的清单里，所以"哪个包"要跟着能力一起给，而且是三态。
    这里**不从那本注册表里找**（`capabilities[].ability_ref` 在真后端上根本没有）：
    它的归属就是我们正在走的这棵树——它挂在哪个包底下，就是哪个包声明的。
  */
  node.owner = referenceStateOf(`extension.${packageId}`, snapshot);
  return node;
}

/**
 * 智能体节点
 *
 * 它是配置舱里的一等对象，但**不是可进入的 Scene**（`SceneId` 里没有 agent）：
 * 它在这里被看见、被编辑，编辑页是覆盖层而不是另一个场景。
 */
function agentResource(
  agent: GatewayAgent,
  rows: Map<string, GatewayObject>,
  snapshot: GatewaySnapshot
): ResourceNode {
  const node = resource(agent.agent_ref, 'agent', agent.label || agent.agent_ref, agent.description);
  // 三类身份之一。徽标上那一格说的是"它是什么"，不是"它归哪个带"——
  // 同一个智能体的包和它那条执行者配置都**不再单独成节点**（见 `agentIdentities`）
  node.category = '智能体';
  node.config = configOf(agent.agent_ref, rows);
  node.agent = {
    // 模型是一个**引用**：它可能已下线，所以要三态，不能只留一个名字
    model: referenceStateOf(agent.executor_config_ref, snapshot),
    tools: agent.tools ?? [],
    packages: agent.packages ?? [],
    revision: agent.revision,
  };
  return node;
}

/**
 * 只剩配置状态那一行的对象
 *
 * 一个对象在配置状态里有一行，注册表里却没有它：它被停用了（ADR-029 的做法是
 * **真的不加载**），或者它起不来。这时仍然要把它画出来，理由有两条：
 *
 * - 只画注册表里的东西，开关就是**单向门**——点一下停用，它从画布上消失，再也
 *   拨不回来；
 * - 「它被停用了」与「它从来不存在」在界面上必须长得不一样。
 *
 * 所以给一个**最小占位**：引用本身 + 已下线标记 + 原因，没有伪造的名称、状态或
 * 它根本给不出的按钮（「健康检查」这种要后端有东西可查的命令就不给）。
 */
function orphanResource(row: GatewayObject): ResourceNode {
  /*
    结构类别一律用 `extension`：它决定渐变配色与能不能展开，而占位节点不展开。

    **不挂 `agent` 那一套事实**（哪怕这一行是个智能体）：定义已经不在了，挂了它就
    会长出一个「编辑」按钮，点开却什么都没有——那是在承诺一件不存在的事。
    它是什么由 `category` 说。
  */
  const node = resource(row.object_ref, 'extension', row.object_ref, '');
  node.config = row;
  node.category = orphanCategory(row.kind);
  node.reference = offlineViewOf(row);
  return node;
}

function orphanCategory(kind: string): string {
  const labels: Record<string, string> = {
    // 不写「已停用」：这一格说的是它**是什么**。停没停是下面那两栏的事，
    // 而占位可能因为「起不来」而不是因为「被停用」（那两句话不一样）
    package: '扩展包',
    mcp: 'MCP 服务器',
    device: '设备',
    agent: '智能体',
  };
  return labels[kind] ?? kind;
}

/**
 * 执行者配置：目录 ∪ 只剩配置状态的那些
 *
 * 后端按设计把被用户停用的 profile 从公开目录里过滤掉了——那是「**能不能被新建
 * 引用**」的清单（`_executors_snapshot` 的注释），不等于「它不存在」。配置舱要
 * 拨得回开关，所以从 objects 视图把缺席的那些补成占位节点，归到它自己的供应商
 * 名下（供应商作用域就在 `qualified` 引用里，`uniapi:qwen-max` 的前半段就是它）。
 */
function executorNodesWithDisabled(
  snapshot: GatewaySnapshot,
  rows: Map<string, GatewayObject>
): ResourceNode[] {
  const nodes = executorCatalog(snapshot);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const row of rows.values()) {
    if (row.kind !== 'executor') continue;
    const qualified = row.object_ref.startsWith('executor.')
      ? row.object_ref.slice('executor.'.length)
      : row.object_ref;
    if (byId.has(qualified)) continue;
    // 标签只能是那个引用本身：配置状态里没有 display_name，
    // 而拿引用去猜一个名字就是编
    const node = resource(qualified, 'executor-config', qualified, '');
    node.config = row;
    // 它同时是一个「解析不到」的引用：给最小占位（引用 + 已下线 + 原因），
    // 于是「被停用」与「从来没存在过」在画布上长得不一样
    node.reference = offlineViewOf(row);
    nodes.push(node);
    byId.set(qualified, node);
  }

  return nodes;
}

/**
 * 一条执行者用的是哪家的模型
 *
 * `provider_id` 由 `mapLiveState` 算（没有模型段的算作 `localFunction`），
 * 这里只是把它从快照里取回来——**不再从执行者 id 的前缀猜**：那是旧格式
 * `provider:profile` 的约定，新树的执行者叫 `weather.collect`，没有冒号。
 */
function providerOf(snapshot: GatewaySnapshot, executorId: string): string {
  const found = (snapshot.executors ?? []).find((executor) => executor.id === executorId);
  return String(found?.provider_id ?? '');
}

export function projectLiveConfiguration(
  snapshot: GatewaySnapshot,
  configurationId?: string,
  /** 已展开的节点 ID。缺省全收起：配置舱默认只画一级 */
  expandedNodes: ReadonlySet<string> = new Set()
): LiveConfigurationModel {
  const rows = new Map((snapshot.objects ?? []).map((row) => [row.object_ref, row]));
  /*
    **谁是智能体，先定下来。** 后面三处都要按它挡人：扩展带（它的包）、执行者带
    （它那条 `based_on` 的配置）、孤儿（它那个包的配置状态行）。
  */
  const agentIds = agentIdentities(snapshot);
  /*
    与 Task 场景共用同一份取值链：人读名称是 display_name。

    **智能体那条执行者配置不在这条带上**：它已经被智能体带那一格代表了，再画一次
    就是同一个单位两格（`weatherToday` 和 `agent.weatherToday` 并排站着）。

    名单取的就是**智能体带那一份**（`snapshot.agents`），不是再从 `executors[].type`
    推一遍：两边各推一次会漂开，而在这里漂开等于**把一格挡没了**——挡的人得是画的人。
  */
  const executorNodes = executorNodesWithDisabled(snapshot, rows)
    .filter((node) => !agentIds.ids.has(node.id));
  // 供应商的目录：**模型属于供应商**（`extensions/_providers/<name>.yaml` 的 `models[]`），
  // 所以它随供应商节点一起走，不再只活在"新建智能体"的选择器里
  const catalogByName = new Map((snapshot.providers ?? []).map((provider) => [
    provider.name,
    {
      name: provider.name,
      enabled: provider.enabled,
      models: (provider.models ?? [])
        .map((model) => ({
          name: String((model as { name?: unknown }).name ?? ''),
          owned_by: (model as { owned_by?: unknown }).owned_by
            ? String((model as { owned_by?: unknown }).owned_by) : undefined,
        }))
        .filter((model) => model.name),
    },
  ]));

  /*
    **配置舱的结构来自 `console`（那棵声明文件树），不由前端拼。**

    以前这一批是前端拿"供给"现造的 `GatewayAbility`——于是包的身份成了一个
    前端编出来的引用，而包本身只在配置状态里露个影子。**包在文件树里是一个目录，
    它的身份就是目录名**，它声明了什么就在它那份清单里；这两件事后端都已经说了。
  */
  const tree = snapshot.console ?? [];

  /*
    **智能体本身就是一个包，所以它会在声明树里再出现一次。**

    一个智能体是 `manifest.create` 建的**包目录**，它的 `console` 节点是
    `kind === 'package'`；而它同时是注册表里一条 `based_on` 非空的执行者
    （`snapshot.agents`）。两处都收它的话，同一个东西在配置舱里画两遍——
    一次在「智能体」带，一次在「扩展」带。

    **拿掉整个包是安全的**：智能体不对外提供工具。它的 `tools_from` 引用的是
    **别人家**的供给（智能体的工具在 `tools` 那一栏，来源是 `packages`），
    而它自己那个包里只有一条 `executor:`。所以不需要"只去掉作为智能体的那一条、
    留下别的条目"这种精细做法。
  */
  const packageNodes = tree.filter((node) => node.kind === 'package'
    && !agentIds.packages.has(node.name));
  const abilities = packageNodes.map((item) => packageResource(item, rows));
  const agents = (snapshot.agents ?? []).map((agent) => agentResource(agent, rows, snapshot));

  // 一个包声明的条目：**它的二级**。名字相同的那两条合成了一个节点（后端早合好了）
  const entriesOf = new Map<string, ResourceNode[]>();
  for (const item of packageNodes) {
    entriesOf.set(item.name, (item.nodes ?? [])
      .filter((entry) => entry.kind === 'entry')
      .map((entry) => entryResource(entry, item.name, snapshot, rows)));
  }
  const capabilitiesOf = entriesOf;

  const capabilities = [...entriesOf.values()].flat()
    .filter((node) => node.resource_kind === 'capability');

  /*
    只剩配置状态那一行的对象：包 / 智能体。

    「活着」按**声明**算，不按画布上画了几个节点：一个包里声明了但没有画出来的
    条目，它照样在系统里，不能因为没画就判成失踪。
  */
  const declaredExecutors = new Set([...entriesOf.values()].flat()
    .filter((node) => node.resource_kind === 'executor-config')
    .map((node) => node.id));
  const live = new Set<string>([
    ...packageNodes.map((item) => `extension.${item.name}`),
    ...agents.map((node) => node.id),
    /*
      **智能体那个包也算活着。** 它不单独成节点（由智能体带代表），但它并没有停用
      ——漏掉这一句，配置状态里 `extension.<包名>` 那一行就会掉进"只剩一行"的孤儿
      里，画布上多出一个说「扩展包 · 已下线」的占位，而它好好的。
    */
    ...[...agentIds.packages].map((name) => `extension.${name}`),
    ...executorNodes.map((node) => `executor.${node.id}`),
  ]);
  const orphans = [...rows.values()]
    .filter((row) => ['package', 'mcp', 'device', 'agent'].includes(row.kind))
    .filter((row) => !live.has(row.object_ref))
    .map(orphanResource);

  /*
    聚焦的东西必须看得见。

    用户可能是带着某个引用进来的（从 Task 的 Executor 引用进到某条配置，
    或从能力进到声明它的扩展）。它收在上层节点里时，画布上根本没有它，
    `focused` 就会静默回落到第一格——用户点的是一件事，看到的是另一件。
    所以把焦点所在的那个一级节点一并算作展开。
  */
  const focusOwnerId = findFocusOwner(configurationId, entriesOf);
  const isExpanded = (nodeId: string) => expandedNodes.has(nodeId) || focusOwnerId === nodeId;

  /*
    第一条带不能铺在原点。

    左上角常驻着「场景事实」浮层，而这个画布不 fitView（默认视口 1:1），
    所以场景坐标 (0,0) 就落在浮层底下——实测第一版把**智能体**放在那里，
    结果进配置舱时它被浮层完全盖住，连点都点不到（按元素矩形点击会打到浮层上，
    于是「点节点」变成了「点返回」）。留出浮层的高度，内容就落在它下面。
  */
  const TOP_SAFE = 340;

  let cursor = TOP_SAFE;
  const layBand = (nodes: ResourceNode[]) => {
    // 空带不占位置：没有智能体的世界不该把下面的东西整体压下去一屏空
    if (nodes.length === 0) return;
    nodes.forEach((node, index) => {
      node.x = (index % COLUMNS) * COLUMN_GAP;
      node.y = cursor + Math.floor(index / COLUMNS) * ROW_GAP;
    });
    cursor += Math.ceil(nodes.length / COLUMNS) * ROW_GAP + BAND_GAP;
  };

  const relations: ProjectionOutput['relations'] = [];

  // 智能体：一等对象，**直接展示**，排在原点附近——这一屏最常动手的地方
  layBand(agents);

  // 包：一级并排铺开，**默认收起**，双击才把它声明的那几条铺出来
  for (const node of abilities) node.expanded = isExpanded(node.id);
  layBand(abilities);

  // 展开的包把它的条目铺在它下面：归属由 declares 连线表达
  const visibleEntries: ResourceNode[] = [];
  for (const node of abilities) {
    if (!node.expanded) continue;
    const children = capabilitiesOf.get(node.id) ?? [];
    layBand(children);
    visibleEntries.push(...children);
    relations.push(...children.map((child) => ({
      id: `rel-${node.id}-${child.id}`, source: node.id, target: child.id,
      type: 'declares' as const, label: 'declares',
    })));
  }

  /*
    供应商：**只有声明的那些，一个不多一个不少。**

    它过去是"执行者按供应商分出来的组"，于是凭空多出一个「无供应商」节点——
    那不是一家供应商，是"没有模型段的执行者"这一桶。用一棵树表达一个分组，
    等于在画布上造一个不存在的东西。

    反过来，"这家在不在系统里"由它的**声明**回答，不由"有没有人正在用它"回答：
    一家刚配好、还没有智能体引用它的供应商照样要看得见——跟"关着的包也在列表里"
    是同一条道理。
  */
  const providers: ResourceNode[] = (snapshot.providers ?? []).map((provider) => {
    const node = resource(providerNodeId(provider.name), 'executor-provider', provider.name, '');
    /*
      三类身份之一。**一家供应商就是一个单位，不是"执行者按供应商分出来的组"**：
      它的身份写在 `_providers/<name>.yaml` 里，模型目录挂在它身上，谁在用它的模型
      由 `provides` 连线说。所以它既不会被折进某个包，也不会替某个包说话——
      同名的一个包和一家供应商是两件事（一个是代码目录，一份是连接 + 模型清单）。
    */
    node.category = '供应商';
    node.catalog = catalogByName.get(provider.name);
    // 计数报的是**这家有哪些模型**——打开这一格要看的就是那张目录
    node.child_count = node.catalog?.models.length ?? 0;
    return node;
  });
  layBand(providers);

  /*
    只剩配置状态那一行的执行者单独成带。

    它没在任何清单里（声明被删了，或者那条声明读不动），所以哪棵树下都挂不上。
    **画出来才拨得回开关**——只画清单的话，「停用」就是一道单向门。
  */
  const visibleExecutors = executorNodes.filter((node) => !declaredExecutors.has(node.id));
  layBand(visibleExecutors);

  // 执行者用的是哪一家的哪个模型：**引用关系，由连线说**，不靠挂在谁下面
  const drawnExecutors = new Set(
    [...visibleEntries, ...visibleExecutors].map((node) => node.id));
  const declaredProviders = new Set((snapshot.providers ?? []).map((provider) => provider.name));
  for (const node of drawnExecutors) {
    const holder = providerOf(snapshot, node);
    if (!declaredProviders.has(holder)) continue;
    relations.push({
      id: `rel-${providerNodeId(holder)}-${node}`,
      source: providerNodeId(holder), target: node,
      type: 'provides' as const, label: 'provides',
    });
  }

  // 一级排在前面：默认聚焦落在目录的一级，而不是随便一条配置
  const all = [
    ...agents, ...abilities, ...visibleEntries, ...orphans,
    ...providers, ...visibleExecutors,
  ];
  const focused = all.find((node) => node.id === configurationId) ?? all[0] ?? null;

  /*
    聚焦供应商时聚合它名下所有配置的引用。

    只比较 `focused.id` 会让供应商节点永远显示「暂无引用」——而它名下的配置
    可能正被一堆 Task 引用着，那等于对用户说了假话。
  */
  const focusedConfigIds = focused?.resource_kind === 'executor-provider'
    ? (snapshot.executors ?? [])
        .filter((executor) => executor.provider_id === focused.label)
        .map((executor) => String(executor.id ?? ''))
        .filter(Boolean)
    : focused?.resource_kind === 'executor-config' ? [focused.id]
      // 智能体在任务层是**执行者引用**（`agent:<id>`）：两种拼法指同一个对象，
    // 但 Task 里存的是冒号那种，拿点号那种去比会永远比不中
    : focused?.resource_kind === 'agent' && focused.id
      ? [agentExecutorRef(focused.id)]
      : [];

  return {
    focused,
    providers,
    executorConfigurations: executorNodes,
    abilities,
    capabilities,
    agents,
    referencedByTaskIds: snapshot.tasks
      .filter((task) => task.executor_config_id && focusedConfigIds.includes(task.executor_config_id))
      .map((task) => task.id),
    projection: { nodes: all, relations, sceneEntries: [] },
  };
}

/**
 * 焦点所在的一级节点
 *
 * 带进来的引用可能指向一个二级节点（某条配置、某个能力），它收在哪个
 * 一级节点里就展开哪个；指向一级节点或认不出来时返回 null。
 */
function findFocusOwner(
  configurationId: string | undefined,
  entriesOf: Map<string, ResourceNode[]>
): string | null {
  if (!configurationId) return null;
  // 条目（工具 / 执行者）挂在**它所在的那个包**下面，所以聚焦它得先把那个包展开。
  // 智能体是一级，不挂在任何人下面——它不需要谁替它展开。
  for (const [packageId, entries] of entriesOf) {
    if (entries.some((node) => node.id === configurationId)) return packageId;
  }
  return null;
}
