/**
 * FLIP 动画辅助函数
 *
 * FLIP = First, Last, Invert, Play
 *
 * 全局画布和局部场景是不同 React 渲染树，不能依赖普通 CSS transition
 * 让两个组件“看起来自己飞过去”。这里提供测量和降级所需的最小工具集。
 */

/**
 * 矩形位置信息（屏幕坐标）
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 左上角焦点锚点的目标矩形
 *
 * FocusAnchor 组件必须使用同一组尺寸常量，保证飞行终点与锚点严丝合缝。
 *
 * ## 两档，判据在 `anchorRectFor`
 *
 * 宽屏是「箭头 + 名字 + 状态」那块牌子；窄屏只留箭头和状态点——名字 HUD 上本来
 * 就有（「编排台 · weather.daily」），手机上没必要说两遍，而那一列要腾给 HUD。
 */
export const ANCHOR_POSITION = { x: 20, y: 20 };
export const ANCHOR_SIZE = { width: 208, height: 56 };
/** 窄屏：只剩箭头 + 状态点 */
export const ANCHOR_COMPACT_SIZE = { width: 48, height: 36 };

/**
 * 窄到多少收成图标
 *
 * **不是 Tailwind 的 `md`(768)**：真机横屏是 800 宽，用 768 会漏掉它。
 *
 * 选 1024 还白捡一个好处：jsdom 的默认 `window.innerWidth` 正好是 1024，
 * 落在宽档——所以钉着 `width: 208px` 的那几条断言不用改。
 */
export const COMPACT_ANCHOR_MAX_WIDTH = 1024;

export function isCompactAnchor(viewportWidth: number): boolean {
  return viewportWidth < COMPACT_ANCHOR_MAX_WIDTH;
}

export function anchorSizeFor(compact: boolean): { width: number; height: number } {
  return compact ? ANCHOR_COMPACT_SIZE : ANCHOR_SIZE;
}

/**
 * 当前该用的锚点矩形
 *
 * **画面和飞行终点必须走同一个函数。** 只让 CSS 变窄而这里不变的话，每次进/出场景
 * 都会飞到一个比锚点宽 160px 的框里——落点对不上，而且只在手机上看得出来。
 */
export function anchorRectFor(compact: boolean): Rect {
  return { x: ANCHOR_POSITION.x, y: ANCHOR_POSITION.y, ...anchorSizeFor(compact) };
}

/** 宽屏那一档。给不需要管视口的地方当默认值用。 */
export const ANCHOR_RECT: Rect = anchorRectFor(false);

/**
 * 测量元素位置
 */
export function measureElement(element: Element | null): Rect | null {
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;

  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * 按节点 ID 测量画布中的节点
 *
 * 使用 React Flow 包裹层上的 data-id，不要求业务节点组件暴露额外接口。
 */
export function measureNodeById(nodeId: string): Rect | null {
  if (typeof document === 'undefined') return null;
  const escaped = nodeId.replace(/"/g, '\\"');
  const element = document.querySelector(`.react-flow__node[data-id="${escaped}"]`);
  return measureElement(element);
}

/**
 * 由视口和节点坐标推算节点在屏幕上的矩形
 *
 * 返回场景时源画布尚未重新挂载，无法直接测量，只能由进入前保存的
 * viewport 快照推算。推算失败时应降级为淡入淡出。
 */
export function computeNodeScreenRect(params: {
  viewport: { zoom: number; pan: { x: number; y: number } };
  nodePosition: { x: number; y: number };
  nodeSize?: { width: number; height: number };
  canvasRect?: Rect;
}): Rect | null {
  const { viewport, nodePosition, nodeSize = { width: 200, height: 96 } } = params;
  const canvasRect =
    params.canvasRect ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };

  const zoom = viewport.zoom || 1;
  const width = nodeSize.width * zoom;
  const height = nodeSize.height * zoom;

  return {
    x: canvasRect.x + viewport.pan.x + nodePosition.x * zoom,
    y: canvasRect.y + viewport.pan.y + nodePosition.y * zoom,
    width,
    height,
  };
}

