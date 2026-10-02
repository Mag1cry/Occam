/**
 * 场景类型定义
 *
 * OCC 前端使用场景栈（SceneStack）管理视图层级：
 * - World Scene：外层世界，显示四类节点
 * - Child Scene：局部世界（Task/Schedule/Archive/Configuration）
 */

/**
 * 场景标识符
 */
export type SceneId = 'world' | 'task' | 'schedule' | 'archive' | 'configuration';

/**
 * 场景快照
 * 用于保存场景状态，实现进入和返回时的状态恢复
 */
export interface SceneFrame {
  /** 场景 ID */
  sceneId: SceneId;

  /** 焦点对象 ID（进入时的源节点） */
  focusId: string;

  /**
   * 焦点对象的显示名
   *
   * HUD 这类浮层只能拿到帧，不该为了显示一个名字去反查每种业务投影。
   * 进入时源节点就在手上，顺手记下来；没有时退回 focusId。
   */
  focusLabel?: string;

  /**
   * 焦点对象的状态文字
   *
   * 和 focusLabel 同一个道理：锚点要显示「我从哪个对象、什么状态进来」，
   * 但浮层拿不到当前场景的投影。没有时锚点只显示名字，不猜状态。
   */
  focusStateText?: string;

  /** 视口状态 */
  viewport: {
    /** 缩放级别 */
    zoom: number;
    /** 平移偏移 */
    pan: { x: number; y: number };
  };

  /** 选中状态 */
  selection: {
    /** 选中的节点 ID */
    selectedNodeId: string | null;
  };

  /**
   * 源对象快照：返回时飞行代理要飞回哪里
   *
   * 返回动画开始时源画布还没重新挂载，无法现测；进入前测到的屏幕矩形
   * 就是返回目标（源场景视口被冻结在同一帧里，回来时是同一个位置）。
   * 测量失败时为 null，此时降级为淡入淡出。
   */
  source?: {
    rect: { x: number; y: number; width: number; height: number } | null;
    /** 代理上显示的文字；不是业务数据，只是源节点的视觉快照 */
    label: string;
    color: string;
  };

  /** 过滤器状态（可选） */
  filter?: {
    /** 筛选条件 */
    [key: string]: any;
  };
}

/**
 * 场景栈状态
 */
export interface SceneStack {
  /** 场景栈（栈底是 World Scene） */
  stack: SceneFrame[];

  /** 当前活动场景 */
  currentScene: SceneId;

  /** 是否在转场中 */
  isTransitioning: boolean;
}

/**
 * 转场状态
 */
export interface TransitionState {
  /** 是否在转场中 */
  active: boolean;

  /** 转场方向 */
  direction: 'enter' | 'exit';

  /** 源场景 */
  fromScene: SceneId;

  /** 目标场景 */
  toScene: SceneId;

  /** 飞行代理状态 */
  flyingProxy?: {
    /** 源节点位置 */
    source: { x: number; y: number; width: number; height: number };
    /** 目标锚点位置 */
    target: { x: number; y: number; width: number; height: number };
    /** 飞行进度 (0-1) */
    progress: number;
  };
}

/**
 * 场景入口
 * 用于判断节点是否可进入子场景
 */
export interface SceneEntry {
  /** 节点 ID */
  nodeId: string;

  /** 是否可进入 */
  canEnter: boolean;

  /** 目标场景 */
  targetScene?: SceneId;

  /** 入口标签（显示在节点上的提示） */
  label?: string;
}
