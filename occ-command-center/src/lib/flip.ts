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
 */
export const ANCHOR_POSITION = { x: 20, y: 20 };
export const ANCHOR_SIZE = { width: 208, height: 56 };
export const ANCHOR_RECT: Rect = {
  x: ANCHOR_POSITION.x,
  y: ANCHOR_POSITION.y,
  ...ANCHOR_SIZE,
};

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

