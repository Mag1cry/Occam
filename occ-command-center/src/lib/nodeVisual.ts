/**
 * 节点视觉派生
 *
 * 只派生视觉表现（强调色、状态文字），不改变业务状态或后端事实。
 * 四类外层节点的状态输入不混用：各自读取自己的投影语义。
 * 资料节点不套用任何 Task 生命周期语义。
 */

import type {
  Node,
  TaskNode,
  ArchiveNode,
  ConfigurationNode,
  ReferenceView,
  ResourceNode,
  ResourceKind,
} from '../core/types/node';
import type { GatewayObject } from '../api/gateway';
import type { ScheduleAttention } from '../core/types/state';
import { deriveStateRing } from './stateRing';
import { getScheduleAggregateLabel } from './attention';

/** Palette（与 index.css 的 @theme 变量保持一致） */
export const PALETTE = {
  blue: '#2dd4a7',
  green: '#14b98d',
  indigo: '#2dd4a7',
  amber: '#ffb020',
  red: '#ff5470',
  gray: '#64748b',
} as const;

/**
 * Task 的状态环
 *
 * 唯一一处把 TaskNode 折成状态环输入；强调色和状态文字共用它，
 * 两处各写一遍就会出现「环是红的、字是运行中」。
 */
function stateRingOf(task: TaskNode) {
  return deriveStateRing({
    status: task.status,
    pending_decision: Boolean(task.pending_decision),
    approval_state: task.approval_state,
    acknowledged_failure: task.acknowledged_failure,
  });
}

/** Task 状态环强调色 */
export function taskAccent(task: TaskNode): string {
  return stateRingOf(task).color;
}

/**
 * Schedule 聚合环强调色
 *
 * Schedule 不拥有自己的 Core 状态环，它的环是子 Task 注意力的聚合投影。
 */
export function scheduleAccent(state: ScheduleAttention): string {
  switch (state) {
    case 'needs-decision':
      return PALETTE.amber;
    case 'attention':
      return PALETTE.red;
    case 'active':
      return PALETTE.indigo;
    case 'settled':
    case 'empty':
      return PALETTE.gray;
    case 'unknown':
    default:
      return PALETTE.gray;
  }
}

/** Schedule 聚合状态文案（复用注意力的唯一文案来源） */
export const scheduleStateText = getScheduleAggregateLabel;

/** Archive 入口印记强调色（不使用 Task 运行状态环） */
export function archiveAccent(_archive: ArchiveNode): string {
  return PALETTE.gray;
}

/** Configuration 入口印记强调色（不使用 Task 运行状态环） */
export function configurationAccent(_config: ConfigurationNode): string {
  return PALETTE.indigo;
}

/** 资料类别强调色 */
export function resourceAccent(kind: ResourceKind): string {
  switch (kind) {
    case 'executor-config':
      return PALETTE.indigo;
    case 'executor-provider':
      // 供应商是配置目录的一级，和它名下的配置同一族色
      return PALETTE.indigo;
    case 'extension':
      return PALETTE.blue;
    case 'capability':
      return PALETTE.green;
    case 'agent':
      // 智能体是对象坐标里的中间那级，从资源里独立出来的一种色
      return PALETTE.amber;
    case 'task-definition':
      return '#64748b';
    case 'schedule-entry':
    case 'occurrence':
      return PALETTE.gray;
  }
}

/**
 * 任意节点的强调色
 */
export function nodeAccent(node: Node): string {
  switch (node.type) {
    case 'task':
      return taskAccent(node);
    case 'schedule':
      return scheduleAccent(node.aggregated_state);
    case 'archive':
      return archiveAccent(node);
    case 'configuration':
      return configurationAccent(node);
    case 'resource':
      return resourceAccent(node.resource_kind);
  }
}

/** 资料节点的状态文字 */
export function resourceStateText(resource: ResourceNode): string {
  // 引用解析不到时只说引用本身的事，且**已下线**与**未知**是两句话：
  // 合成一句「引用缺失」，用户就分不清「它被停了」和「这个名字根本不存在」
  if (resource.reference?.state === 'offline') return '已下线';
  if (resource.reference?.state === 'unknown') return '引用未知';
  if (resource.config?.activation === 'disabled') return '已停用';
  if (resource.dispatch_status === 'unknown') return '派发状态未知';
  return '可用';
}

/**
 * 意图文案（activation）
 *
 * 这是**用户最后的选择**，不是它的运行结果。所以它单独成句，永远不和观测合成
 * 一句——合成之后「你要它开着但它起不来」和「你把它关了」长得一模一样，
 * 而这两种情况用户要做的事完全不同。
 *
 * 认不出的取值返回 null：契约漂移时说不知道，不猜成「已启用」或「已停用」。
 */
export function activationText(activation: string): string | null {
  if (activation === 'enabled') return '已启用';
  if (activation === 'disabled') return '已停用';
  return null;
}

/**
 * 观测文案（observed）
 *
 * **空串不是 unknown**：没有生命周期的对象（执行者 / 智能体 / 日程）根本没有
 * 可观测的东西，这时返回 null——画一格「未知」等于捏造一个不存在的问题。
 * 后端给的状态认不出时**原样显示**：不翻译就是不丢信息。
 */
export function observedText(observed: string): string | null {
  if (!observed) return null;
  const labels: Record<string, string> = {
    online: '运行中',
    offline: '未运行',
    stopped: '已停止',
    failed: '失败',
    registered: '已注册',
    starting: '启动中',
    stopping: '停止中',
  };
  return labels[observed] ?? observed;
}

/**
 * 引用三态的文案
 *
 * `offline` 与 `unknown` **必须长得不一样**：前者是「它被停了 / 它起不来」，
 * 系统说得出原因；后者是「系统里没有这个引用」。合成一句「引用缺失」，
 * 用户就分不清该去把它开回来，还是该去改那个名字。
 */
export function referenceStateText(state: ReferenceView['state']): string {
  switch (state) {
    case 'resolvable':
      return '可用';
    case 'offline':
      return '已下线';
    case 'unknown':
      return '未知';
  }
}

/** 节点上的一格：一个标签一句值 */
export interface ConfigColumn {
  label: string;
  value: string;
  tone: 'default' | 'warning' | 'danger';
}

/**
 * 节点卡片上的那几栏：**短句**
 *
 * 意图一句、观测一句，外加「关掉了但代码还在」那一句。三句各有各的来源
 * （用户的选择 / 运行期观测 / 卸载得不干净），所以永远不合并——这正是这一版
 * 要能说出来的那几句话。
 *
 * **诊断不在这里**（见 `diagnosticColumn`）：它可能是一整段报错，
 * 印在每一张卡片上会把整块画布变成一片读不完的字。
 *
 * 没有 facts 就返回空数组：**没有数据时不显示 0**，也不画一个空的「意图」格。
 */
export function configColumns(facts: GatewayObject | undefined): ConfigColumn[] {
  if (!facts) return [];

  const columns: ConfigColumn[] = [];
  const activation = activationText(facts.activation);
  if (activation) {
    columns.push({
      label: '意图',
      value: activation,
      // 停用是「已生效的配置状态」，不是故障：它是黄色提醒，不是红色错误
      tone: facts.activation === 'disabled' ? 'warning' : 'default',
    });
  }

  const observed = observedText(facts.observed);
  if (observed) {
    columns.push({
      label: '观测',
      value: observed,
      tone: facts.observed === 'failed' ? 'danger' : 'default',
    });
  }

  /*
    关掉了，但代码还在后端进程里
    ------------------------------
    包内实现的工具是**在宿主进程里跑的 Python**（`extensions/README.md` 的代价那一段）：
    禁用会把它从列表里摘掉，但已经 import 进来的模块要重启才真的卸掉。
    这一句得说出来，否则用户会以为"关掉"等于"它没了"。
  */
  if (facts.activation === 'disabled' && facts.restart_required) {
    columns.push({
      label: '残留',
      value: '代码还在后端进程里，重启才卸掉',
      tone: 'warning',
    });
  }

  return columns;
}

/**
 * 诊断：**它为什么没起来**（完整的一句）
 *
 * 它回答的是"为什么"，与"用户要不要它开着"无关，所以它和意图/观测分开说。
 *
 * **它不进节点卡片。** 一句诊断可能是一整段报错，而卡片上那一格只有十几个字宽——
 * 印上去的结果是每张卡都矮一截、字挤成几行，整块画布变成一片读不完的字。
 * 它归**左上角那块「场景事实」**：看谁的时候，谁的诊断就在那儿，**不截断**。
 *
 * 卡片上不是就不说了：坏了的东西观测那一栏是**红色的「失败」**，
 * 一眼看得出哪一格有问题，点一下就能读到全文。
 */
export function diagnosticColumn(facts: GatewayObject | undefined): ConfigColumn | null {
  if (!facts?.diagnostic) return null;
  return {
    label: '诊断',
    value: `${facts.diagnostic.stage}: ${facts.diagnostic.message}`,
    tone: 'danger',
  };
}

/**
 * 开关失败之后必须说出来的那句保留
 *
 * `status === 'failed'` 是**当前生效失败**，不是命令失败：意图已经落库，用户要的
 * 那个状态记下了，只是没做成。两件事必须分开说，否则用户会以为要点第二次。
 *
 * `restart_required` 说的是另一件事：这段代码已经进了后端进程，**重启才卸得掉**。
 * 两个方向的话不一样：要关而没关掉的是「已禁用但代码还在」，要开而没开起来的是
 * 「没起来但代码已经进来了」——后者不能对用户说「已禁用」，那与它上面那一栏
 * 「已启用」正好矛盾。
 */
export function activationFailureText(outcome: {
  enabled: boolean;
  status: string;
  diagnostic?: string | null;
  restart_required?: boolean;
}): string | null {
  if (outcome.status !== 'failed') return null;

  const why = outcome.diagnostic ? `：${outcome.diagnostic}` : '';
  if (!outcome.restart_required) return `没能生效${why}`;
  return outcome.enabled
    ? `没有起来${why}。它的代码已经进过后端进程；重启后端才会回到干净状态`
    : `已禁用，但已加载的代码要重启后端才真的卸掉${why}`;
}

/**
 * 任意节点的状态文字
 *
 * 与 `nodeAccent` 同一份派生，供焦点锚点在进入时顺手记下。
 * 入口节点没有运行状态，给的是它是什么，而不是编一个状态。
 */
export function nodeStateText(node: Node): string {
  switch (node.type) {
    case 'task':
      return stateRingOf(node).label;
    case 'schedule':
      return scheduleStateText(node.aggregated_state);
    case 'archive':
      return '历史与结果';
    case 'configuration':
      return '配置与能力';
    case 'resource':
      return resourceStateText(node);
  }
}

