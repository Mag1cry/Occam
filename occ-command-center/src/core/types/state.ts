/**
 * 状态类型定义
 *
 * OCC 前端的状态系统，包括 Task 生命周期状态、注意力级别、状态环形状
 */

/**
 * Task 状态（生命周期）
 *
 * created 表示 Task 已创建但尚未启动 Worker（操作矩阵中的第一档事实）。
 */
export type TaskStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'failed'
  | 'succeeded'
  | 'cancelled';

/**
 * 终态
 *
 * 与后端 `core.models.TASK_STATUSES` 的终态子集一致：进入这里之后不再改变。
 *
 * 注意「终态」不等于「已收敛」：failed 未被用户确认时仍然亮灯，
 * 收敛判定见 `lib/attention.ts` 的 `isSettled`。
 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

/**
 * 审批状态（paused 时）
 */
export type ApprovalState = 'pending' | 'approved' | 'denied';

/**
 * 注意力级别
 * 用于汇总和展示需要人工关注的程度
 */
export type AttentionLevel =
  | 'needs-decision'  // 响铃：有待拍板事项
  | 'attention'       // 亮灯：需要关注（失败未确认等）
  | 'active'          // 记账：正常运行中
  | 'settled';        // 已完结：成功或已确认失败

/**
 * Schedule 聚合注意力
 *
 * Schedule 不拥有自己的 Core 状态环：它的环是子 Task 注意力的聚合投影。
 * 聚合数据不完整时必须返回 unknown，不能用当前视口内恰好加载的几个 Task
 * 冒充完整 Schedule 状态。
 */
export type ScheduleAttention =
  | 'needs-decision'
  | 'attention'
  | 'active'
  | 'settled'
  | 'empty'
  | 'unknown';

/**
 * 聚合完整性
 * partial 表示子 Task 未全部纳入，必须按 unknown 处理
 */
export type AggregationCompleteness = 'complete' | 'partial';

/**
 * 状态环形状
 * 用于视觉呈现 Task 生命周期
 */
export type StateRingShape =
  | 'closed'    // 闭合环：running、succeeded
  | 'gap'       // 缺口环：paused
  | 'broken'    // 断裂环：failed
  | 'collapsed'; // 收束环：cancelled

/**
 * 状态环派生输入
 * 用于计算状态环的形状和颜色
 */
export interface StateRingInput {
  /** Task 状态 */
  status: TaskStatus;

  /** 待决策状态 */
  pending_decision?: boolean;

  /** 审批状态 */
  approval_state?: ApprovalState;

  /** 失败确认 */
  acknowledged_failure?: boolean;

  /** 成功确认 */
  acknowledged_success?: boolean;
}

/**
 * 状态环输出
 * 包含形状、颜色、标签
 */
export interface StateRingOutput {
  /** 形状 */
  shape: StateRingShape;

  /** 颜色 */
  color: string;

  /** 状态标签 */
  label: string;

  /** 注意力级别 */
  attentionLevel: AttentionLevel;
}

/**
 * 注意力汇总
 * 用于 HUD 显示
 */
export interface AttentionSummary {
  /** 响铃数（需要拍板） */
  needsDecisionCount: number;

  /** 亮灯数（需要关注） */
  attentionCount: number;

  /** 活跃数（正常运行） */
  activeCount: number;

  /** 完结数（已完成） */
  settledCount: number;
}
