import type { TaskNode } from '../core/types/node';
import type { SelectGroup } from '../lib/selectGroups';

/**
 * Core 控制事件类型
 *
 * 唯一权威是后端 `occ-next/src/core/event.py` 的 `EVENT_TYPES`。
 * 前端不得自创事件名——名字对不上时事件日志会静默显示成空白。
 *
 * 这一份是**照抄旧树**（`occ-next/src/core/models.py`）留下的：
 *
 * - 少了 `TASK_ARCHIVED`——归档那条事件在真的库里出现过 24 次，而它在事件日志上
 *   只会印出 `TASK_ARCHIVED` 这个英文原样（`?? event.event_type` 那个兜底）；
 * - 多了 `SUBJECT_ONLINE/OFFLINE/ERROR`——新树**故意删掉**了它们
 *   （`src/core/executor.py`：执行者是按需起的子进程，跑完就结束、不"离线"；
 *   而"它现在是活的"是**观测**，不该写进不可删的事件链）。库里从来没有过一条。
 */
export const CONTROL_EVENT_TYPES = [
  'TASK_CREATED',
  'FUNCTION_APPROVAL_REQUESTED',
  'INTERRUPTED',
  'APPROVED',
  'DENIED',
  'RESUMED',
  'FUNCTION_CALLED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  // 收进档案馆。**只有跑完的 Task 能归档**——还在动的东西不是历史。
  'TASK_ARCHIVED',
] as const;

export type ControlEventType = (typeof CONTROL_EVENT_TYPES)[number];

/**
 * Core 控制事件
 *
 * 形状对齐后端 `core.models.ControlEvent`。
 * 没有 `event_seq`：追加顺序由数组顺序表达，公开游标属于后端待冻结契约，
 * 前端不自己造一个序号冒充它。
 */
export interface ControlEvent {
  event_id: string;
  event_type: ControlEventType;
  subject_ref: string;
  task_id?: string;
  tool_id?: string;
  external_ref?: string;
  occurred_at: string;
  payload?: Record<string, unknown>;
}

export interface GatewayTask {
  task_id?: string;
  status?: string;
  summary?: string;
  executor_config_ref?: string;
  pending_tool_id?: string;
  pending_decision?: string;
  state_version?: number;
}

export interface GatewaySnapshot {
  tasks: TaskNode[];
  events: Record<string, ControlEvent[]>;
  controllers: Record<string, {
    task_id: string;
    worker_alive: boolean;
    status: string;
    /** 可能还有 worker 在外面跑着（上一次进程被杀留下的孤儿），要人确认 */
    worker_unreconciled?: boolean;
  }>;
  capabilities: GatewayCapability[];
  abilities: GatewayAbility[];
  /**
   * **配置舱那棵树**：`extensions/` 下的目录与声明文件（按文件组织）
   *
   * 它和上面那几个列表看的是**同一份事实**，只是组织方式不同——列表按类型排
   * （判决要那样），这一份按文件排（人要这个）。**配置舱只读它**：结构由后端给，
   * 前端出渲染器。
   */
  console?: LiveConsoleNode[];
  executors?: GatewayExecutor[];
  /**
   * 可配置对象：一个对象一行，**意图（activation）与观测（observed）分开**
   *
   * 合成一个布尔值就说不清「你要它开着，但它起不来」——那句话必须说得出来。
   */
  objects?: GatewayObject[];
  /** 智能体：定义 + 展开后的工具三列 */
  agents?: GatewayAgent[];
  schedules?: GatewaySchedule[];
  /** 模型供应商：**智能体的模型从这儿挑**（模型下沉成智能体的一个属性） */
  providers?: LiveProvider[];
  /** 悬着的输出（投影；前端那条路靠它送达——见 `gateway/output/README.md`） */
  outputs?: LiveOutput[];
  /** 声明原文：改一条列表里的条目时要整列交回去 */
  declarations?: LiveDeclaration[];
  dispatches?: GatewayDispatch[];
  mcp?: GatewayMcp[];
  devices?: GatewayDevice[];
  access?: { principal_ref: string; access_mode: string };
}

/**
 * 可配置对象的种类
 *
 * 权威是后端 `localconfig/store.py` 的 `KINDS`。工具（capability）不在其中：
 * 它的权限写在 manifest 里（ADR-033），开关在它所属的**包**上。
 */
export type ConfigObjectKind = 'package' | 'executor' | 'mcp' | 'device' | 'schedule' | 'agent';

/**
 * 一条诊断：这个对象最近一次为什么没起来
 *
 * `imported` 是「要不要重启」的答案：为真表示这段代码已经 import 进宿主进程了，
 * 禁用卸不掉它；为假表示它根本没被加载，改完重试即可。
 */
export interface GatewayDiagnostic {
  stage: string;
  error_type: string;
  message: string;
  imported: boolean;
  created_at: string;
}

/**
 * 配置状态里的一个对象
 *
 * 两个字段不能合并：
 * - `activation`：用户最后的选择（意图），存库、跨重启保持；
 * - `observed`：运行期派生（观测），**不落库**。
 *
 * `observed` 对没有生命周期的对象（执行者 / 智能体 / 日程）是**空串**，不是
 * `unknown`——它们不是「问了答不上来」，而是「没有可观测的东西」；写 unknown
 * 等于捏造一个不存在的问题。
 *
 * 两个字段都用宽松的 `string`：契约漂移时不猜语义（与 `health` / `state` 同一处理）。
 */
export interface GatewayObject {
  /** 键的形状：extension.<id> / executor.<qualified> / agent.<id> / device.<ref> / mcp.<server_id> */
  object_ref: string;
  kind: ConfigObjectKind | string;
  activation: string;
  observed: string;
  health: string;
  /** 这个开关是谁定的：seed（manifest 种子）还是 user */
  source: string;
  /** 种子原值——用来回答「它默认为什么是这个」 */
  seed_value: boolean;
  last_error: string;
  /** 最近一条诊断；null 表示**没有诊断**，不是「一切正常」 */
  diagnostic: GatewayDiagnostic | null;
  /**
   * 关掉它之后，代码是不是还留在后端进程里
   *
   * 包内实现的工具跑在宿主进程里，**禁用卸不掉已经 import 的模块**——要重启。
   * 执行者的代码在子进程里，跑完就结束，所以它没有这一条。
   */
  restart_required?: boolean;
}

/**
 * 一个工具在某个智能体下的审批三列
 *
 * 三个值一起给，用户才看得出「这条是能力钉死的、这条是我收紧的、这条我没动」。
 * 生效值由后端算（`declared or tightened`，ADR-027），前端不重算——重算就会出现
 * 「界面说会审批、执行时没审批」这种两侧各一份答案的分叉。
 */
export interface GatewayToolSpec {
  tool_id: string;
  /** 能力 manifest 声明的地板 */
  declared: boolean;
  /** 实际生效的审批要求 */
  effective: boolean;
  /** 这条严于声明，是这个智能体自己收紧的 */
  tightened_by_agent: boolean;
}

/**
 * 智能体：一等对象 =（一个模型 + 一段 system_prompt + 一组扩展包 + 收紧后的权限）
 *
 * `agent_ref` 是配置状态的键（`agent.<id>`），不是任务层那个执行者引用
 * （`agent:<id>`，与 `uniapi:qwen-max` 同形）。换算只在 `lib/agents.ts` 一处。
 */
export interface GatewayAgent {
  agent_ref: string;
  label: string;
  description: string;
  /**
   * **它自己所属的那个包**（包目录名），不是它引用的工具包。
   *
   * 智能体就是一个包（`manifest.create` 建的包目录），所以它会同时出现在
   * 注册表（作为执行者）和 `console` 声明树（作为 `kind === 'package'` 的节点）里。
   * 配置舱靠这一格把"作为扩展的那一份"认出来并去掉——否则同一个东西画两遍。
   *
   * 别拿 `description` 代它：那一格现在碰巧装着包名，但它是给人读的说明。
   */
  package: string;
  /** 它**基于哪段代码**（一条带 worker 的执行者） */
  executor_config_ref: string;
  /** 它用的模型，拼法 `provider:model`（模型属于**供应商**，不是执行者条目） */
  model_ref?: string;
  system_prompt: string;
  /** 选中的扩展包（整包选，不逐个工具） */
  packages: string[];
  parameters: Record<string, unknown>;
  /** 定义修订号 */
  revision: number;
  /** 由包集并集而来的工具 */
  tool_ids: string[];
  tools: GatewayToolSpec[];
  activation: string;
}

/** 引用解析的三种结果。**不是两种**：`offline` 与 `unknown` 对用户是两件事 */
export type ReferenceState = 'resolvable' | 'offline' | 'unknown';

/**
 * 一个引用的解析结果（ADR-024）
 *
 * - `resolvable`：系统知道它指向什么，而且它现在可用；
 * - `offline`：系统知道它**曾经是什么**，但它现在不可用 → 最小占位 + 原因；
 * - `unknown`：系统不知道它是什么 → 明确未知，不猜。
 */
export interface ResolvedReference {
  /** 调用方手里的引用原文（可能与 object_ref 不同形，例如 `agent:ops`） */
  ref: string;
  /** 换算出来的配置状态键；unknown 时是空串 */
  object_ref: string;
  state: ReferenceState;
  kind: string;
  /** enabled / disabled / 空串（没有配置记录时） */
  activation: string;
  /** 为什么是这个状态（后端给的人读原文）；可解析时为空 */
  reason: string;
}

export interface GatewayCapability {
  tool_id: string;
  function_name: string;
  target_type?: string;
  risk_level?: string;
  approval_required?: boolean;
  input_schema?: Record<string, unknown>;
  ability_ref?: string;
  active?: boolean;
}

export interface GatewayAbility {
  ability: {
    ability_ref: string;
    kind: string;
    version: string;
    source: string;
    label: string;
    state: string;
    health: string;
    metadata?: Record<string, unknown>;
  };
  capabilities: string[];
  /**
   * **这台供给叫什么**——就是 `tools_from` 里该写的那个名字
   *
   * 它和 `ability_ref` 不是一回事：`ref` 是"这个对象在配置状态里的键"
   * （`extension.weather`），而 `tools_from` 要的是**供给名**（`weather`）。
   * 两个都用过一遍才发现拿 ref 去写 `tools_from` 是写不进去的：
   * 后端按供给名找，找不到就是"这个执行者一个工具都不许用"——**默认拒绝**，
   * 而且它不报错。
   */
  supply?: string;
}

/**
 * Executor Configuration 公开视图
 *
 * **人读名称是 `display_name`**（其余三个下拉都从它取值）；`id` / `ref` 是引用，
 * 只该出现在"它到底是哪一条"要说清楚的地方（写声明、认对象）。
 */
export interface GatewayExecutor {
  id?: string;
  ref?: string;
  display_name?: string;
  description?: string;
  /** 声明它的那个包（目录名）。`mapLiveState` 一直给，只是这一格以前漏在类型外 */
  package?: string;
  type?: string;
  tags?: string[];
  provider_id?: string;
  provider?: string;
  model?: string;
  base_url?: string;
  api_key_env?: string;
  api_key_configured?: boolean;
  /**
   * 这段代码会不会跑一个 LLM 循环（写在**带代码的那一条**上）
   *
   * 它决定「新建智能体」要不要问模型：要模型而没人给，后端在**登记那一步**就拒
   * （`extensions/executors.py::check`）。所以这一格不是界面偏好，是契约。
   */
  needs_llm?: boolean;
  /** 现在能不能被起起来（后端算的：开着、没毛病、有代码、要模型的有模型） */
  runnable?: boolean;
  /** 跑不了的原因——**说给人听的那一句** */
  why_not?: string;
}

export interface GatewaySchedule {
  schedule_id: string;
  name?: string;
  summary?: string;
  cron?: string;
  expression?: string;
  timezone?: string;
  enabled: boolean;
  executor_config_ref?: string;
  task_ref?: string;
  [key: string]: unknown;
}

export interface GatewayDispatch {
  occurrence_key: string;
  schedule_id: string;
  task_ids: string[];
  status: string;
  error?: string;
  updated_at?: string;
}

export interface GatewayMcp {
  server_id: string;
  health: string;
  tools?: unknown[];
  [key: string]: unknown;
}

export interface GatewayDevice {
  device_ref: string;
  health: string;
}

const base = import.meta.env.VITE_GATEWAY_URL ?? '';

/**
 * 「本地写死」那个供应商的 key
 *
 * 老后端有个 `resolve_provider_id()`：清单里写了 `provider:` 就用它，**没有模型段**
 * 的执行者归这里。新树里那个函数没有了，但这条规则还在——一个不带模型的执行者
 * 就是一段写死的代码，它没有供应商。所以它由**读取方**算出来（`mapLiveState`），
 * 而不是等后端给。
 */
export const LOCAL_FUNCTION_PROVIDER = 'localFunction';

/**
 * 数据源
 *
 * 运行时唯一来源是后端网关快照。`VITE_DATA_SOURCE=mock` 只供离线开发与
 * 截图使用，必须显式开启；后端不可达时**不回落**到它——那会把原型数据
 * 伪装成真实事实（backend-contract.md 第 6 节）。
 */
export const DATA_SOURCE: 'live' | 'mock' =
  import.meta.env.VITE_DATA_SOURCE === 'mock' ? 'mock' : 'live';

/**
 * 带状态码的网关错误
 *
 * 只有字符串是不够的：**401 和 503 在界面上该说的话完全不同**——一个要你去认证，
 * 一个是后端挂了。把状态码丢成一句文字，两者就长得一模一样。
 */
export class GatewayError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
  }
}

/** 认证失败：后端要求凭据，而这次请求没带上（或带错了） */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof GatewayError && error.status === 401;
}

/**
 * 取后端错误说明
 *
 * FastAPI 的错误体是 `{"detail": ...}`（校验失败时 detail 是数组），
 * 网关自己的 `{"error": ...}` 只在 HTTP 200 的拒绝结果里出现。
 * 两者都读不到时退回状态码，不编造原因。
 */
async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown; error?: unknown };
    const detail = body.detail ?? body.error;
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail)) {
      const parts = detail
        .map((item) => (item as { msg?: unknown })?.msg)
        .filter((msg): msg is string => typeof msg === 'string');
      if (parts.length > 0) return parts.join('; ');
    }
  } catch {
    // 响应体不是 JSON：保留状态码
  }
  return `${fallback}: ${response.status}`;
}

/** 新后端 `GET /api/state` 里的一条**供给**（声明里的一条 `tools` 条目） */
export interface LiveSupply {
  name: string;
  package: string;
  enabled: boolean;
  loaded: boolean;
  problem: string;
  usable: boolean;
  status: string;
  detail: string;
  approval_required: boolean;
  idempotency: string;
  tools: { tool_id: string; description: string; input_schema: Record<string, unknown> }[];
}

/** 一条执行者。**关着的、起不来的也在列表里**——`runnable` 才是"能不能跑" */
export interface LiveExecutor {
  name: string;
  package: string;
  based_on: string;
  enabled: boolean;
  problem: string;
  runnable: boolean;
  why_not: string;
  needs_llm: boolean;
  model: { provider?: string; name?: string } | null;
  tools_from: string[];
  tighten: string[];
}

/**
 * 一个包在声明里的**原文**（快照的 `declarations` 给的那份）
 *
 * 改一条**列表里**的条目（关掉一台供给、改一个工具的审批要求）唯一的写路径是
 * "整列重写"，而重写必须有那一列——照着成品列表拼一份会丢掉 `url` / `entrypoint`。
 */
/**
 * 一条**悬着的输出**——要送到外面去的那件事
 *
 * 形状归后端（`gateway/output/output.py`）。这里只做一件事：把它原样接过来。
 * **前端这条输出路径不需要"投递"**：它出现在快照里就是送到了。
 */
export interface LiveOutput {
  /** 身份：同一个单位只有一个，所以前端能拿它去重（重连、刷新都不该当成第二件事） */
  ref: string;
  kind: string;
  target_ref: string;
  title: string;
  summary: string;
  actions?: { ref: string; label: string; command?: string }[];
  expires_at?: string;
}

export interface LiveDeclaration {
  id: string;
  enabled: boolean;
  name: string;
  tools: Record<string, unknown>[];
  executors: Record<string, unknown>[];
}

/** 一家供应商：怎么连 + 它认识哪些模型 */
/**
 * 配置舱那棵树上的一个节点（`web/snapshot.py::_console`）
 *
 * **结构由后端给，前端只出渲染器。** 所以这里不重新组织、不补兜底桶：
 * 拿到什么形状就画什么形状。`kind` 决定用哪个渲染器，`nodes` 是它的孩子。
 *
 * 路径**读出来、不推出来**：文件名和声明里的名字可以不同
 * （`_schedules/weather-daily.yaml` 里写着 `name: weather.daily`）。
 */
export interface LiveConsoleNode {
  kind: 'directory' | 'package' | 'entry' | 'provider' | 'model' | 'schedule';
  /** **身份**：目录名（引用用它，所以界面上也得能读到它） */
  name: string;
  /** **给人看的名字**：清单里的 `name:`。缺省时就是 `name` */
  label?: string;
  /** 它在磁盘上哪一份文件里（相对扩展根）。目录节点就是目录名 */
  path?: string;
  /** 供开关用（包 / 供应商 / 日程自己有；目录和模型没有） */
  enabled?: boolean;
  /** 只在 `entry` 上有：这个全名出现在哪几个列表里（`tool` / `executor`） */
  full?: string;
  entries?: string[];
  /** 清单里那句说明（包才有）。**是描述，不是诊断** */
  description?: string;
  /** 供应商 / 日程各自的干货 */
  base_url?: string;
  cron?: string;
  timezone?: string;
  task_ref?: string;
  executor_ref?: string;
  owned_by?: string;
  nodes?: LiveConsoleNode[];
}

export interface LiveProvider {
  name: string;
  base_url: string;
  enabled: boolean;
  models?: Record<string, unknown>[];
}

/** 新后端 `GET /api/state` 的原始响应（`src/web/snapshot.py`） */
export interface LiveState {
  /** 配置舱那棵树（按声明文件组织）。**它的形状就是画布的形状** */
  console?: LiveConsoleNode[];
  registry: {
    capabilities: LiveSupply[];
    executors: LiveExecutor[];
    providers: LiveProvider[];
    schedules: { name: string; cron: string; timezone: string; task_ref: string;
                 executor_ref: string; enabled: boolean }[];
    packages: { id: string; enabled: boolean; name: string; description: string }[];
  };
  tasks: {
    task_id: string;
    summary?: string;
    status?: string;
    executor_ref?: string;
    pending?: { tool_id: string; decision: string } | null;
    state_version?: number;
    /** 收进档案馆了吗（它不是状态，是"我不管它了"） */
    archived?: boolean;
    updated_at?: string;
    events?: ControlEvent[];
  }[];
  /**
   * **悬着的输出**（今天只有"等人拍板"这一种）。
   *
   * 它是投影（后端从 Task 现算，不存状态），所以它和快照里别的格子一样：
   * 读一次就是此刻的样子。
   */
  outputs?: LiveOutput[];
  /** 每个包那几条 `tools` / `executors` 条目，一字不改 */
  declarations?: LiveDeclaration[];
  /** 还开着的启动记录：一行一次启动，`alive` 是**现场探的** */
  workers?: { task_id: string; process_id: number; started_at: string; alive: boolean;
              /** 进程还在、而宿主手里没有它：**要人对账的那一种** */
              unreconciled?: boolean }[];
  dispatches?: { occurrence_key: string; schedule_id: string; task_id: string;
                 status: string; detail: string; updated_at: string }[];
}

/**
 * 配置状态里的一行
 *
 * **新模型里没有配置状态库**：开关就是声明里那一行，所以 `source` 只有 `manifest`
 * 一个答案，`seed_value` 就是它本身。意图（`activation`）和观测（`observed`）
 * 仍然是两件事——那是这个形状存在的理由，不是某个库带来的。
 */
/**
 * 配置状态里的一行
 *
 * **`last_error` 和 `diagnostic` 都是空的，而且必须空着。**
 *
 * 这里以前收一个"备注"字符串（包说明、`why_not`、cron、`base_url`），然后把它
 * **同时**写进 `last_error` 和 `diagnostic.message`——于是界面上：
 *
 * - 一台好好的供应商挂着「诊断：https://api.deepseek.com/v1」；
 * - 一条日程挂着「诊断：0 8 * * *」；
 * - 一个包挂着「诊断：查天气。两种用法：agent 可以调它，日程可以跑它」。
 *
 * 三句都不是诊断，是**描述**。而 `诊断` 这一栏回答的是"它为什么没起来"——
 * 把描述填进去，等于对每一格都说了一句假话，而它长得像真的。
 *
 * 真要说的那些（包的说明、执行者为什么跑不了）另走 `panel_note`：
 * **给左上角那块卡看，不印在卡片上**。诊断不落库（ADR-028），所以这一版没有
 * "上次为什么失败"可填——那就空着，而不是拿别的字段冒充。
 */
function objectRow(
  objectRef: string,
  kind: string,
  enabled: boolean,
  restartRequired = false
): GatewayObject {
  return {
    object_ref: objectRef,
    kind,
    activation: enabled ? 'enabled' : 'disabled',
    observed: '',
    health: '',
    source: 'manifest',
    seed_value: enabled,
    restart_required: restartRequired,
    last_error: '',
    diagnostic: null,
  };
}

/** Core 已知的任务状态。漂移值不猜测语义，统一按「未知」处理 */
const KNOWN_STATUSES: readonly TaskNode['status'][] = [
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
];

/**
 * 归一化后端快照
 *
 * 唯一一处把后端字段翻译成前端字段的地方——翻译错了整站都会显示错，
 * 所以它单独可测（`api/gateway.test.ts`）。
 *
 * 新模型带来的三处**结构性**翻译（不是改字段名，是两套模型对不上）：
 *
 * - **供给 → 一个 ability 节点，它的工具是它的 capabilities**。旧模型里
 *   `ability` 与 `capability` 是两种东西（内置/kinds/健康），新模型只有一个：
 *   一条 `tools` 声明（= 一台供给）+ 它下面的函数。
 * - **智能体 = 基于别人的执行者**（`based_on` 非空）。所以 `agents` 不是另一类
 *   对象，是执行者列表里挑出来的一层——分开画，是因为配置舱就是按这两种角色看的。
 * - **开关在声明里**（`source` 只有一个答案），但「意图 / 观测」两列不变：
 *   关着和起不来仍然是两句话（`activation` / `problem`）。
 */
export function mapLiveState(raw: LiveState): GatewaySnapshot {
  const objects: GatewayObject[] = [];
  const abilities: GatewayAbility[] = [];
  const capabilities: GatewayCapability[] = [];

  for (const supply of raw.registry.capabilities) {
    const ref = `supply:${supply.name}`;
    abilities.push({
      ability: {
        ability_ref: ref,
        kind: 'supply',
        version: '',
        source: supply.package,
        label: supply.name,
        state: supply.status,
        health: supply.usable ? 'online' : 'offline',
        // 关着的供给**没有函数名**（工具清单是问出来的）——那句话要说在前面
        metadata: { description: supply.detail || supply.problem },
      },
      capabilities: supply.tools.map((tool) => tool.tool_id),
      // `tools_from` 写的是**供给名**（后端按它查"这个执行者被允许用哪些工具"），
      // 而 `ability_ref` 是配置状态里的键——两个都用过一遍才发现拿后一个去写
      // 是写不进去的：找不到就是"一个工具都不许用"，而且不报错。
      supply: supply.name,
    });
    for (const tool of supply.tools) {
      capabilities.push({
        tool_id: tool.tool_id,
        function_name: tool.tool_id.slice(tool.tool_id.indexOf('.') + 1),
        approval_required: supply.approval_required,
        input_schema: tool.input_schema,
        ability_ref: ref,
        active: supply.usable,
      });
    }
  }

  for (const pkg of raw.registry.packages) {
    // 这个包里有没有**跑在宿主进程里**的代码（包内实现的工具）——有的话，
    // 关掉它之后要说清"重启才卸得干净"
    const loaded = raw.registry.capabilities.some(
      (supply) => supply.package === pkg.id && supply.loaded);
    objects.push(objectRow(`extension.${pkg.id}`, 'package', pkg.enabled, loaded));
  }
  for (const executor of raw.registry.executors) {
    // 智能体不是另一个范畴：它就是"配置过的执行者"
    const isAgent = Boolean(executor.based_on);
    objects.push(objectRow(isAgent ? `agent.${executor.name}` : `executor.${executor.name}`,
                           isAgent ? 'agent' : 'executor', executor.enabled));
  }
  for (const schedule of raw.registry.schedules) {
    objects.push(objectRow(`schedule.${schedule.name}`, 'schedule', schedule.enabled));
  }
  // 供应商也是一个**可配置对象**：它有一条 `enabled`（`_providers/<name>.yaml` 里那一行）
  for (const provider of raw.registry.providers) {
    objects.push(objectRow(`provider.${provider.name}`, 'provider', provider.enabled));
  }

  const supplyByName = new Map(raw.registry.capabilities.map((item) => [item.name, item]));
  // 包清单里那个名字——**人认的是它**，而 `executor.name` 是目录名（引用）
  const packageLabelById = new Map(
    raw.registry.packages.map((pkg) => [pkg.id, pkg.name || pkg.id]));

  /**
   * 一条执行者的**人读名称**
   *
   * 声明里只写了条目名（`langgraph.agent`），人认的那个名字长在**包**上
   * （`langgraph-agent` 的 `name: LangGraph Agent`）。所以：
   *
   * - 包里只有它一条 → 包名就是它的名字；
   * - 一个包声明了好几条 → 光有包名，几行会一模一样，那时候要带上条目名
   *   （`天气 · weather.backfill`）——**下拉里两行长得一样等于选哪个都不知道**。
   *
   * 返回值只用于显示：提交的、认对象的永远是 `id` / `ref`。
   */
  const executorEntriesPerPackage = new Map<string, number>();
  for (const executor of raw.registry.executors) {
    executorEntriesPerPackage.set(
      executor.package, (executorEntriesPerPackage.get(executor.package) ?? 0) + 1);
  }
  const humanNameOf = (executor: { name: string; package: string }): string => {
    const label = packageLabelById.get(executor.package) ?? '';
    if (!label || label === executor.name) return executor.name;
    return (executorEntriesPerPackage.get(executor.package) ?? 0) > 1
      ? `${label} · ${executor.name}`
      : label;
  };
  const agents: GatewayAgent[] = raw.registry.executors
    .filter((executor) => Boolean(executor.based_on))
    .map((executor) => {
      const owned = executor.tools_from.flatMap(
        (name) => supplyByName.get(name)?.tools ?? []);
      return {
        agent_ref: `agent.${executor.name}`,
        // 标题是清单里那个名字；身份（`agent_ref`）还是执行者名，那是引用
        label: packageLabelById.get(executor.package) || executor.name,
        description: executor.package,
        // 它自己所属的那个包：配置舱靠它把"作为扩展的那一份"去掉（见类型注释）
        package: executor.package,
        executor_config_ref: executor.based_on,
        model_ref: executor.model?.provider && executor.model?.name
          ? agentModelRef(executor.model.provider, executor.model.name)
          : '',
        system_prompt: '',
        packages: [...executor.tools_from],
        parameters: {},
        revision: 1,
        tool_ids: owned.map((tool) => tool.tool_id),
        tools: owned.map((tool) => {
          const declared = supplyByName.get(tool.tool_id.split('.')[0])?.approval_required ?? true;
          const tightened = executor.tighten.includes(tool.tool_id);
          // 生效值由**后端那条规则**算（declared or tightened），前端不重算
          return { tool_id: tool.tool_id, declared, effective: declared || tightened,
                   tightened_by_agent: tightened };
        }),
        activation: executor.enabled ? 'enabled' : 'disabled',
      };
    });

  return {
    tasks: raw.tasks.map((task, index) => ({
      id: task.task_id,
      type: 'task' as const,
      label: task.summary ?? task.task_id,
      x: 180 + (index % 4) * 220,
      y: 140 + Math.floor(index / 4) * 200,
      // 契约漂移时归到 'created'，并在界面上表现为「未启动」而不是伪造某个终态
      status: KNOWN_STATUSES.includes(task.status as TaskNode['status'])
        ? (task.status as TaskNode['status'])
        : 'created',
      delegation_summary: task.summary,
      // 归档过的才带这一格：档案馆里那两步（归档 / 删除）按它决定给哪一个
      archived_at: task.archived ? task.updated_at : undefined,
      executor_config_id: task.executor_ref,
      pending_tool_id: task.pending?.tool_id,
      state_version: task.state_version,
      approval_state:
        task.pending?.decision === 'pending' ? 'pending'
        : task.pending?.decision === 'approved' ? 'approved'
        : task.pending?.decision === 'denied' ? 'denied'
        : undefined,
    })),
    events: Object.fromEntries(raw.tasks.map((task) => [task.task_id, task.events ?? []])),
    controllers: Object.fromEntries((raw.workers ?? []).map((worker) => [worker.task_id, {
      task_id: worker.task_id,
      worker_alive: worker.alive,
      status: worker.alive ? 'running' : 'exited',
      worker_unreconciled: worker.unreconciled,
    }])),
    capabilities,
    abilities,
    declarations: raw.declarations ?? [],
    executors: raw.registry.executors.map((executor) => ({
      /*
        **`id` 和执行者的名字是同一个东西**，而它必须填。

        两个下拉和一个分组都靠它（`groupExecutorsByProvider` / `taskExecutorChoices`
        取的就是 `executor.id`，没有回退）——少填它，新建任务的下拉整个是空的，
        配置舱里所有执行者挤进"未标注供应商"，而两处**都不报错**，
        只是安静地少掉一整个列表。
      */
      id: executor.name,
      ref: executor.name,
      /*
        **人认的是包名，不是条目名。** 以前这一格直接写 `executor.name`，于是所有
        取值 `display_name` 的下拉都印着 `langgraph.agent`——而画布上那张卡片写的是
        「LangGraph Agent」。同一条执行者在两处两个名字。
      */
      display_name: humanNameOf(executor),
      description: executor.package,
      package: executor.package,
      type: executor.based_on ? 'agent' : 'worker',
      provider: executor.model?.provider,
      /*
        **供应商由"用哪个模型"说出来**，不由执行者 id 的前缀说。

        老后端有个 `resolve_provider_id()`：清单写了 `provider:` 就用它，没有模型段
        的归 `localFunction`。那个函数在新树里没有了，而这一格是**分组和两个下拉的
        轴**——少填它，新建任务的下拉就是空的、配置舱里所有执行者挤进"未标注供应商"。
        规则照旧那条，只是改由这里算：**没有模型段的执行者就是本地写死的那些**。
      */
      provider_id: executor.model?.provider ?? LOCAL_FUNCTION_PROVIDER,
      model: executor.model?.name,
      // 基座自己说它要不要模型——界面上「模型」那一格出不出现就看它
      needs_llm: executor.needs_llm,
      runnable: executor.runnable,
      why_not: executor.why_not,
    })),
    agents,
    // 配置舱那棵树**原样过一道**：它就是结构，前端不在这里重新组织
    console: raw.console ?? [],
    providers: raw.registry.providers,
    schedules: raw.registry.schedules.map((schedule) => ({
      schedule_id: schedule.name,
      name: schedule.name,
      cron: schedule.cron,
      timezone: schedule.timezone,
      enabled: schedule.enabled,
      executor_config_ref: schedule.executor_ref,
      task_ref: schedule.task_ref,
    })),
    dispatches: (raw.dispatches ?? []).map((item) => ({
      occurrence_key: item.occurrence_key,
      schedule_id: item.schedule_id,
      task_ids: item.task_id ? [item.task_id] : [],
      status: item.status,
      error: item.detail,
      updated_at: item.updated_at,
    })),
    objects,
    // **输出原样过一道**：形状归后端，前端不在这里重新组织（同 `console`）
    outputs: raw.outputs ?? [],
    // **这两个概念没有了**：MCP 服务器现在是一条 `url` 供给，设备是一个包。
    // 留着空数组，是为了让界面把"这一类还是空的"和"这一类不存在了"分开说。
    mcp: [],
    devices: [],
  };
}

export async function getGatewaySnapshot(): Promise<GatewaySnapshot> {
  if (DATA_SOURCE === 'mock') {
    const { buildMockSnapshot } = await import('../mock/snapshot');
    return buildMockSnapshot();
  }
  const response = await fetch(`${base}/api/state`);
  if (!response.ok) throw new GatewayError(await errorMessage(response, 'Gateway snapshot failed'), response.status);
  return mapLiveState(await response.json() as LiveState);
}

/**
 * 引用里的 `/` 不能编码掉
 *
 * 后端的路由是 `{ref:path}`，正是因为引用里可以有斜杠（模型名 `Qwen/Qwen3`）。
 * 整串 `encodeURIComponent` 会把它变成 `%2F`，路径段于是被拆开——请求打在一个
 * 不存在的路由上。所以按段编码、按段拼接：`/` 保持是分隔符，其余照常转义。
 */
function encodeRefPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

/**
 * 解析一个引用：**三态**（ADR-024）
 *
 * 这是引用解析的权威口——快照里的那些清单是**批量**视图，而这里是按对象重读
 * （§8：状态一律来自对象重读）。三态缺一不可：`resolvable` 能用、`offline`
 * 系统知道它曾经是什么（给最小占位 + 原因）、`unknown` 系统不知道它是什么。
 * 把 offline 与 unknown 合成一个「查不到」，用户就失去了「这是停用还是打错了」
 * 这个唯一能自救的信息。
 */
export async function resolveObject(ref: string): Promise<ResolvedReference> {
  const response = await fetch(`${base}/api/objects/${encodeRefPath(ref)}`);
  if (!response.ok) throw new GatewayError(await errorMessage(response, '引用解析失败'), response.status);
  const wire = await response.json() as {
    kind: string;
    name: string;
    state: ReferenceState;
    detail: string;
    referable: boolean;
  };
  return {
    ref,
    // 键的拼法只有一处（`objectRefOf` 那份约定）：executor.foo / agent.bar
    object_ref: wire.kind && wire.name ? `${wire.kind}.${wire.name}` : '',
    state: wire.state,
    kind: wire.kind,
    activation: wire.referable ? 'enabled' : '',
    reason: wire.detail,
  };
}

/**
 * 把一份正文放进工作区，**拿回落点**（相对工作区的路径）
 *
 * 这是表单上那个「选择文件」的第二步。浏览器里的系统对话框**只给内容和名字、
 * 不给路径**（`File.path` 只有 Electron 那类桌面壳里才有），而 `task_ref` 要的
 * 正是相对工作区的路径——所以这条路的形状是：选一份 → 存进工作区 → 把落点填回
 * 那一格。用户看得见自己拿到的是哪一份。
 *
 * **它不在命令面上**：命令面是"改内核认的事实"，而这只往工作区写了一个文件——
 * 和 `resolveObject` / `getTaskResult` 一样，是按需读写的旁路。
 *
 * 正文是**文本**（`inputs.read` 读的就是 utf-8），所以走 JSON 不走 multipart：
 * 不必为此多一个依赖。超了上限后端会说，原因原样带上来。
 */
export async function uploadWorkspaceFile(name: string, text: string): Promise<string> {
  const response = await fetch(`${base}/api/workspace/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, text }),
  });
  if (!response.ok) {
    throw new GatewayError(await errorMessage(response, '这份正文没能放进工作区'), response.status);
  }
  const wire = await response.json() as { path?: string };
  return String(wire.path ?? '');
}

/**
 * 一条命令的回执
 *
 * `accepted` 是**命令面**的答复（校验过没过）；`data.auto_resume` 是**控制侧**
 * 接下来做没做成那件事（批准写进链了，但恢复可能没起来）。两件事分开说——
 * 合成一个 `ok` 会让"批准生效了、但任务还卡着"看不出来。
 */
export interface GatewayCommandResponse {
  accepted: boolean;
  command_result: { task_id?: unknown } | null;
  data: Record<string, unknown>;
  error: string;
}

export async function sendGatewayCommand(
  command: string,
  taskId = '',
  payload: Record<string, unknown> = {}
): Promise<GatewayCommandResponse> {
  const origin = base || (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8000');
  const response = await fetch(`${origin}/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // 新的命令面只有两个字段：命令名 + 载荷。`task_id` 是载荷的一部分
    // （它是"这条命令冲着哪个 Task 去"，不是另一个通道）。
    body: JSON.stringify({ command, payload: taskId ? { ...payload, task_id: taskId } : payload }),
  });
  const wire = await response.json().catch(() => ({})) as {
    ok?: boolean;
    dirty?: string;
    decision?: string;
    data?: Record<string, unknown>;
    error?: string;
  };
  if (response.status === 400) {
    // **校验没过**（新后端把它说成 400，把服务端自己的 bug 留给 500）。
    // 那句原因要原样带到界面上——用户只能靠它知道该改哪儿。
    throw new CommandRejectedError(wire.error || `${command} 被拒绝，但后端没有给出原因`);
  }
  if (!response.ok) {
    throw new GatewayError(wire.error || (await errorMessage(response, 'Gateway command failed')),
                           response.status);
  }
  return {
    accepted: wire.ok !== false,
    command_result: { task_id: (wire.data ?? {}).task_id },
    data: wire.data ?? {},
    error: wire.error ?? '',
  };
}

/**
 * 命令被拒绝
 *
 * 网关用 **HTTP 200 + `{accepted: false, error}`** 表达「校验没过」，而 `error`
 * 是给人看的中文原因（「这些工具的能力声明已经是「必须审批」，不能也不需要再收紧」）。
 * 混进 HTTP 错误里把它说成「请求失败」，等于把后端唯一想说的那句话丢掉——
 * 用户就只能靠猜改哪里。
 */
export class CommandRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandRejectedError';
  }
}

/**
 * 提交一条命令，并把「已接受」当成前置条件
 *
 * 只检查 HTTP 状态是不够的：200 也可能是拒绝。**accepted 不等于成功**，
 * 但 `accepted: false` 确定是失败。
 */
async function sendAccepted(
  command: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await sendGatewayCommand(command, '', payload);
  if (!response.accepted) {
    throw new CommandRejectedError(response.error || `${command} 被拒绝，但后端没有给出原因`);
  }
  return (response.data ?? {}) as Record<string, unknown>;
}

/**
 * 开关命令的回执
 *
 * `status` 是「当场生效」的结果，`activation.enabled` 是**用户的选择**——
 * 两者可以不一致，那正是这个结构存在的理由：你要它开着，但它没起来。
 */
export interface ActivationOutcome {
  object_ref: string;
  /** 用户最后的选择。失败时它保持用户要的那个值，不被结果改写 */
  enabled: boolean;
  /** started | already | loaded | stopped | filtered | failed */
  status: string;
  /** 失败原因（后端原文）；成功时为空 */
  diagnostic: string | null;
  /** 这段代码已经进过宿主进程：重启才卸得掉 */
  restart_required: boolean;
}

/**
 * 改一个可配置对象的开关
 *
 * **唯一的开关命令**（ADR-025）：扩展包 / MCP / 设备 / 执行者 / 智能体 / 日程
 * 都走它，按对象类型分组只是命令自描述的事。`kind` 必须一起给：后端要靠它
 * 决定这一步是「真的启动/停止」还是「只改一个过滤标记」。
 */
/**
 * 改一个包里的某一条**列表条目**：**整列交回去**
 *
 * 声明只有顶层字段可改（`extensions/writer.py`：凭空加一栏等于改声明），而条目
 * 住在 `tools` / `executors` 列表里。所以改一条就得交回整列——而整列从**快照给的
 * 声明原文**里取，不照着成品列表拼（那样会丢掉 `url` / `entrypoint`）。
 */
export async function rewriteEntry(
  declarations: LiveDeclaration[],
  packageId: string,
  listName: 'tools' | 'executors',
  entryName: string,
  changes: Record<string, unknown>
): Promise<void> {
  const declared = declarations.find((item) => item.id === packageId);
  if (!declared) throw new CommandRejectedError(`快照里没有这个包: ${packageId}`);
  const entries = (declared[listName] ?? []) as Record<string, unknown>[];
  let hit = false;
  const rewritten = entries.map((entry) => {
    if (entry.name !== entryName) return entry;
    hit = true;
    return { ...entry, ...changes };
  });
  if (!hit) {
    throw new CommandRejectedError(`${packageId} 的 ${listName} 里没有 ${entryName}`);
  }
  await sendAccepted('manifest.write', {
    target: 'package', name: packageId, field: listName, value: rewritten,
  });
}

/** `extension.weather` / `schedule.weather.daily` → 容器 + 名字 */
function splitObjectRef(objectRef: string): { target: string; name: string } | null {
  const cut = objectRef.indexOf('.');
  if (cut <= 0) return null;
  const prefix = objectRef.slice(0, cut);
  const name = objectRef.slice(cut + 1);
  // 智能体与执行者在声明里都是**包里的 executors 条目**
  const target = prefix === 'extension' ? 'package' : prefix;
  return { target, name };
}

/**
 * 那个开关：**关掉一个东西 = 写它那份声明里的一行**
 *
 * 四种容器各有各的写法，但都是"改声明"：
 *
 * | 对象 | 怎么关 |
 * | --- | --- |
 * | `extension.<id>` | `set_enabled`（包层那一行） |
 * | `schedule.<name>` / `provider.<name>` | `set_enabled`（它们各自一个文件） |
 * | `executor.<name>` / `agent.<name>` | **整列重写**（它们是包里的条目） |
 */
export async function setConfigEnabled(
  objectRef: string,
  enabled: boolean,
  declarations: LiveDeclaration[] = []
): Promise<ActivationOutcome> {
  const found = splitObjectRef(objectRef);
  if (!found) throw new CommandRejectedError(`不认识这个对象: ${objectRef}`);
  if (found.target === 'package' || found.target === 'schedule' || found.target === 'provider') {
    await sendAccepted('set_enabled', { target: found.target, name: found.name, enabled });
  } else if (found.target === 'executor' || found.target === 'agent') {
    const owner = declarations.find((item) =>
      (item.executors ?? []).some((entry) => (entry as { name?: unknown }).name === found.name));
    if (!owner) throw new CommandRejectedError(`快照里没有这个执行者: ${found.name}`);
    await rewriteEntry(declarations, owner.id, 'executors', found.name, { enabled });
  } else {
    throw new CommandRejectedError(`这类对象不能开关: ${objectRef}`);
  }
  // 生效与否**以重读为准**（快照里的 enabled / status 才是答案），回执只说"已提交"
  return {
    object_ref: objectRef,
    enabled,
    status: '',
    diagnostic: null,
    restart_required: false,
  };
}

/** 智能体定义的提交形状。`tighten` 只装「收紧」这一个方向（ADR-027） */
/**
 * 编辑智能体时提交的东西
 *
 * **智能体就是一个包**（`extensions/<id>/manifest.yaml` 里写 `executor:` 的那一条），
 * 所以"保存"= **写一份声明**，走命令面的那两条（`manifest.create` / `manifest.write`）。
 * 没有第二个存智能体的地方——那就没有两份会漂移的事实。
 */
export interface AgentUpsertInput {
  /** 包目录名。**它同时是执行者条目的名字**（`agent.<id>` 那个 id） */
  id: string;
  label: string;
  description: string;
  /** 基座：基于哪段代码（一条带 worker 的执行者） */
  base: string;
  /** 用哪家的哪个模型。拼法就是 `provider:model`（见 `agentModelRef`） */
  modelRef: string;
  system_prompt: string;
  /** 能用哪些供给——名单为空等于一个都不许 */
  packages: string[];
  tighten: string[];
  /** 新建还是改一份已有的（同一个形状，两条命令） */
  creating?: boolean;
}

/** 供应商的模型 → 选择器里的一格。`provider:model` 这个拼法只有这一处 */
export function agentModelRef(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export function splitAgentModelRef(ref: string): { provider: string; name: string } {
  const cut = ref.indexOf(':');
  return cut < 0
    ? { provider: ref.trim(), name: '' }
    : { provider: ref.slice(0, cut).trim(), name: ref.slice(cut + 1).trim() };
}

/** 可选的模型：把每家供应商的 `models[]` 摊开（分组轴是供应商） */
export function agentModelGroups(snapshot: GatewaySnapshot): SelectGroup[] {
  return (snapshot.providers ?? [])
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      key: provider.name,
      label: provider.name,
      options: (provider.models ?? [])
        .map((model) => String((model as { name?: unknown }).name ?? ''))
        .filter(Boolean)
        .map((name) => ({ value: agentModelRef(provider.name, name), label: name })),
    }))
    .filter((group) => group.options.length > 0);
}

/** 一份智能体声明的样子（**它的形状由契约表定**，不在这里另发明一套） */
export function agentManifest(input: AgentUpsertInput): Record<string, unknown> {
  const { provider, name } = splitAgentModelRef(input.modelRef);
  return {
    id: input.id,
    name: input.label,
    description: input.description,
    executors: [{
      name: input.id,
      executor: input.base,
      /*
        **没有模型就不写这一栏。** 基座是 `needs_llm: false` 的那种（一段写死的
        代码）时，界面上根本不问模型——这一栏要是照写，落进去的就是
        `model: {provider: "", name: ""}`：一份看着配了模型、其实一个字段都没有的
        声明，而它还会盖掉基座自己声明过的模型（`configured()` 里 model 是
        "配置优先、缺省继承基座"）。
      */
      ...(provider || name ? { model: { provider, name } } : {}),
      prompt: { system: input.system_prompt },
      tools_from: [...input.packages],
      tighten: [...input.tighten],
    }],
  };
}

export interface AgentUpsertOutcome {
  /** 后端算出来的定义（含由包集并集而来的工具）；没算出来时为 null，不伪造一个 */
  agent: GatewayAgent | null;
  revision: number;
  tools: GatewayToolSpec[];
}

/**
 * 新建 / 修改一个智能体
 *
 * 被拒时抛 `CommandRejectedError`，它的 message 就是后端给的那句中文原因——
 * 直接显示即可，不要改写成「保存失败」。
 */
export async function upsertAgent(input: AgentUpsertInput): Promise<AgentUpsertOutcome> {
  const manifest = agentManifest(input);
  if (input.creating) {
    // 新建智能体 = **建一个新包目录 + 清单**（`extensions/README.md`）
    await sendAccepted('manifest.create', {
      target: 'package', name: input.id, data: manifest,
    });
  } else {
    // 改定义：引用保持稳定，**改动是破坏性的**（ADR-033/035）
    await sendAccepted('manifest.write', {
      target: 'package', name: input.id, field: 'executors',
      value: manifest.executors,
    });
    /*
      名字和说明住**包层**，所以得单独写一遍。

      以前只写 `executors` 那一栏——于是用户在编辑页改了名字、点了保存、看到
      「已保存」，而那份文件一个字没动。**静默不生效比报错糟得多**：
      报错至少会去查一次。
    */
    await sendAccepted('manifest.write', {
      target: 'package', name: input.id, field: 'name', value: input.label,
    });
    await sendAccepted('manifest.write', {
      target: 'package', name: input.id, field: 'description', value: input.description,
    });
  }
  // 算出来的定义不在回执里：它是重读快照的结果，界面不该在这里另存一份
  return { agent: null, revision: 0, tools: [] };
}

/**
 * 删除一个智能体
 *
 * 删的是**包目录**（不可撤销）。还有历史 Task 引用它时会被拒，原因里带着那些
 * 任务 ID——原样显示，用户才知道先去处理哪一个。
 */
export async function deleteAgent(agentId: string): Promise<void> {
  await sendAccepted('manifest.delete', { target: 'package', name: agentId });
}

/** 可改的工具字段。权威是后端 `extensions/writer.py` 的 `EDITABLE_TOOL_FIELDS` */
export const EDITABLE_TOOL_FIELDS = [
  'approval_required',
  'idempotency',
  'enabled',
] as const;
export type EditableToolField = (typeof EDITABLE_TOOL_FIELDS)[number];

/**
 * 每个可改字段是什么类型
 *
 * 必须按**真的类型**提交：布尔字段送字符串 `"true"`，写进 YAML 就变成一个字符串，
 * 而它在下游被按真值读——一处「看起来对」的写入换来一份语义漂移的声明。
 */
export const TOOL_FIELD_KIND: Record<EditableToolField, 'boolean' | 'text'> = {
  approval_required: 'boolean',
  idempotency: 'text',
  enabled: 'boolean',
};

export interface ToolFieldOutcome {
  extension_id: string;
  tool_id: string;
  field: string;
  /** 后端原样回告的值；缺失时为 null，不用请求值冒充 */
  value: unknown;
  /** 改完**已经重载**该包的结果。null 表示这次没有重载（没有激活器） */
  reloaded: ActivationOutcome | null;
}

/**
 * 改一个工具在 manifest 里的一个字段
 *
 * 改的是**哪个包的哪个工具**必须由调用方明确给出：`extension_id` 是包目录名，
 * 不是 `extension.<id>` 那个引用——后端按目录去定位 manifest。
 *
 * 没显式声明的字段（继承自 defaults）会被拒：凭空加一个字段等于改变声明本身，
 * 那不该是一次点按的结果。
 */
export async function setToolField(
  edit: {
    /** 包目录名 */
    extensionId: string;
    /** 工具全名（`供给名.函数名`）——条目名是它前半截 */
    toolId: string;
    field: EditableToolField;
    value: unknown;
  },
  declarations: LiveDeclaration[] = []
): Promise<ToolFieldOutcome> {
  const supply = edit.toolId.split('.')[0];
  await rewriteEntry(declarations, edit.extensionId, 'tools', supply, { [edit.field]: edit.value });
  return {
    extension_id: edit.extensionId,
    tool_id: edit.toolId,
    field: edit.field,
    value: edit.value,
    // 重载是**后端做完写入之后自己做的**（`facade` 里那两条一步的），回执不重复报
    reloaded: null,
  };
}

/** 一条日程可编辑的那几栏。**`name` 不在里面**——它是身份，见 `upsertSchedule` */
export interface ScheduleUpsertInput {
  /** 日程的身份（声明里的 `name`）。**建出来之后不再改** */
  scheduleId: string;
  cron: string;
  timezone: string;
  /**
   * 输入引用：工作区里那份正文。**可以留空**（和新建任务那一格同一条规矩）
   *
   * 留空 = 没有正文：`tasks/inputs.py::read` 的第一行就是 `if not task_ref: return ""`。
   * 写错路径的代价是**派发时那一次不起**（`InputMissing` → 一条 FAILED）——
   * 而"编一个不存在的文件名"比留空更糟，那会每次都失败。
   */
  taskRef: string;
  executorRef: string;
  /** 新建还是改一条已有的（同一张表单，两条路） */
  creating?: boolean;
}

/**
 * 新建 / 修改一条日程
 *
 * 日程不是包，它一条就是一个文件（`extensions/_schedules/<name>.yaml`），
 * 所以两条路走的都是声明那几条命令：新建是 `manifest.create`，改是 `manifest.write`。
 *
 * ## 为什么改的时候是**一栏一条命令**
 *
 * 后端的 `set_field` 一次只改一栏（`extensions/writer.py`）——它按名字找到那份文件、
 * 只动那一行。前端不另造一条"整份覆盖"的命令：覆盖会把文件里用户自己写的注释
 * 和别的栏目一起抹掉，而这份文件是给人看的。
 *
 * ## 为什么 `name` 不给改
 *
 * 它是身份，不是标题：配置状态的键（`schedule.<name>`）、派发记录的 `schedule_id`、
 * 已经建出来的那些子 Task 的归属，全按它走。改一个字，这条日程的历史就断在那儿
 * ——子 Task 会变成"没有人认领"的那些，而它们在外层是不显示的。
 * 所以编辑页里那一格只显示、不接收输入。
 */
export async function upsertSchedule(input: ScheduleUpsertInput): Promise<void> {
  if (input.creating) {
    await sendAccepted('manifest.create', {
      target: 'schedule',
      name: input.scheduleId,
      data: {
        name: input.scheduleId,
        cron: input.cron,
        timezone: input.timezone,
        /*
          **留空就不写这一栏**：一份干净的声明里本来就不该出现 `task_ref: ''`
          ——那是个空转的键（和智能体"没有模型就不写 model"同一条）。
        */
        ...(input.taskRef ? { task_ref: input.taskRef } : {}),
        executor_ref: input.executorRef,
      },
    });
    return;
  }
  const fields: [string, string][] = [
    ['cron', input.cron],
    ['timezone', input.timezone],
    ['executor_ref', input.executorRef],
    /*
      改的时候**照写**（空串也写）：这一格在表单上，所以清空它是用户的动作。
      不写的话文件里那一行还在，用户明明清掉了它却照旧生效——"我改了但它没变"
      正是这一步要避免的。（`set_field` 只能改一栏、删不掉一个键，空串是它
      说"没有正文"的方式。）
    */
    ['task_ref', input.taskRef],
  ];
  for (const [field, value] of fields) {
    await sendAccepted('manifest.write', {
      target: 'schedule', name: input.scheduleId, field, value,
    });
  }
}

/**
 * 删掉一条日程：**连它派出去的子 Task 一起**（不可撤销）
 *
 * 走的不是 `manifest.delete`——那条路只删文件，而子 Task 归**这条日程**管
 * （外层看不见它们、馆里也不装），声明一没它们就没有归属了。所以后端有
 * `schedule.delete`：先把那些 Task 处理掉（在跑的先取消，再归档、再删），
 * 最后才删那份声明。`manifest.delete` 现在会直接拒掉 target=schedule，
 * 理由里就写着该走哪条。
 */
export async function deleteSchedule(scheduleId: string): Promise<void> {
  await sendAccepted('schedule.delete', { name: scheduleId });
}

/** 立即跑一次：命令名和参数名都以**声明里的那个名字**为准（`name`） */
export async function triggerSchedule(scheduleId: string): Promise<void> {
  await sendAccepted('schedule.trigger', { name: scheduleId });
}

/**
 * 取新建任务的 ID
 *
 * `command_result.task_id` 是命令结果里的权威位置，`data.task.task_id`
 * 是同一件事的展开视图。两处都没有就说明后端没按契约回 —— 这时必须报错，
 * 不能编一个 ID 继续往下走。
 */
function createdTaskId(response: GatewayCommandResponse): string {
  const fromResult = response.command_result?.task_id;
  if (typeof fromResult === 'string' && fromResult) return fromResult;
  const nested = (response.data as { task?: { task_id?: unknown } } | undefined)?.task?.task_id;
  return typeof nested === 'string' ? nested : '';
}

export interface NewTaskInput {
  /** 委托摘要：这件事本身是什么 */
  summary: string;
  /** 输入引用：工作区内的委托原文，执行者读到的就是它的内容 */
  taskRef: string;
  executorConfigRef: string;
}

/**
 * 创建 Task（真实 Core 命令）
 *
 * 返回的 ID 来自后端，不用前端猜；节点要等重新读取快照之后才出现。
 */
export async function createTask(input: NewTaskInput): Promise<string> {
  const response = await sendGatewayCommand('create_task', '', {
    summary: input.summary,
    task_ref: input.taskRef,
    // 内核那一条命令收的是 `executor_ref`（名字里那半截"配置"没有了）
    executor_ref: input.executorConfigRef,
  });
  const taskId = createdTaskId(response);
  if (!taskId) throw new Error('create_task 已被接受，但后端没有返回 task_id');
  return taskId;
}

/** 启动 Worker（真实 Core 命令）：只表示命令被接收，真实状态以重读为准 */
export async function startTask(taskId: string): Promise<void> {
  await sendGatewayCommand('start_task', taskId, {});
}

/**
 * 该 Task 的 Worker 是否在运行
 *
 * 这是 **Controller 的观测**，不是 Core 状态。返回 `undefined` 表示没有观测
 * 记录，调用方必须按「未知」处理——没有观测不等于没有 Worker。
 */
export function workerAliveOf(snapshot: GatewaySnapshot, taskId: string): boolean | undefined {
  const observation = snapshot.controllers?.[taskId];
  return observation ? Boolean(observation.worker_alive) : undefined;
}

/**
 * 该 Task 可能还有 Worker 在外面跑着（上一次后端被杀留下的孤儿）
 *
 * 这是 `worker_alive` 之外的第四种情况，**不能塌进 `false`**：重启之后
 * Controller 手里必然没有句柄，`worker_alive` 一定是 false，但外面那个进程
 * 可能还活着并持有同一条 LangGraph 线程。按 false 处理就会给出「启动 Worker」，
 * 点一下就起第二个写者。后端探测到 pid 还活着时才会置位。
 */
export function workerUnreconciledOf(snapshot: GatewaySnapshot, taskId: string): boolean {
  return Boolean(snapshot.controllers?.[taskId]?.worker_unreconciled);
}

/** Task 的执行结果 */
export interface TaskResult {
  /** 结果正文；非文本结果给的是 JSON 原文，不加工 */
  text: string;
  structured: boolean;
}

/** 一次 Agent 工具调用的状态：只由「有没有对应的工具应答」决定 */
export type AgentCallStatus = 'completed' | 'failed' | 'pending';

/**
 * Agent 审计里的一次调用
 *
 * 来自执行者外围的 checkpoint（`GET /api/tasks/{id}/agent-audit`），
 * 不是从 Core Event 拼出来的。参数与结果是原文，前端不加工也不推测状态。
 */
export interface AgentCall {
  /** 外围给的稳定调用标识（LangGraph 的 tool_call id） */
  call_id: string;
  tool_id: string;
  args: Record<string, unknown>;
  status: AgentCallStatus;
  result?: unknown;
  /**
   * checkpoint 不记每次调用的时间。缺失时显示调用序位——
   * 不用其他时间凑，也不用读取时间冒充调用时间。
   */
  timestamp?: string;
  context_refs?: string[];
}

/** Agent 审计投影 */
export interface AgentAudit {
  /** 读不到就是 false；它和「读到但为空」是两件事 */
  available: boolean;
  /**
   * 这个执行者是哪一种——**由后端答**，前端不自己推。
   *
   * - `agent`：智能体，跑一轮是一串消息 → 多卡（完整的人机交互）
   * - `plain`：没有过程可读，只有一次输入一次输出 → 单卡
   *
   * 前端手里另有一份执行者列表（`snapshot.executors[].type`），推得出同样的结论，
   * 但那是**第二条推导路径**，而两条路径会漂开（夹具里所有执行者都写着 `worker`，
   * 推出来就是"全是固定代码"，多卡一次都画不出来）。查注册表的人就是知道的人。
   *
   * 读的是旧后端时可能没有这一格，所以是可选。
   */
  kind?: 'agent' | 'plain';
  source: string;
  read_at: string;
  calls: AgentCall[];
  /**
   * **完整消息序列**——checkpoint 里存的那一串，按顺序。
   *
   * `calls` 只是这个序列折出来的一个**工具视角**；只画 `calls` 会丢掉
   * 系统提示、人的输入、以及模型每一次说的话（尤其最后那段结论）。
   * 两者不是"多和少"，是**同一份东西的两个看法**。
   */
  turns?: AgentTurn[];
}

/** 一条消息。`tool` 那一种带工具名和成没成 */
export interface AgentTurn {
  role: 'system' | 'human' | 'ai' | 'tool' | string;
  text: string;
  /** 只有 `tool` 那一种有 */
  tool_id?: string;
  /** 只有 `tool` 那一种有 */
  status?: string;
  /**
   * 只有 `ai` 那一种有：**这一轮要调的那些工具**（名字 + 参数）。
   *
   * 没有它，消息序列里只看得到"模型说了一句话"，看不到"所以它接下来要干什么"——
   * 而中间那一环正是审计最要看的东西。结果不在这里（按 `call_id` 去 `calls` 里找）。
   */
  calls?: { call_id: string; tool_id: string; args: Record<string, unknown> }[];
}

/**
 * 读取一个 Task 的 Agent 执行过程
 *
 * 和结果一样按需读：它是 checkpoint 里的消息序列，塞进每次刷新都重拉的
 * 快照不合适。
 */
export async function getAgentAudit(taskId: string): Promise<AgentAudit> {
  const response = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/agent-audit`);
  if (!response.ok) throw new GatewayError(await errorMessage(response, 'Agent 审计读取失败'), response.status);
  const body = await response.json() as AgentAudit;
  return { ...body, calls: body.calls ?? [] };
}

/**
 * 读取一个 Task 的执行结果
 *
 * 结果**不在**全局快照里：它是每个 Task 一份的大文本，塞进每次 SSE 都重拉的
 * 快照会把一次刷新变成 N 次 checkpoint 读取。按需读单个 Task 更合算。
 *
 * 后端有两处会给结果，形状不同：本次运行结束时的内存结果用 `result`，
 * 从 checkpoint 回读时用 `text`。两处都要认，只认一个会在某种情况下显示成空。
 */
export async function getTaskResult(taskId: string): Promise<TaskResult | null> {
  const response = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}`);
  if (!response.ok) throw new GatewayError(await errorMessage(response, 'Task 读取失败'), response.status);
  const body = await response.json() as { output?: unknown };
  return normalizeResult(body.output);
}

function normalizeResult(output: unknown): TaskResult | null {
  if (!output || typeof output !== 'object') return null;
  const record = output as { ok?: unknown; result?: unknown; text?: unknown };
  if (record.ok !== true) return null;
  const raw = record.text ?? record.result;
  if (typeof raw === 'string') return raw ? { text: raw, structured: false } : null;
  if (raw === undefined || raw === null) return null;
  return { text: JSON.stringify(raw, null, 2), structured: true };
}

/**
 * 心跳是一条**看得见的帧**：`data: {"heartbeat": true}`，不带 `id:`、不带脏标记
 *
 * 新的事实流只说"谁脏了"（`web/streaming.py`）：每帧 `data: {seq, subject_ref}`。
 * 空闲时后端补一条心跳，两条都走 `onmessage`，所以"流还活着"的判据是
 * **多久没听见任何东西**（下面的看门狗）。
 *
 * 早先后端发的是 SSE 注释行 `: 心跳`——**注释行浏览器不交给 JS**，于是空闲的流
 * 在这边看起来和断了没差别，看门狗会一直重连。所以那一行必须是 `data:` 帧。
 */
const HEARTBEAT_KIND = 'heartbeat';

/** 事件流自身的状态。与 `SnapshotStatus` 是两件事：那个说的是「最近一次读快照」 */
export type StreamState = 'connecting' | 'open' | 'retrying';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/**
 * 后端空闲时每 2 秒一次心跳；这么久没听见就当断了
 *
 * 6 秒 = 连丢 3 次心跳，对本地这个周期来说没有歧义。**这个数要和后端的
 * `HEARTBEAT_SECONDS` 配成对**：比它短，后端好好的也会被判成断了。
 * 再长就会让界面在数据已经冻住之后继续声称「实时」更久——那正是要修的东西。
 */
const HEARTBEAT_TIMEOUT_MS = 6000;

/**
 * 订阅网关事件流，断了会自己退避重连
 *
 * 之前这里是 `onerror = () => source.close()`——它把浏览器**自带**的重连也一起
 * 掐掉了，而且没有任何东西告诉界面「流已经死了」。结果是后端一挂，数据永久冻结，
 * 而 HUD 还在绿灯脉冲说「实时」。
 *
 * 取消函数必须同时做三件事：置 `closed`（让在途的 error 不再排下一次连接）、
 * 清掉待触发的 timer、关掉当前连接。StrictMode 下 effect 会 mount→cleanup→mount，
 * 少做一件就会留下两条连接和两个 timer。
 */
export function subscribeGatewayEvents(
  onEvent: () => void,
  onStreamState?: (state: StreamState) => void
): () => void {
  if (typeof EventSource === 'undefined') return () => undefined;

  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let attempt = 0;
  let closed = false;
  /** 最近一次「听见后端说话」的时刻：任何事件或心跳都算 */
  let lastHeardAt = Date.now();
  let reported: StreamState | null = null;

  const report = (state: StreamState) => {
    if (reported === state) return;
    reported = state;
    onStreamState?.(state);
  };

  const scheduleReconnect = () => {
    if (closed || timer !== null) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  };

  /** 收到任何东西都算「后端还在」 */
  const heard = () => {
    lastHeardAt = Date.now();
  };

  const connect = () => {
    if (closed) return;
    lastHeardAt = Date.now();
    report(attempt === 0 ? 'connecting' : 'retrying');
    source = new EventSource(`${base}/api/events`);
    source.onopen = () => {
      attempt = 0;
      lastHeardAt = Date.now();
      report('open');
    };
    source.onmessage = (event: MessageEvent<string>) => {
      // **心跳不算"脏了"**：它只说明后端还在。分不清这两件事，前端会每 15 秒
      // 无谓地重读一次快照（而那条看门狗也就白设了）。
      heard();
      let payload: { heartbeat?: unknown } = {};
      try {
        payload = JSON.parse(String(event.data ?? '{}')) as { heartbeat?: unknown };
      } catch {
        // 解析不了就当一条普通帧：宁可多重读一次，也别漏掉一次变化
      }
      if (payload.heartbeat === true) return;
      // **收到就说"该重读了"**：推的是"谁脏了"，不是"它现在是什么"（ADR-031）。
      onEvent();
    };
    source.addEventListener(HEARTBEAT_KIND, heard);
    source.onerror = () => {
      // 关掉再自己排重连：浏览器原生重连不会退避，而我们要能观察到这个状态
      source?.close();
      source = null;
      if (closed) return;
      report('retrying');
      scheduleReconnect();
    };
  };

  /**
   * 看门狗：`onerror` 不一定会来
   *
   * 反向代理不保证把上游断开传导成客户端可观察的 error——实测后端被杀之后，
   * 已经建立的连接在浏览器侧十几秒都没动静。所以真正的判据是「多久没听见后端
   * 说话了」：后端空闲时每秒发一次心跳，超过若干个周期没动静就是断了，
   * 主动关掉连接走重连。
   */
  watchdog = setInterval(() => {
    if (closed || source === null) return;
    if (Date.now() - lastHeardAt <= HEARTBEAT_TIMEOUT_MS) return;
    source.close();
    source = null;
    report('retrying');
    scheduleReconnect();
  }, Math.max(1000, Math.floor(HEARTBEAT_TIMEOUT_MS / 3)));

  connect();

  return () => {
    closed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (watchdog !== null) {
      clearInterval(watchdog);
      watchdog = null;
    }
    source?.close();
    source = null;
  };
}
