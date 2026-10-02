/**
 * 单击选中测试
 *
 * 覆盖三个曾经出问题或容易回归的点：
 * 1. 轻点节点要能选中（不依赖 React Flow 的 1px click 阈值）；
 * 2. 选中态必须在节点数组重算后存活——平移、缩放或布局变化都会整体
 *    替换 React Flow 的节点对象，选中态不能挂在那些对象上；
 * 3. 拖动节点只改布局，不改变选中态。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import App from './App';
import { useSceneStore } from './store/sceneStore';
import { useSelectionStore } from './store/selectionStore';
import { useLayoutStore } from './store/layoutStore';
import { useTransitionStore } from './store/transitionStore';
import {
  tapNode,
  tapPane,
  dragNode,
  doubleTapNode,
  doubleTapNodeOnly,
  isNodeSelected,
} from './test/interactions';
import { relationEdgeStyle, isRelationFocused } from './lib/relationVisual';

function resetWorld() {
  useSceneStore.setState({
    stack: [
      {
        sceneId: 'world',
        focusId: '',
        viewport: { zoom: 1, pan: { x: 0, y: 0 } },
        selection: { selectedNodeId: null },
      },
    ],
    currentScene: 'world',
    isTransitioning: false,
  });
  useSelectionStore.setState({ selectedNodeId: null });

  // 转场状态也是模块级共享的：上一个用例若停在飞行中，
  // 画布的 interactive 会变成 false，手势被正确忽略，看起来像「点不中」
  useTransitionStore.setState({
    proxy: null,
    flying: false,
    pending: null,
    pendingPop: false,
  });
}

async function renderApp() {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  await act(async () => {
    render(<App />);
  });
  errorSpy.mockRestore();
}

/**
 * 等出双击窗口
 *
 * 同一个节点上连续两次轻点，间隔在双击窗口内会被判成双击（导航手势），
 * 不会执行开关。要测「有意再点一次取消选中」，必须真的等过去。
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PAST_DOUBLE_TAP = 350;

describe('单击选中', () => {
  it('轻点节点会选中它', async () => {
    resetWorld();
    await renderApp();

    await act(async () => {
      tapNode('task-001');
    });

    expect(useSelectionStore.getState().selectedNodeId).toBe('task-001');
    expect(isNodeSelected('task-001')).toBe(true);
    // 选中后出现操作牌
    expect(screen.getByText('操作牌')).toBeTruthy();
  });

  it('轻点另一个节点会切换选中', async () => {
    resetWorld();
    await renderApp();

    await act(async () => {
      tapNode('task-001');
    });
    await act(async () => {
      tapNode('task-003', 500, 300);
    });

    expect(useSelectionStore.getState().selectedNodeId).toBe('task-003');
    expect(isNodeSelected('task-003')).toBe(true);
    expect(isNodeSelected('task-001')).toBe(false);
  });

  it('轻点空白处取消选中', async () => {
    resetWorld();
    await renderApp();

    await act(async () => {
      tapNode('task-001');
    });
    await act(async () => {
      tapPane();
    });

    expect(useSelectionStore.getState().selectedNodeId).toBeNull();
    expect(isNodeSelected('task-001')).toBe(false);
  });

  it('再次轻点已选中的节点会取消选中（两次有意轻点，不是双击）', async () => {
    resetWorld();
    await renderApp();

    await act(async () => {
      tapNode('task-001');
    });
    expect(isNodeSelected('task-001')).toBe(true);

    // 等出双击窗口：这是一次有意的再点，不是双击
    await act(async () => {
      await sleep(PAST_DOUBLE_TAP);
    });
    await act(async () => {
      tapNode('task-001');
    });

    expect(useSelectionStore.getState().selectedNodeId).toBeNull();
    expect(isNodeSelected('task-001')).toBe(false);
    // 取消选中后操作牌一并收起
    expect(screen.queryByText('操作牌')).toBeNull();
  });

  it('在多个节点之间来回切换都正确', async () => {
    resetWorld();
    await renderApp();

    await act(async () => { tapNode('task-001'); });
    await act(async () => { tapNode('task-003', 500, 300); });
    expect(useSelectionStore.getState().selectedNodeId).toBe('task-003');
    expect(isNodeSelected('task-001')).toBe(false);

    // 换回另一个节点：不是同一节点的连续轻点，不受双击窗口影响
    await act(async () => { tapNode('task-001'); });
    expect(useSelectionStore.getState().selectedNodeId).toBe('task-001');
    expect(isNodeSelected('task-003')).toBe(false);
  });

  it('双击的两次轻点不会互相抵消成空选中', async () => {
    resetWorld();
    await renderApp();

    await act(async () => {
      tapNode('task-001');
    });
    expect(useSelectionStore.getState().selectedNodeId).toBe('task-001');

    // 同一个节点上快速两次轻点 = 双击，第二次把选中恢复到双击之前
    await act(async () => {
      tapNode('task-003', 500, 300);
      tapNode('task-003', 500, 300);
    });

    expect(useSelectionStore.getState().selectedNodeId).toBe('task-001');
  });

  it('长按是选中而不是开关：长按已选中的节点不会被取消', async () => {
    resetWorld();
    await renderApp();

    await act(async () => {
      tapNode('task-001');
    });
    expect(useSelectionStore.getState().selectedNodeId).toBe('task-001');

    // 长按走的是 setSelected，语义是「打开操作牌」而不是开关
    await act(async () => {
      useSelectionStore.getState().setSelected('task-001');
    });

    expect(useSelectionStore.getState().selectedNodeId).toBe('task-001');
  });
});

describe('双击与开关的组合', () => {
  it('双击由两次轻点组成，开关切换两次等于恒等，选中态不变', async () => {
    resetWorld();
    await renderApp();

    // 先选中一个别的节点，确认双击不会把它抢走
    await act(async () => {
      tapNode('task-001');
    });
    expect(useSelectionStore.getState().selectedNodeId).toBe('task-001');

    await act(async () => {
      doubleTapNode('task-003', 500, 300);
    });

    // 双击进入场景前的选中态，应与双击前一致
    expect(useSceneStore.getState().currentScene).toBe('task');
    expect(useSceneStore.getState().stack[1].selection.selectedNodeId).toBe('task-001');
  });

  it('未选中任何节点时双击进入，快照里也没有选中', async () => {
    resetWorld();
    await renderApp();

    await act(async () => {
      doubleTapNode('task-003', 500, 300);
    });

    expect(useSceneStore.getState().currentScene).toBe('task');
    expect(useSceneStore.getState().stack[1].selection.selectedNodeId).toBeNull();
  });

  it('浏览器没派发 dblclick 时，两次轻点也要能进入', async () => {
    resetWorld();
    await renderApp();

    // 真实浏览器里第一次点击会让节点换密度、换 DOM，
    // 第二次点击常常命中的是另一个元素，dblclick 就不派发了
    await act(async () => {
      doubleTapNodeOnly('task-003', 500, 300);
    });

    expect(useSceneStore.getState().currentScene).toBe('task');
    expect(useSceneStore.getState().stack).toHaveLength(2);
  });

  it('进入只发生一次：手势判定与原生 dblclick 不会重复入栈', async () => {
    resetWorld();
    await renderApp();

    // 两次轻点（手势判定进入）之后再补一个原生 dblclick
    await act(async () => {
      doubleTapNode('task-003', 500, 300);
    });

    expect(useSceneStore.getState().stack).toHaveLength(2);
  });
});

describe('选中态的存活', () => {
  it('节点数组重算后选中态不丢失', async () => {
    resetWorld();
    await renderApp();

    await act(async () => {
      tapNode('task-001');
    });
    expect(isNodeSelected('task-001')).toBe(true);

    // 布局变化会让画布整体替换节点数组；
    // 选中态挂在被替换的对象上就会在这里被冲掉
    await act(async () => {
      useLayoutStore.getState().setPosition('world', 'task-001', { x: 240, y: 180 });
    });

    expect(useSelectionStore.getState().selectedNodeId).toBe('task-001');
    expect(isNodeSelected('task-001')).toBe(true);
  });

  it('平移或缩放画布后选中态不丢失', async () => {
    resetWorld();
    await renderApp();

    await act(async () => {
      tapNode('task-001');
    });

    // 视口变化会触发缩放状态更新，进而重算节点数组
    await act(async () => {
      fireEvent.wheel(document.querySelector('.react-flow__pane')!, { deltaY: 120 });
    });

    expect(isNodeSelected('task-001')).toBe(true);
  });

  it('进入子场景再返回后，外层选中态按快照恢复', async () => {
    resetWorld();
    await renderApp();

    await act(async () => {
      tapNode('task-002');
    });
    expect(useSelectionStore.getState().selectedNodeId).toBe('task-002');

    // 双击进入（完整序列：两次轻点 + dblclick），返回后外层仍应保有原来的选中
    await act(async () => {
      doubleTapNode('task-002');
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('返回上一场景'));
    });

    await act(async () => {
      useSceneStore.setState({ currentScene: 'world' });
    });

    expect(useSelectionStore.getState().selectedNodeId).toBe('task-002');
  });
});

describe('拖动不改变选中态', () => {
  it('拖动未选中的节点不会把它选中', async () => {
    resetWorld();
    await renderApp();

    await act(async () => {
      dragNode('task-001');
    });

    expect(useSelectionStore.getState().selectedNodeId).toBeNull();
    expect(isNodeSelected('task-001')).toBe(false);
  });

  it('拖动已选中的节点保持选中', async () => {
    resetWorld();
    await renderApp();

    await act(async () => {
      tapNode('task-001');
    });
    expect(useSelectionStore.getState().selectedNodeId).toBe('task-001');

    await act(async () => {
      dragNode('task-001', { x: 400, y: 300 }, { x: 30, y: 20 });
    });

    expect(useSelectionStore.getState().selectedNodeId).toBe('task-001');
    expect(isNodeSelected('task-001')).toBe(true);
  });

  it('位移超过阈值的拖动不会触发选中（与轻点区分开）', async () => {
    resetWorld();
    await renderApp();

    await act(async () => {
      dragNode('task-003', { x: 500, y: 300 }, { x: 40, y: 0 });
    });

    expect(useSelectionStore.getState().selectedNodeId).toBeNull();
  });
});

describe('相关连线强调', () => {
  it('选中节点后，与它相连的线提高对比度，无关的线降低对比度', () => {
    const related = { id: 'r1', source: 'task-001', target: 'config-001', type: 'references' as const };
    const unrelated = { id: 'r2', source: 'task-002', target: 'config-002', type: 'references' as const };

    const focusedRelated = relationEdgeStyle(related, 'task-001');
    const focusedUnrelated = relationEdgeStyle(unrelated, 'task-001');
    const noFocus = relationEdgeStyle(related, null);

    // 相关线更亮更粗
    expect(focusedRelated.opacity).toBe(1);
    expect(focusedRelated.strokeWidth).toBeGreaterThan(noFocus.strokeWidth);

    // 无关线降低对比度，但仍然是同一根线（虚线形态不变，不伪造断裂）
    expect(focusedUnrelated.opacity).toBeLessThan(1);
    expect(focusedUnrelated.strokeDasharray).toBe(noFocus.strokeDasharray);

    // 没有选中时所有线一致
    expect(noFocus.opacity).toBe(1);
    expect(relationEdgeStyle(unrelated, null)).toEqual(noFocus);
  });

  it('点与线方向无关：源或目标命中都算相关', () => {
    const asSource = { id: 'r1', source: 'task-001', target: 'config-001', type: 'references' as const };
    const asTarget = { id: 'r2', source: 'config-001', target: 'task-001', type: 'references' as const };

    expect(isRelationFocused(asSource, 'task-001')).toBe(true);
    expect(isRelationFocused(asTarget, 'task-001')).toBe(true);
    expect(isRelationFocused(asSource, 'task-999')).toBe(false);
  });
});
