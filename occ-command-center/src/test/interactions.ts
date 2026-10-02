/**
 * 测试用手势辅助
 *
 * 画布的手势判定基于 pointerdown / pointermove / pointerup，
 * 而不是单独的 click 事件——真实浏览器里点击也总是先有这一对事件。
 * 因此测试必须模拟完整的指针序列，否则测不到真实路径。
 */

import { fireEvent } from '@testing-library/react';

/** 取画布中的节点元素 */
export function nodeElement(nodeId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${nodeId}"]`
  );
  if (!element) throw new Error(`node ${nodeId} not found`);
  return element;
}

/** 取画布面板元素 */
export function paneElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.react-flow__pane');
  if (!element) throw new Error('pane not found');
  return element;
}

function pointerDown(target: HTMLElement, x: number, y: number) {
  fireEvent.pointerDown(target, {
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    pointerType: 'mouse',
  });
}

function pointerMove(x: number, y: number) {
  fireEvent.pointerMove(window, {
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    pointerType: 'mouse',
  });
}

function pointerUp(x: number, y: number) {
  fireEvent.pointerUp(window, {
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 0,
    pointerType: 'mouse',
  });
}

/**
 * 轻点节点：按下后原地抬起 → 选中
 */
export function tapNode(nodeId: string, x = 400, y = 300) {
  pointerDown(nodeElement(nodeId), x, y);
  pointerUp(x, y);
}

/**
 * 轻点空白：按下后原地抬起 → 取消选中
 */
export function tapPane(x = 5, y = 5) {
  pointerDown(paneElement(), x, y);
  pointerUp(x, y);
}

/**
 * 真实双击：浏览器里双击必然先产生两次完整的 click 序列，然后是 dblclick。
 *
 * 只派发 dblclick（fireEvent.doubleClick）会跳过那两次轻点，
 * 测不到「开关切换两次 = 恒等」这条性质。
 */
export function doubleTapNode(nodeId: string, x = 400, y = 300) {
  tapNode(nodeId, x, y);
  tapNode(nodeId, x, y);
  fireEvent.doubleClick(nodeElement(nodeId));
}

/**
 * 只有两次轻点，没有 dblclick
 *
 * 真实浏览器里 dblclick 不保证派发：它要求两次点击落在同一个元素上，
 * 而第一次点击会让节点从 mid 密度变成 near 密度（DOM 变化），
 * 第二次点击命中的往往已经是另一个元素。进入场景必须靠手势自己判定，
 * 这条用例就是那个保护。
 */
export function doubleTapNodeOnly(nodeId: string, x = 400, y = 300) {
  tapNode(nodeId, x, y);
  tapNode(nodeId, x, y);
}

/**
 * 拖动节点：按下后位移超过阈值再抬起 → 只移动布局，不改变选中态
 */
export function dragNode(nodeId: string, from = { x: 400, y: 300 }, delta = { x: 60, y: 40 }) {
  pointerDown(nodeElement(nodeId), from.x, from.y);
  pointerMove(from.x + delta.x, from.y + delta.y);
  pointerUp(from.x + delta.x, from.y + delta.y);
}

/** 判断画布是否把该节点渲染为选中 */
export function isNodeSelected(nodeId: string): boolean {
  return nodeElement(nodeId).classList.contains('selected');
}
