/**
 * 节点类型定义
 *
 * 外层 World 只承认四类视觉节点（world-model.md 第 2 节）：
 *   Task / Schedule / Archive / Configuration
 *
 * 资料节点（ResourceNode）不是外层第五类节点。Executor Configuration、
 * Extension、Capability、Task Definition、Schedule Entry、occurrence 和
 * Archive Record 只在对应父节点的 ChildScene 中出现。
 *
 * 这条区分是硬边界：把资料节点铺到外层会同时污染「只有四类节点」的
 * 外层语义，并让子场景内部的关系线堆到全局空间里。
 */

import type { ScheduleAttention, TaskStatus } from './state';
import type { GatewayObject, GatewayToolSpec, ReferenceState } from '../../api/gateway';

/**
 * 外层世界节点类型
 */
export type NodeType = 'task' | 'schedule' | 'archive' | 'configuration';

/**
 * 画布节点类型（外层四类 + 子场景资料节点）
 */
export type CanvasNodeType = NodeType | 'resource';

/**
 * 基础节点（所有节点的共同属性）
 */
export interface BaseNode {
  /** 节点 ID */
  id: string;

  /** 节点类型 */
  type: NodeType;

  /** 节点标题 */
  label: string;

  /** 初始位置（X 坐标） */
  x: number;

  /** 初始位置（Y 坐标） */
  y: number;
}

/**
 * Task 节点
 * 唯一直接承载 Core 行动状态的外层节点
 */
export interface TaskNode extends BaseNode {
  type: 'task';

  /** Task 状态（生命周期） */
  status: TaskStatus;

  /** 待决策状态（与 status 分离） */
  pending_decision?: {
    /** 决策 ID */
    decision_id: string;
    /** 决策描述 */
    description: string;
    /** 创建时间 */
    created_at: string;
  };

  /** 审批状态（paused 时） */
  approval_state?: 'pending' | 'approved' | 'denied';

  /** 失败确认（failed 时） */
  acknowledged_failure?: boolean;

  /** 成功确认（succeeded 时） */
  acknowledged_success?: boolean;

  /** 委托摘要 */
  delegation_summary?: string;

  /** 持续时间（秒） */
  duration?: number;

  /** Executor Configuration 引用 */
  executor_config_id?: string;

  /** pending Capability（如果有 pending_tool_id） */
  pending_tool_id?: string;

  /**
   * 状态修订号
   *
   * 由 Core 每次状态变更递增。它是修订号，**不是**乐观锁 token，
   * 也不能替代事件链——只在预览里告诉用户「这份预览基于哪个版本」。
   */
  state_version?: number;

  /**
   * 归档时间
   *
   * 只由 ArchiveProjection 在档案馆视图下附加，不是 Task 领域字段。
   * 缺失时不显示，不用其他时间凑。
   */
  archived_at?: string;
}

/**
 * Schedule 节点
 *
 * 自动化外围对象，不是 Core 第五原语。它的环是子 Task 注意力的聚合投影，
 * 不拥有自己的 Core 生命周期状态。
 */
export interface ScheduleNode extends BaseNode {
  type: 'schedule';

  /** 聚合状态（子 Task 注意力的聚合投影，不是新状态机） */
  aggregated_state: ScheduleAttention;

  /** 规则摘要 */
  rule_summary?: string;

  /** 启用状态 */
  enabled: boolean;

  /** 子 Task 数量（由 occurrence 派生，不是外围侧写死的值） */
  child_task_count: number;
}

/**
 * Archive 节点
 *
 * 外层只显示档案馆入口，不把历史 Task 铺回 World。
 * 档案/收敛印记，不使用 Task 运行状态环。
 */
export interface ArchiveNode extends BaseNode {
  type: 'archive';

  /** 归档条目数量（字段存在时显示；不显示百分比或推测值） */
  record_count?: number;

  /** 摘要 */
  summary?: string;
}

/**
 * Configuration 节点
 *
 * 外层只显示配置舱入口。配置印记，不使用 Task 的 Core Event Log
 * 或 Agent Audit 作为主视觉，也不把配置显示成可执行单位。
 */
export interface ConfigurationNode extends BaseNode {
  type: 'configuration';

  /** 配置摘要 */
  summary?: string;

  /** 诊断印记（字段存在时） */
  diagnostics_ok?: boolean;
}

/**
 * 资料类别
 *
 * 决定 ChildScene 内部节点使用哪种印记。资料节点不能成为外层节点。
 */
export type ResourceKind =
  | 'executor-config' // Executor Configuration
  | 'executor-provider' // Executor Configuration 的供应商（一级分组，展开才见具体配置）
  | 'extension' // Extension
  | 'capability' // Capability manifest
  | 'agent' // 智能体（一等对象 = 模型 + prompt + 包集 + 收紧后的权限）
  | 'schedule-entry' // Schedule Entry（外围绑定记录，引用 Task Definition）
  | 'task-definition' // Task Definition（自动化外围定义目录）
  | 'occurrence'; // Schedule 创建的一次实例化记录

/**
 * 引用的解析视图（ADR-024）
 *
 * 三态，不是两态：`offline` 系统知道它曾经是什么（说得出原因），`unknown` 系统
 * 不知道它是什么（只能承认不知道）。**两者都要给最小占位**（引用本身 + 标记 +
 * 原因），都不许替换成一个看起来正常的对象。
 *
 * 它是**投影的产物**：从快照里的同一批事实（已注册清单 + 配置状态的 objects）
 * 算出来，与后端 `Gateway.resolve_reference` 同一套判据。要单个对象的权威答案
 * 时走 `resolveObject()`——那一条是按对象重读的口。
 */
export interface ReferenceView {
  /** 调用方手里那个引用原文（`agent:ops` 与 `agent.ops` 都合法，都是同一个对象） */
  ref: string;
  state: ReferenceState;
  /** 换算出来的配置状态键；unknown 时是空串 */
  object_ref: string;
  kind: string;
  /** offline / unknown 时系统能说的原因；可解析时为空 */
  reason: string;
}

/**
 * 资料节点
 *
 * 只在父节点的 ChildScene 中出现。名称、摘要、启用状态都直接来自
 * 真实字段；字段缺失时不显示，不补造。
 */
export interface ResourceNode {
  type: 'resource';

  /** 节点 ID */
  id: string;

  /** 资料类别 */
  resource_kind: ResourceKind;

  /** 显示名称 */
  label: string;

  x: number;
  y: number;

  /** 摘要（字段存在时） */
  summary?: string;

  /**
   * 展示用的一级类别
   *
   * 与 `resource_kind` 分开：`resource_kind` 是**结构**分类（决定渐变配色和
   * 能不能展开），这个是**这东西在后端是什么**——同一个 `extension` 结构下
   * 可能是执行者实现、供应商目录、能力包或工具包，后端自己在 metadata.type
   * 里报了，前端照抄不自己判断。
   */
  category?: string;

  /**
   * 配置状态里这一行的事实：**意图（activation）+ 观测（observed）+ 诊断**
   *
   * 原样带着快照 `objects` 里的那一行，不在前端重拼一个形状。三个要点：
   *
   * - 没有这一行就是**没有**这一行——不补一个 `activation: 'enabled'` 冒充
   *   「用户要它开着」，「后端没报」与「用户开着」是两件事；
   * - 意图与观测**永远分成两句**：合成一句就没法说「你要它开着，但它起不来」；
   * - `observed` 为空串是**没有可观测的东西**（执行者/智能体/日程），不是 unknown。
   */
  config?: GatewayObject;

  /**
   * 引用解析的状态（三态）
   *
   * 用于**占位节点**：引用指向的东西不在了，仍然把它画出来（引用 + 已下线/未知
   * 标记 + 原因），而不是让它从画布上消失——消失之后「它被停用了」和「它从来
   * 不存在」在界面上长得一模一样。
   */
  reference?: ReferenceView;

  /**
   * 能力所属的包（能力节点专用）
   *
   * 能力自己不注册生命周期，它的权限写在**声明它的那个包**的 manifest 里，
   * 所以「哪个包」必须看得见——包不在了，权限编辑就没有目标。
   */
  owner?: ReferenceView;

  /** 智能体独有的事实（`resource_kind === 'agent'` 时才有） */
  agent?: AgentFacts;

  /**
   * **这份声明在磁盘上哪个文件里**（相对扩展根）
   *
   * 配置舱是按文件组织的，所以"我改的是哪个文件"要说得出来——它是后端读出来的，
   * 不是按名字拼的（文件名和声明里的名字可以不同）。
   */
  path?: string;

  /**
   * 供应商的模型目录（`resource_kind === 'executor-provider'` 时才有）
   *
   * **它不铺到画布上。** 一家聚合商两百多个模型，按节点铺开就是一片看不清的点，
   * 而「这家有哪些模型」正是打开这一格想知道的事——所以它由一个小窗渲染
   * （可滚动），双击供应商节点打开。
   */
  catalog?: {
    name: string;
    enabled: boolean;
    models: { name: string; owned_by?: string }[];
  };

  /**
   * 外围派发状态
   * 只能表示派发，不表示执行成功
   */
  dispatch_status?: 'dispatched' | 'not-dispatched' | 'failed' | 'unknown';

  /** 派发失败的原因（后端给的原文）；只在 dispatch_status 为 failed 时出现 */
  dispatch_error?: string;

  /**
   * **只给左上角那块卡看的一句说明，卡片上不印**
   *
   * 包的那句说明、执行者的"它为什么跑不了"都走这里。它们是**描述**不是诊断——
   * 以前它们被塞进配置状态的 `diagnostic` 里，于是界面上每一格都挂着一句
   * 长得像故障的描述（`诊断：0 8 * * *`）。
   */
  panel_note?: string;

  /**
   * 这一格**只印名字和类型**，别的一律不说
   *
   * 给"清单里的一条"用（包底下那些条目）。它们的状态——意图 / 观测 / 残留 /
   * 诊断——全部搬到了**左上角那块卡**：条目一多，每张卡都背着一小段状态文字，
   * 整块画布就变成一片读不完的字。而"这一格现在什么样"这个问题，只有在
   * 正在看某一格的时候才有对象。
   *
   * **`config` 照旧带着**：开关那两条命令要靠它，只是不画出来。
   */
  compact?: boolean;

  /**
   * 这个节点里还有多少东西：供应商名下的执行者配置数、扩展声明的能力数
   *
   * 是真实计数，不是估计：收起时也要能看出这一格背后有多少东西。
   * 没有就是空的（0 或缺失），不画「0 项」也不给展开入口。
   */
  child_count?: number;

  /**
   * 当前是否展开
   *
   * 纯视图状态，不进后端、不入库：它是「这一屏想看什么」，
   * 不是关于这个对象本身的任何事实。
   */
  expanded?: boolean;
}

/**
 * 智能体在配置舱里露出来的那几样
 *
 * 契约里智能体 =（一个模型 + 一段 system_prompt + 一组扩展包 + 收紧后的权限）。
 * 节点上只放**看得见的那几样**：模型是一个**引用**（要单独解析，它可能已下线）、
 * 包集与工具数用来说明「它手上有什么」。system_prompt 正文属于编辑页，不铺到节点上。
 */
export interface AgentFacts {
  /** 它选的模型。模型不在任务层出现，它下沉成智能体的一个属性 */
  model: ReferenceView;
  /** 由包集并集而来的工具，逐工具三列（声明 / 生效 / 是不是它收紧的） */
  tools: GatewayToolSpec[];
  /** 选中的扩展包（整包选，不逐个工具） */
  packages: string[];
  /** 定义修订号：改动过几次 */
  revision: number;
}

/**
 * 节点联合类型
 */
export type Node = TaskNode | ScheduleNode | ArchiveNode | ConfigurationNode | ResourceNode;

/**
 * 关系类型
 *
 * 只有真实 ID 映射支持的关系才允许绘制，且两端都必须存在于同一场景。
 * 禁止：Executor Configuration → Capability、Controller → Worker、Task → Task
 */
export type RelationType =
  // 设计里合法关系的动词原样保留，便于逐条对照
  // （world-model.md 第 4 节 / focus-leap.md 3.2）
  | 'uses' // Task ──uses──> Executor Configuration
  | 'awaits' // Task ──awaits──> pending Capability（pending_tool_id 存在时）
  | 'has' // Schedule ──has──> Schedule Entry
  | 'references' // Schedule Entry ──references──> Task Definition
  | 'creates' // Schedule ──creates──> occurrence
  | 'materializes' // occurrence ──materializes──> Core Task
  | 'declares' // Extension ──declares──> Capability
  | 'provides' // Extension/供应商 ──provides──> Executor Configuration（它名下的配置）
  | 'observed_by'; // Task ──observed-by──> Controller Observation（徽标，不是节点）

/**
 * 节点关系
 */
export interface Relation {
  /** 关系 ID */
  id: string;

  /** 源节点 ID */
  source: string;

  /** 目标节点 ID */
  target: string;

  /** 关系类型 */
  type: RelationType;

  /** 关系标签（可选） */
  label?: string;
}
