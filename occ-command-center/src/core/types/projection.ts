/**
 * 投影类型定义
 *
 * 投影器负责将业务数据转换为前端节点和关系
 */

import type { Node, Relation } from './node';
import type { SceneEntry } from './scene';
import type { AttentionSummary } from './state';

/**
 * occurrence：Schedule 创建的一次实例化记录
 *
 * 它是**投影的产物**，不是后端给的字段——`projectLiveScheduleScene` 从派发记录
 * 展开出它。所以它定义在这里，而不是定义在 mock 里让生产代码反过来 import：
 * 夹具要模拟的是后端输出，它应该生产这个类型，而不是拥有它。
 */
export interface ScheduleOccurrence {
  occurrence_id: string;
  schedule_id: string;
  /** 该 occurrence 物化出的 Core Task；派发失败时可能一个都没有 */
  task_id: string;
  /** 这次派发的派发键 */
  entry_id: string;
  /** 真实触发时间；缺失时必须显示未知，不能推测 */
  triggered_at: string | null;
  /** 派发记录只表示派发，不表示执行成功 */
  dispatch_status: 'dispatched' | 'not-dispatched' | 'failed' | 'unknown';
  /** 派发失败的原因（后端给的原文）；只在该状态有值 */
  dispatch_error?: string;
}

/**
 * 投影器输出
 * 投影器返回的节点、关系和场景入口
 */
export interface ProjectionOutput {
  /** 节点列表 */
  nodes: Node[];

  /** 关系列表 */
  relations: Relation[];

  /** 场景入口（可进入的节点） */
  sceneEntries: SceneEntry[];

  /** 注意力汇总（可选） */
  attentionSummary?: AttentionSummary;
}

/**
 * 操作牌模型
 * 根据对象状态生成的操作界面
 */
export interface CommandSurfaceModel {
  /** 目标对象 ID */
  targetId: string;

  /** 目标对象类型（含子场景资料节点） */
  targetType: 'task' | 'schedule' | 'archive' | 'configuration' | 'resource';

  /** 可用操作 */
  commands: Command[];
}

/**
 * 命令的后果申报
 *
 * 由**生成命令的地方**填（`lib/commandMatrix.ts`），因为它们各自知道这条命令会
 * 改什么。预览组件不许按命令名兜底：兜底的默认值是「无字段变更 / 只读，不改变
 * 状态」，而它会被套在真正不可逆的命令上——那是一个说假话的闸门。
 */
export interface CommandEffects {
  /** 会影响哪些字段（后端字段名与方向，不是 UI 文案） */
  impact: string;

  /** 预计的状态变化 */
  transition: string;

  /** 有没有明确的撤回契约（能撤回的那条命令是什么） */
  reversible: boolean;
}

/**
 * 风险等级与后果申报
 *
 * 做成**判别联合**而不是「两个可选字段」：`highRisk: true` 与 `preview` 必须一起
 * 出现，于是「高风险但没有预览文案」在类型上不可表达。
 *
 * 低风险命令同样要申报（只读命令也要说清「不改变任何状态」）——预览这一栏对
 * 用户永远可见，只是低风险的不拦一道。
 */
type CommandRisk =
  | { highRisk: true; preview: CommandEffects }
  | { highRisk: false; preview: CommandEffects };

/**
 * 单个操作
 */
export type Command = {
  /** 操作 ID */
  id: string;

  /** 操作标签 */
  label: string;

  /**
   * 操作类型
   *
   * enter 表示进入局部场景，由投影器提供的 SceneEntry 驱动；
   * 其余类型对应**已存在**的真实 Web 命令。没有契约的操作不上牌面。
   */
  type:
    | 'view'
    | 'approve'
    | 'deny'
    | 'cancel'
    | 'acknowledge'
    | 'resume'
    | 'run'
    // 档案馆那两步：**先归档，再删除**（`core/task.py` 的两道门）
    | 'archive'
    | 'forget'
    | 'toggle'
    | 'enter'
    // Schedule 的立即触发（schedule.trigger）
    | 'trigger'
    // 删一条日程（schedule.delete）：**连它派出去的子 Task 一起**，不可撤销
    | 'delete-schedule'
    // 配置对象的开关：都是 `config.set_enabled`，只是方向不同（ADR-025）
    | 'config-enable'
    | 'config-disable'
    // 编辑入口（打开覆盖层，本身不提交任何东西）
    | 'edit-agent'
    | 'edit-tool'
    | 'edit-schedule'
    | 'delete-agent';

  /** 操作描述 */
  description?: string;

  /** 后端接口未就绪：显示但不可执行，不伪造能力 */
  unavailable?: boolean;
} & CommandRisk;
