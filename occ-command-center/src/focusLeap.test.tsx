/**
 * Focus Leap 集成测试
 *
 * 验证：
 * - 双击节点进入局部场景，SceneStack.push()；
 * - 无法测量源节点时降级为直接切换（不影响数据和命令）；
 * - 返回锚点执行 SceneStack.pop()，外层仍保持 World；
 * - 外层节点坐标不因进入/返回而改变。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import App from './App';
import { useLayoutStore } from './store/layoutStore';
import { useSceneStore } from './store/sceneStore';
import { useSelectionStore } from './store/selectionStore';
import { useTransitionStore } from './store/transitionStore';

function doubleClickNode(nodeId: string) {
  const element = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
  if (!element) throw new Error(`node ${nodeId} not found`);
  fireEvent.doubleClick(element);
}

/**
 * 给节点装上可测量的矩形
 *
 * jsdom 里节点的 getBoundingClientRect 恒为 0，测量会失败并走降级路径；
 * 要测「返回时飞回源节点」必须让测量真的成功。
 */
function stubNodeRect(nodeId: string, rect: { x: number; y: number; width: number; height: number }) {
  const element = document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${nodeId}"]`
  );
  if (!element) throw new Error(`node ${nodeId} not found`);
  element.getBoundingClientRect = () =>
    ({ ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => rect }) as DOMRect;
}

async function renderApp() {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  await act(async () => {
    render(<App />);
  });
  errorSpy.mockRestore();
}

describe('Focus Leap', () => {
  it('双击 Task 节点进入 TaskScene，返回后回到 World', async () => {
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

    await renderApp();

    // 记录进入前的外层坐标
    const positionBefore = useLayoutStore.getState().getPosition('world', 'task-002');

    await act(async () => {
      doubleClickNode('task-002');
    });

    // 降级路径：jsdom 无法测量节点，直接切换场景
    expect(useSceneStore.getState().currentScene).toBe('task');
    expect(useSceneStore.getState().stack).toHaveLength(2);
    expect(useSceneStore.getState().stack[1].focusId).toBe('task-002');

    // TaskScene 的两条信息线出现
    expect(screen.getByText('Agent 审计')).toBeTruthy();
    expect(screen.getByText('内核事件')).toBeTruthy();

    // HUD 的焦点显示对象名，不是裸 ID
    expect(screen.getByText('任务 · 部署生产环境')).toBeTruthy();

    // 返回锚点出现
    const anchor = screen.getByLabelText('返回上一场景');
    expect(anchor).toBeTruthy();

    await act(async () => {
      fireEvent.click(anchor);
    });

    // 转场结束（动画完成回调或兜底超时）后提交 pop
    await waitFor(
      () => {
        expect(useSceneStore.getState().currentScene).toBe('world');
      },
      { timeout: 3000 }
    );
    expect(useSceneStore.getState().stack).toHaveLength(1);

    // 外层坐标未被动画或进入过程改写
    expect(useLayoutStore.getState().getPosition('world', 'task-002')).toEqual(
      positionBefore
    );
  });

  it('双击 Schedule 节点进入 ScheduleScene', async () => {
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

    await renderApp();

    await act(async () => {
      doubleClickNode('schedule-001');
    });

    expect(useSceneStore.getState().currentScene).toBe('schedule');

    // 子 Task 分区只在 Schedule 内部存在
    expect(screen.getByText('子 Task 分区 · 仅编排台内部')).toBeTruthy();
    expect(screen.getAllByText('待拍板').length).toBeGreaterThan(0);
  });

  it('从编排台双击子 Task 进入它的局部世界', async () => {
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

    await renderApp();

    await act(async () => {
      doubleClickNode('schedule-001');
    });
    expect(useSceneStore.getState().currentScene).toBe('schedule');

    // 子 Task 是真实 Core Task：它和外层 Task 有同一套入口
    await act(async () => {
      doubleClickNode('sched-task-002');
    });

    const state = useSceneStore.getState();
    expect(state.currentScene).toBe('task');
    expect(state.stack).toHaveLength(3);
    expect(state.stack[2].focusId).toBe('sched-task-002');

    // 打开的是它自己的局部世界，不是「对象不可用」
    expect(screen.queryByText('对象不可用')).toBeNull();
    expect(screen.getAllByText('校验备份完整性').length).toBeGreaterThan(0);

    // 源对象的名字随帧入栈：返回时飞行代理显示的是它，不是节点 ID
    expect(state.stack[2].source?.label).toBe('校验备份完整性');
  });

  it('没有审计投影来源时说「不可用」，不说成「没有调用」', async () => {
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

    await renderApp();

    // schedule-003 的子 Task「生成日报」在运行中，但没有它的审计调用
    await act(async () => {
      doubleClickNode('schedule-003');
    });
    await act(async () => {
      doubleClickNode('sched-task-005');
    });

    // 「后端没有这条数据」和「这条数据是空的」是两件事：后端还没有审计投影
    // 接口（backend-contract.md 第 7 节属目标契约），所以这里只能报不可用。
    // 曾经按「任务在运行」就报可用——那是把缺失的数据源说成空数据源。
    expect(
      screen.getByText('审计资料不可用 —— 不显示 Core Event 补出的 Agent 参数或流程')
    ).toBeTruthy();
    expect(screen.queryByText('审计投影可用，当前没有可显示的调用记录')).toBeNull();
  });

  it('资料节点没有局部世界：双击 occurrence 不进入', async () => {
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

    await renderApp();

    await act(async () => {
      doubleClickNode('schedule-001');
    });

    await act(async () => {
      doubleClickNode('occ-001-1');
    });

    // 入口由投影声明：资料节点不在入口表里
    expect(useSceneStore.getState().currentScene).toBe('schedule');
    expect(useSceneStore.getState().stack).toHaveLength(2);
  });

  it('返回飞行飞回源节点：用进入时测到的矩形，不是写死的 world 坐标', async () => {
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

    await renderApp();

    await act(async () => {
      doubleClickNode('schedule-001');
    });

    // 源矩形：进入时测到的屏幕坐标
    const rect = { x: 320, y: 240, width: 168, height: 84 };
    stubNodeRect('sched-task-002', rect);

    await act(async () => {
      doubleClickNode('sched-task-002');
    });

    // 飞行结束后提交入栈（动画回调或 900ms 兜底）
    await waitFor(
      () => {
        expect(useSceneStore.getState().currentScene).toBe('task');
      },
      { timeout: 3000 }
    );

    const frame = useSceneStore.getState().stack[2];
    expect(frame.source?.rect).toEqual(rect);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('返回上一场景'));
    });

    const proxy = useTransitionStore.getState().proxy;
    expect(proxy?.direction).toBe('exit');
    expect(proxy?.targetRect).toEqual(rect);
    expect(proxy?.label).toBe('校验备份完整性');

    // 回到编排台，而不是被弹回 world
    await waitFor(
      () => {
        expect(useSceneStore.getState().currentScene).toBe('schedule');
      },
      { timeout: 3000 }
    );
    expect(useSceneStore.getState().stack).toHaveLength(2);
  });

  /**
   * 这条只锁住「挂载时用的是视口记忆」，锁不住 fitView 分支本身：
   * jsdom 里 React Flow 节点尺寸恒为 0，fitView 无从计算，两个分支
   * 的结果一样。fitView 与视口记忆的取舍见 DESIGN.md 第 5 节。
   */
  it('返回场景时画布按视口记忆挂载', async () => {
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

    await renderApp();

    // 用户平移缩放过的外层视口
    await act(async () => {
      useLayoutStore.setState({
        viewports: { world: { zoom: 0.5, pan: { x: 111, y: 222 } } },
      });
    });

    // 离开再回来：画布会重新挂载
    await act(async () => {
      doubleClickNode('task-002');
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('返回上一场景'));
    });
    await waitFor(
      () => {
        expect(useSceneStore.getState().currentScene).toBe('world');
      },
      { timeout: 3000 }
    );

    // 视口记忆优先于 fitView：否则「返回后恢复外层 viewport」只在 store 里成立
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
    expect(viewport?.style.transform).toMatch(/translate\(111px,\s*222px\)/);
    expect(viewport?.style.transform).toMatch(/scale\(0\.5\)/);
  });

  it('返回后按恢复的视口决定信息密度，不会所有节点都展开', async () => {
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

    await renderApp();

    // 用户把外层缩到只看轮廓
    await act(async () => {
      useLayoutStore.setState({
        viewports: { world: { zoom: 0.3, pan: { x: 0, y: 0 } } },
      });
    });

    await act(async () => {
      doubleClickNode('task-002');
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('返回上一场景'));
    });
    await waitFor(
      () => {
        expect(useSceneStore.getState().currentScene).toBe('world');
      },
      { timeout: 3000 }
    );

    // 视口本身没被改写
    expect(useLayoutStore.getState().getViewport('world').zoom).toBeCloseTo(0.3, 5);

    // 0.3 是 far 档：只留状态环，不画标题。
    // 视口记忆直接套用、不会再触发一次 onMove，渲染密度必须按记忆里的缩放算，
    // 否则会用初始值 1（near）把所有节点撑开。
    // 用 task-001（运行中，无注意力）当样本：响铃/亮灯节点本来就被
    // effectiveLOD 保底到 mid，不参与这条断言。
    const node = document.querySelector('.react-flow__node[data-id="task-001"]');
    expect(node).toBeTruthy();
    expect(node?.textContent).not.toContain('分析用户反馈数据');
  });

  it('进入与返回只改变 UI Scene State，不修改业务对象', async () => {
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

    await renderApp();

    const businessStateBefore = JSON.stringify(
      (await import('./mock')).mockTasks.find((t) => t.id === 'task-002')
    );
    const selectionBefore = useSelectionStore.getState().selectedNodeId;

    await act(async () => {
      doubleClickNode('task-002');
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('返回上一场景'));
    });
    await waitFor(
      () => {
        expect(useSceneStore.getState().currentScene).toBe('world');
      },
      { timeout: 3000 }
    );

    const businessStateAfter = JSON.stringify(
      (await import('./mock')).mockTasks.find((t) => t.id === 'task-002')
    );

    expect(businessStateAfter).toBe(businessStateBefore);
    expect(useSelectionStore.getState().selectedNodeId).toBe(selectionBefore);
  });
});
