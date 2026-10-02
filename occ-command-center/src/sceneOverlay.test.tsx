/**
 * 局部场景 Overlay 布局测试
 *
 * 屏幕顶部中央是 HUD 的位置（fixed 屏幕坐标的注意力 Overlay）。
 * 子图场景的概览必须贴在左上角返回锚点下方，不能和 HUD 抢同一块屏幕；
 * Task 场景是一块全屏信息面，顶部内边距把 HUD 让开，审计页是完整的人机交互。
 *
 * 同时验证概览栈与飞行终点对齐：位置由 ANCHOR_* 常量派生，
 * 否则飞行代理会落到和锚点不重合的地方。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent, waitFor, within } from '@testing-library/react';
import App from './App';
import { useSceneStore } from './store/sceneStore';
import { useSelectionStore } from './store/selectionStore';
import { ANCHOR_POSITION, ANCHOR_SIZE } from './lib/flip';
import { tapNode } from './test/interactions';
import { getAgentAudit } from './api/gateway';
import { auditFixture } from './test/fixtures';

afterEach(() => {
  // 每个用例结束后把审计读取恢复成「执行者不提供审计」的默认行为
  const mocked = vi.mocked(getAgentAudit);
  mocked.mockReset();
  mocked.mockResolvedValue({ available: false, source: '', read_at: '', calls: [] });
});

function resetToWorld() {
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
}

async function renderApp() {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  await act(async () => {
    render(<App />);
  });
  errorSpy.mockRestore();
}

function doubleClickNode(nodeId: string) {
  const element = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
  if (!element) throw new Error(`node ${nodeId} not found`);
  fireEvent.doubleClick(element);
}

/**
 * 找出所有「顶部中央」固定定位元素
 *
 * HUD 的 top 来自内联 style，因此 className 同时含 top-5 与 left-1/2
 * 的元素就是抢占顶部中央的局部 Overlay。
 */
function topCenterElements(): Element[] {
  return Array.from(document.querySelectorAll('[class*="fixed"]')).filter((el) => {
    const cls = el.getAttribute('class') ?? '';
    return cls.includes('top-5') && cls.includes('left-1/2');
  });
}

describe.each([
  ['schedule', 'schedule-001'],
  ['archive', 'archive-entry'],
  ['configuration', 'configuration-entry'],
])('%s 场景 Overlay 布局', (scene, nodeId) => {
  it('不与 HUD 抢顶部中央', async () => {
    resetToWorld();
    await renderApp();

    await act(async () => {
      doubleClickNode(nodeId);
    });

    expect(useSceneStore.getState().currentScene).toBe(scene);

    // 顶部中央只属于 HUD
    expect(topCenterElements()).toHaveLength(0);
  });

  it('概览贴在左上角锚点正下方', async () => {
    resetToWorld();
    await renderApp();

    await act(async () => {
      doubleClickNode(nodeId);
    });

    const anchor = screen.getByLabelText('返回上一场景');
    expect(anchor).toBeTruthy();

    // 锚点自身位置即飞行终点
    expect(anchor.getAttribute('style')).toContain(`left: ${ANCHOR_POSITION.x}px`);
    expect(anchor.getAttribute('style')).toContain(`top: ${ANCHOR_POSITION.y}px`);
    expect(anchor.getAttribute('style')).toContain(`width: ${ANCHOR_SIZE.width}px`);
    expect(anchor.getAttribute('style')).toContain(`height: ${ANCHOR_SIZE.height}px`);

    // 概览栈从锚点下沿开始，且左对齐
    const stack = document.querySelector<HTMLElement>('[data-scene-overlay-stack]');
    expect(stack).toBeTruthy();

    const style = stack!.getAttribute('style') ?? '';
    expect(style).toContain(`left: ${ANCHOR_POSITION.x}px`);
    expect(style).toContain(`top: ${ANCHOR_POSITION.y + ANCHOR_SIZE.height + 10}px`);

    // 概览与锚点不重叠
    const stackTop = ANCHOR_POSITION.y + ANCHOR_SIZE.height + 10;
    expect(stackTop).toBeGreaterThan(ANCHOR_POSITION.y + ANCHOR_SIZE.height);
  });
});

describe('Task 场景：全屏信息面', () => {
  /**
   * 进入 task-001 的局部世界
   *
   * 审计投影来自执行者外围（按需读接口），所以这里显式给一份夹具——
   * 和真实后端给的一样形状。Core Event 来自快照，不需要另外准备。
   */
  async function enterTask() {
    vi.mocked(getAgentAudit).mockResolvedValue(auditFixture());
    resetToWorld();
    await renderApp();
    await act(async () => {
      doubleClickNode('task-001');
    });
    expect(useSceneStore.getState().currentScene).toBe('task');
  }

  function auditSurface(): HTMLElement {
    const surface = document.querySelector<HTMLElement>('[data-task-audit-surface]');
    if (!surface) throw new Error('audit surface not found');
    return surface;
  }

  it('没有画布：Task 是焦点场景，不是子图', async () => {
    await enterTask();

    expect(document.querySelector('.react-flow')).toBeNull();
    expect(document.querySelector('.react-flow__node')).toBeNull();
    expect(document.querySelector('.react-flow__edge')).toBeNull();
  });

  it('完整消息序列：人的输入和模型的话都在，不是只有工具调用', async () => {
    /*
      后端那份审计一直带着 `turns`（checkpoint 里那一串），前端以前整个丢掉、只画
      `calls`——于是系统提示、**人的输入**、模型每一次说的话全没了。而"它为什么
      这么干"的答案通常在模型上一句话里，不在那次调用的参数里。
    */
    await enterTask();

    const surface = auditSurface();
    // 人的输入
    expect(within(surface).getByText('查一下上个月的反馈')).toBeTruthy();
    // 模型的话，包括最后那段结论
    expect(within(surface).getByText(/上个月一共 1247 条反馈/)).toBeTruthy();
    // 系统提示也在这条序列里
    expect(within(surface).getByText(/系统提示/)).toBeTruthy();
    // 模型这一轮**要调什么**，跟在它那句话后面
    expect(within(surface).getByText(/要调用/)).toBeTruthy();
  });

  it('固定代码的执行者：画单卡（输入 → 输出），不是多卡', async () => {
    /*
      「agent 实例才有多卡审计，硬编码只有单卡的输入输出」——判据是**后端那句 `kind`**，
      前端不自己从执行者列表推（那是第二条推导路径，会漂）。

      固定代码跑一次就是"给它一句话、它回一句话"，中间没有别的东西。以前这里只说
      一句「审计资料不可用」——那把一个**正常的事实**说成了故障。
    */
    vi.mocked(getAgentAudit).mockResolvedValue({
      available: false, kind: 'plain', source: '', read_at: '', calls: [],
    });
    resetToWorld();
    await renderApp();
    await act(async () => {
      doubleClickNode('task-001');
    });

    const surface = auditSurface();
    // 卡片内容两格：给它的那句话 / 它回的那句话
    expect(within(surface).getByText(/委托摘要 ·/)).toBeTruthy();
    expect(within(surface).getByText(/执行结果 ·/)).toBeTruthy();
    // 人机交互那一串一格都不该出现（固定代码没有过程可看）
    expect(within(surface).queryByText('查一下上个月的反馈')).toBeNull();
    // 也不该把正常说成故障
    expect(within(surface).queryByText(/审计资料不可用/)).toBeNull();
  });

  it('人机交互按发生的顺序排：人的输入在模型之前', async () => {
    /*
      这一页的正文就是完整的人机交互。**顺序是它的一半内容**——把人的输入排到
      模型后面，读起来就是"它先说了一堆，然后我才问的"。
      jsdom 量不到位置，所以用 DOM 顺序替。
    */
    await enterTask();

    const surface = auditSurface();
    const 人的输入 = within(surface).getByText('查一下上个月的反馈');
    const 模型的话 = within(surface).getByText(/上个月一共 1247 条反馈/);

    const relation = 人的输入.compareDocumentPosition(模型的话);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('信息面从 HUD 下方开始，时间线不被 HUD 盖住', async () => {
    await enterTask();

    // HUD 是顶部中央的 fixed Overlay（top 20 + 胶囊高度），
    // 信息面的顶部内边距必须把它让开
    const inset = Number.parseInt(auditSurface().style.paddingTop, 10);
    expect(inset).toBeGreaterThanOrEqual(80);
  });

  it('工具调用在那条交互里面：要调什么、回来什么，都看得见', async () => {
    /*
      工具调用**不是另一件事**：它在交互里占两轮——模型那一轮说"要调用 X（参数）"，
      紧接着那一轮是工具回来的东西。把它们单列成一排会让它们从这条线里脱开，
      于是"它为什么这么干"读不出来。
    */
    await enterTask();

    const surface = within(auditSurface());
    // 模型那一轮里"要调什么"
    expect(surface.getByText('要调用')).toBeTruthy();
    // 工具名出现两次是**对的**：一次在模型那一轮的"要调用"里，一次在工具那一轮的身份上
    expect(surface.getAllByText('read_database').length).toBe(2);
    // 工具那一轮里"回来什么"，以及成没成
    expect(surface.getByText(/\{"rows": 1247\}/)).toBeTruthy();
    expect(surface.getByText('成功')).toBeTruthy();
  });

  it('身份条给出状态、持续时间和真实引用，都不是节点', async () => {
    await enterTask();

    const strip = within(auditSurface());
    expect(strip.getByText('分析用户反馈数据')).toBeTruthy();
    expect(strip.getByText('运行中')).toBeTruthy();
    expect(strip.getByText('已持续 60 分钟')).toBeTruthy();
    // task-001 引用 config-001：真实引用以徽标出现
    expect(strip.getByText('Standard Executor')).toBeTruthy();
    // Controller 观测是徽标，不是节点
    expect(strip.getAllByText('未知').length).toBeGreaterThan(0);

    // 身份条不是可拖动/可连线的空间对象
    expect(auditSurface().querySelector('.react-flow__node')).toBeNull();
  });

  it('操作牌由焦点对象生成，不依赖选中态', async () => {
    await enterTask();

    expect(useSelectionStore.getState().selectedNodeId).toBeNull();
    // running 任务的操作牌包含取消（高风险，先预览后提交）
    expect(screen.getAllByText('取消').length).toBeGreaterThan(0);
  });
});

describe('概览内容', () => {
  it('Schedule 场景在概览中给出规则、启用、聚合与子 Task 数', async () => {
    resetToWorld();
    await renderApp();

    await act(async () => {
      doubleClickNode('schedule-001');
    });

    expect(screen.getByText('规则')).toBeTruthy();
    expect(screen.getByText('启用')).toBeTruthy();
    expect(screen.getByText('聚合')).toBeTruthy();
    expect(screen.getByText('子 Task')).toBeTruthy();
  });
});

describe('档案馆内容', () => {
  async function enterArchive() {
    resetToWorld();
    await renderApp();
    await act(async () => {
      doubleClickNode('archive-entry');
    });
    expect(useSceneStore.getState().currentScene).toBe('archive');
  }

  /** 画布上渲染出的节点类型 */
  function renderedNodeTypes(): string[] {
    return Array.from(document.querySelectorAll('.react-flow__node')).map(
      (el) =>
        Array.from(el.classList)
          .find((c) => c.startsWith('react-flow__node-'))
          ?.replace('react-flow__node-', '') ?? ''
    );
  }

  it('只有 Task 节点，没有资料节点', async () => {
    await enterArchive();

    const types = renderedNodeTypes();
    expect(types.length).toBeGreaterThan(0);
    expect(new Set(types)).toEqual(new Set(['task']));
  });

  // 注意：不要在 DOM 上断言连线数量。
  // jsdom 里 React Flow 拿不到节点尺寸，根本不会渲染 .react-flow__edge，
  // 加不加连线数量恒为 0——那样的断言是假通过。
  // 「档案馆没有连线」由 projection.test.ts 在投影层断言。

  it('选中历史 Task 后可以进入它的局部世界', async () => {
    await enterArchive();

    await act(async () => {
      tapNode('task-007');
    });

    const enter = screen.getByText('进入任务世界', { selector: 'button' });
    await act(async () => {
      fireEvent.click(enter);
    });

    await waitFor(
      () => {
        expect(useSceneStore.getState().currentScene).toBe('task');
      },
      { timeout: 3000 }
    );
  });
});

describe('编排台：重复执行历史的折叠（每天一次的日程）', () => {
  /** 画布上的 occurrence 节点数（靠 id 前缀区分，它们都是资料节点） */
  function occurrenceNodeCount(): number {
    return Array.from(document.querySelectorAll('.react-flow__node-resource')).filter((el) =>
      (el.getAttribute('data-id') ?? '').startsWith('occ-006-')
    ).length;
  }

  /** 画布上的 Task 节点数 */
  function taskNodeCount(): number {
    return document.querySelectorAll('.react-flow__node-task').length;
  }

  async function enterDailySchedule() {
    resetToWorld();
    await renderApp();
    await act(async () => {
      doubleClickNode('schedule-006');
    });
    expect(useSceneStore.getState().currentScene).toBe('schedule');
  }

  it('默认只显示最近几次执行', async () => {
    await enterDailySchedule();

    expect(occurrenceNodeCount()).toBe(4);
    expect(taskNodeCount()).toBe(4);
    expect(screen.getByText('最近 4 次')).toBeTruthy();
  });

  it('展开后显示全部执行次数', async () => {
    await enterDailySchedule();

    await act(async () => {
      fireEvent.click(screen.getByText(/展开更早的 \d+ 次执行/));
    });

    expect(occurrenceNodeCount()).toBe(14);
    expect(taskNodeCount()).toBe(14);
    expect(screen.getByText('收起较早的执行')).toBeTruthy();
    expect(screen.getByText('全部 14 次')).toBeTruthy();
  });

  it('折叠不改变聚合：Aggregate 始终基于全部子 Task', async () => {
    await enterDailySchedule();

    // 「处理中」在概览和节点徽标各出现一次，这里只断言概览值
    const facts = () => within(document.querySelector('[data-scene-overlay-stack]')!);
    const readFacts = () => facts().getByText('聚合').parentElement?.textContent ?? '';

    // 折叠时就已经是「待检查」——最早的失败藏在折叠的历史里，
    // 只看可见的 4 次会得出「处理中」
    expect(readFacts()).toContain('待检查');
    expect(facts().getByText('14 个')).toBeTruthy();
    expect(facts().getByText('最近 4 次')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText(/展开更早的 \d+ 次执行/));
    });

    // 展开后聚合与子 Task 数都不变
    expect(readFacts()).toContain('待检查');
    expect(facts().getByText('14 个')).toBeTruthy();
    expect(facts().getByText('全部 14 次')).toBeTruthy();
  });

  it('画布上是快照能提供的那几个角色', async () => {
    await enterDailySchedule();

    const ids = Array.from(document.querySelectorAll('.react-flow__node')).map((el) =>
      el.getAttribute('data-id')
    );

    // 网关快照提供：外围 Schedule、派发记录（occurrence）、物化出的 Core Task
    expect(ids).toContain('schedule-006'); // Schedule
    expect(ids).toContain('occ-006-14'); // occurrence（最新一次）
    expect(ids).toContain('daily-task-14'); // 物化出的 Core Task
  });

  // Schedule Entry 与 Task Definition 目前**画不出来**：网关快照只有
  // `schedules` + `dispatches`，没有绑定记录和定义目录——它们是
  // backend-contract.md 第 3 节的目标契约。四角色与 has/references 关系的
  // 契约由 projection.test.ts 在投影层覆盖（那里用设计夹具）；等外围把这两个
  // 角色也放进快照，再在这里补 DOM 断言。现在补就是对着不存在的数据写测试。
});
