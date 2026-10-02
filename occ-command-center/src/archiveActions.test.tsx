/**
 * 历史的那两半：**外面归档，里面删除**
 *
 * 一条跑完的 Task 先堆在**外面**（世界 / 任务详情），在那儿按「归档」把它收进
 * 档案馆；收进去之后，它在这个场景里只剩一个动作——**删除**。
 *
 * 弄反了会很难受：馆里是"归档的地方"，进来的都已经归档过了，再给一次「归档」
 * 等于问一件已经做完的事；而「删除」不可撤销，摆在日常视野里迟早有人误按。
 *
 * 三道门都在后端（`core/task.py`），这里钉的是**牌面跟不跟得上**：
 *
 * - 归档只给**跑完的**（还在动的不是历史）；
 * - 删除只给**归档过的**（归档是那道确认门）；
 * - 馆里装的是归档过的，不是"所有跑完的"。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArchiveScene } from './scenes/ArchiveScene/ArchiveScene';
import { WorldScene } from './scenes/WorldScene/WorldScene';
import { ScheduleScene } from './scenes/ScheduleScene/ScheduleScene';
import { projectLiveArchiveScene } from './core/projection/LiveArchiveProjection';
import { buildMockSnapshot } from './mock/snapshot';
import { tapNode } from './test/interactions';
import { useSelectionStore } from './store/selectionStore';
import { useLayoutStore } from './store/layoutStore';

const SNAPSHOT = buildMockSnapshot();

/** 夹具里跑完但**没归档**的那条（它该出现在世界里，牌面上给「归档」） */
const FINISHED = 'task-005';
/** 夹具里**归档过**的那条（它该出现在档案馆里，牌面上给「删除」） */
const ARCHIVED = 'task-007';

/** 同一条快照，但指定那条已经归档过了 */
function archived(taskId: string) {
  return {
    ...SNAPSHOT,
    tasks: SNAPSHOT.tasks.map((task) =>
      task.id === taskId ? { ...task, archived_at: '2026-09-29T00:00:00Z' } : task),
  };
}

beforeEach(() => {
  useSelectionStore.setState({ selectedNodeId: null });
  // 布局是持久化的：每个用例从一张空画布开始
  useLayoutStore.setState({ entries: {}, viewports: {} });
});

afterEach(() => {
  useSelectionStore.setState({ selectedNodeId: null });
  useLayoutStore.setState({ entries: {}, viewports: {} });
});

/** 画布上每个节点现在在哪儿（读的是 React Flow 写在 style 上的那个 transform） */
function positions(): Record<string, string> {
  const found: Record<string, string> = {};
  document.querySelectorAll('.react-flow__node').forEach((element) => {
    const id = element.getAttribute('data-id') ?? '';
    found[id] = (element as HTMLElement).style.transform ?? '';
  });
  return found;
}

/** 操作牌上那几个按钮的文案 */
function surfaceLabels(): string[] {
  return Array.from(document.querySelectorAll('button'))
    .map((button) => button.textContent?.trim() ?? '')
    .filter(Boolean);
}

describe('外面：归档', () => {
  it('世界场景里，跑完的 Task 给「归档」而不是「删除」', () => {
    render(<WorldScene snapshot={SNAPSHOT} />);

    tapNode(FINISHED);

    expect(surfaceLabels()).toContain('归档');
    // 删不可撤销，它摆在馆里——不混进日常视野
    expect(surfaceLabels()).not.toContain('删除');
  });

  it('还在跑的 Task 不给「归档」：还在动的东西不是历史', () => {
    render(<WorldScene snapshot={SNAPSHOT} />);

    tapNode('task-009');            // running + 等工具

    expect(surfaceLabels()).not.toContain('归档');
  });
});

describe('馆里：删除', () => {
  it('档案馆里只有「删除」，没有「归档」', () => {
    render(<ArchiveScene snapshot={SNAPSHOT} />);

    tapNode(ARCHIVED);

    // 不可撤销的命令要先过预览，所以牌面上写的是「删除需预览」
    expect(surfaceLabels()).toContain('删除需预览');
    // 进来的都已经归档过了，再给一次等于问一件已经做完的事
    expect(surfaceLabels()).not.toContain('归档');
  });
});

describe('编排台：子 Task 那两半也在那儿走完', () => {
  /*
    Schedule 的子 Task **不进外层档案馆**（`projection-contract.md` §3：馆里只投影
    非 Schedule Task），而它们在外层世界里也看不见（归编排台管）。所以「收起来 →
    删掉」这两半**只在编排台里**有入口：少给一半，一条跑完的子 Task 就永远堆在
    那一屏上，哪儿都删不掉。
  */
  const CHILD = 'sched-task-001';          // 夹具里 schedule-001 跑完的那一条

  it('跑完的子 Task 给「归档」', () => {
    render(<ScheduleScene scheduleId="schedule-001" snapshot={SNAPSHOT} />);

    tapNode(CHILD);

    expect(surfaceLabels()).toContain('归档');
    // 删不可撤销，它要等归档那道门走过才出现
    expect(surfaceLabels()).not.toContain('删除需预览');
  });

  it('归档过的子 Task 给「删除」', () => {
    render(<ScheduleScene scheduleId="schedule-001" snapshot={archived(CHILD)} />);

    tapNode(CHILD);

    expect(surfaceLabels()).toContain('删除需预览');
    // 那一格**留在编排台**：这里不像外层那样"收进去就离开这个屏幕"
    expect(document.querySelector(`.react-flow__node[data-id="${CHILD}"]`)).not.toBeNull();
  });

  it('馆里不装子 Task——归档了也不去那儿', () => {
    // 它归编排台管，两个场景都能删的话，删完另一处还不知道
    const model = projectLiveArchiveScene(archived(CHILD));
    const ids = model.entries.map((entry) => entry.task.id);

    expect(ids).not.toContain(CHILD);
    // 而外面那个计数要说同一件事，否则点进去就对不上
    expect(model.total).toBe(ids.length);
  });

  it('世界入口上的「N 条归档」不数子 Task：数进去的话点开就对不上', async () => {
    const withArchivedChild = archived(CHILD);
    const { projectWorldScene } = await import('./core/projection/WorldProjection');
    const model = projectWorldScene({
      tasks: withArchivedChild.tasks,
      schedules: withArchivedChild.schedules ?? [],
      dispatches: withArchivedChild.dispatches ?? [],
    });
    const entry = model.nodes.find((node) => node.id === 'archive-entry');

    const archivedIds = withArchivedChild.tasks
      .filter((task) => task.archived_at).map((task) => task.id);
    // 夹具里三条归档过的：两条普通 Task + 一条子 Task
    expect(archivedIds).toHaveLength(3);
    expect(archivedIds).toContain(CHILD);

    // 馆里不摆它，那个数也就不能数它
    const model2 = projectLiveArchiveScene(withArchivedChild);
    expect(model2.entries.map((entryItem) => entryItem.task.id)).not.toContain(CHILD);
    expect(model2.total).toBe(archivedIds.length - 1);
    expect(entry?.type === 'archive' && entry.record_count).toBe(model2.total);
  });
});

describe('动了历史，别的节点不许动', () => {
  it('归档一条之后，其余节点的位置**一个都不变**', () => {
    /*
      位置以前是**按下标算的**（`mapLiveState` 里 `index % 4`）：归档一条，后面
      每一条的下标都变了，于是用户没碰过的东西整块往前挪——"我只点了归档，
      怎么整块画布移位了"。

      现在一见到就把位置记进布局，从此只归那张表管：列表怎么变都不动它。
    */
    const { rerender } = render(<WorldScene snapshot={SNAPSHOT} />);
    const before = positions();
    expect(Object.keys(before).length).toBeGreaterThan(1);

    const archived = {
      ...SNAPSHOT,
      tasks: SNAPSHOT.tasks.map((task) =>
        task.id === FINISHED ? { ...task, archived_at: '2026-09-29T00:00:00Z' } : task),
    };
    rerender(<WorldScene snapshot={archived} />);

    const after = positions();
    // 归档的那条走了
    expect(after[FINISHED]).toBeUndefined();
    // 其余的**一格都没挪**
    for (const [id, spot] of Object.entries(before)) {
      if (id === FINISHED) continue;
      expect([id, after[id]]).toEqual([id, spot]);
    }
  });
});

describe('布局表只留还活着的', () => {
  const spotOf = (scene: string, id: string) =>
    useLayoutStore.getState().entries[`${scene}:${id}`];

  it('对象没了，它那一格跟着走', () => {
    /*
      不清的话这张表只增不减（还写进 localStorage），而那个 id 永远不会再出现。
      归档是哪一种？**离开这个世界**那一种——它不在世界里画了，世界那一格就该走。
    */
    const { rerender } = render(<WorldScene snapshot={SNAPSHOT} />);
    expect(spotOf('world', FINISHED)).toBeDefined();

    const archived = {
      ...SNAPSHOT,
      tasks: SNAPSHOT.tasks.map((task) =>
        task.id === FINISHED ? { ...task, archived_at: '2026-09-29T00:00:00Z' } : task),
    };
    rerender(<WorldScene snapshot={archived} />);

    expect(spotOf('world', FINISHED)).toBeUndefined();
    // 还在的那些一格都没动
    expect(spotOf('world', 'task-009')).toBeDefined();
  });

  it('只是**没画**的不算没了：切筛选、收起包都要留着它的格子', () => {
    /*
      收起来的东西还活着。判据要是"这一屏画了什么"，那么收起一个包再展开，
      里面那些条目的位置已经被清掉，它们会跳回投影算出来的地方——而用户刚
      收起来又展开，什么都没改。
    */
    render(<ArchiveScene snapshot={SNAPSHOT} />);
    expect(spotOf('archive', ARCHIVED)).toBeDefined();
    expect(spotOf('archive', 'task-008')).toBeDefined();

    // 切到「已完成」：task-008（已取消）从画布上消失，但它还在馆里
    fireEvent.click(screen.getByRole('button', { name: '已完成' }));

    expect(spotOf('archive', 'task-008')).toBeDefined();
  });
});

describe('馆里装的是谁', () => {
  it('只装**归档过的**，不是"所有跑完的"', () => {
    const model = projectLiveArchiveScene(SNAPSHOT);
    const ids = model.entries.map((entry) => entry.task.id);

    expect(ids).toContain(ARCHIVED);
    // 它跑完了、但没人收过它——那是"可以被归档"，不是"归档了"
    expect(ids).not.toContain(FINISHED);
    expect(model.total).toBe(ids.length);
  });

  it('归档过的不在世界里——收起来了就该离开那个屏幕', async () => {
    /*
      收起来之后它还杵在世界里，那这个动作等于什么都没做，而那张卡片会永远占着
      一格。**跑完但没归档的仍然留着**——那正是"堆着等你收"的样子。
    */
    const { projectWorldScene } = await import('./core/projection/WorldProjection');
    const model = projectWorldScene({ tasks: SNAPSHOT.tasks, schedules: [], dispatches: [] });
    const ids = model.nodes.map((node) => node.id);

    expect(ids).not.toContain(ARCHIVED);
    expect(ids).toContain(FINISHED);

    // 不画不等于不数：入口上那个计数说的是同一批
    const entry = model.nodes.find((node) => node.id === 'archive-entry');
    expect(entry?.type === 'archive' && entry.record_count)
      .toBe(projectLiveArchiveScene(SNAPSHOT).total);
  });

  it('外面那个入口上写着的是**归档数**', async () => {
    // 「N 条归档」数的是收进去的那些；拿"跑完了"去数，那个数字会对不上馆里的条数
    const { projectWorldScene } = await import('./core/projection/WorldProjection');
    const model = projectWorldScene({
      tasks: SNAPSHOT.tasks, schedules: [], dispatches: [],
    });
    const entry = model.nodes.find((node) => node.id === 'archive-entry');

    expect(entry?.type === 'archive' && entry.record_count)
      .toBe(projectLiveArchiveScene(SNAPSHOT).total);
  });
});
