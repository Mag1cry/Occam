/**
 * 投影契约测试
 *
 * 直接对应 docs-Next-Version/command-center-design 中的验收条目：
 * - 外层只有四类世界节点，资料节点不得铺到外层；
 * - 外层只有真实关系，节点可以没有连线；
 * - Schedule 子 Task 不进入外层 ArchiveProjection；
 * - ConfigurationProjection 不生成虚假 Configuration → Capability；
 * - Core Event Log 与 Agent Audit 是两条来源不同的信息线；
 * - LOD 不改变投影事实（节点集合不变）。
 */

import { describe, expect, it } from 'vitest';
import { projectWorldScene } from './WorldProjection';
import type { WorldInput } from './WorldProjection';
import { projectTaskScene } from './TaskProjection';
import type { TaskSceneSource } from './TaskProjection';
import { projectLiveScheduleNodes, projectLiveScheduleScene } from './ScheduleProjection';
import { projectLiveArchiveScene } from './LiveArchiveProjection';
import type { GatewayDispatch, GatewaySchedule } from '../../api/gateway';
import type { TaskNode } from '../types/node';
import type { TaskStatus } from '../types/state';
import { calculateLOD } from '../../lib/lod';
import { aggregateSchedule } from '../../lib/attention';
import { buildMockSnapshot } from '../../mock';

/**
 * 夹具来源
 *
 * 投影只认后端网关快照的切片（运行时由 SceneRenderer 把快照传进来），
 * 所以这里用同一份离线快照装配输入——测试走的就是运行时那条链路。
 */
const fixture = buildMockSnapshot();
const worldInput: WorldInput = {
  tasks: fixture.tasks,
  schedules: fixture.schedules ?? [],
  dispatches: fixture.dispatches ?? [],
};
const taskSource: TaskSceneSource = {
  tasks: fixture.tasks,
  events: fixture.events,
  // 引用的三态从快照的同一批事实算（已注册清单 + 配置状态），判据在 referenceState.ts
  snapshot: fixture,
};

describe('WorldProjection：外层只有四类节点', () => {
  const world = projectWorldScene(worldInput);

  it('节点类型集合恰好是四类世界节点', () => {
    const types = new Set(world.nodes.map((n) => n.type));
    expect(types).toEqual(new Set(['task', 'schedule', 'archive', 'configuration']));
  });

  it('不包含任何资料节点', () => {
    const resources = world.nodes.filter((n) => n.type === 'resource');
    expect(resources).toHaveLength(0);
  });

  it('Archive 只有入口节点，历史 Task 不铺回 World', () => {
    const archives = world.nodes.filter((n) => n.type === 'archive');
    expect(archives).toHaveLength(1);

    // 被归档的 Task 不出现在外层
    const archivedTaskIds = ['task-006', 'task-007', 'task-008'];
    archivedTaskIds.forEach((id) => {
      const node = world.nodes.find((n) => n.id === id);
      if (node) {
        // 若存在，只能因为它本身就是外层 Task，而不是因为被归档
        expect(node.type).toBe('task');
      }
    });
  });

  it('Configuration 只有入口节点，配置资料不在外层', () => {
    const configs = world.nodes.filter((n) => n.type === 'configuration');
    expect(configs).toHaveLength(1);

    // Executor Configuration / Extension / Capability 全部不在外层
    ['config-001', 'ext-001', 'cap-001'].forEach((id) => {
      expect(world.nodes.find((n) => n.id === id)).toBeUndefined();
    });
  });

  it('外层没有连线：子场景关系不提升到全局', () => {
    expect(world.relations).toHaveLength(0);
  });

  it('每个节点都在投影中带有初始坐标', () => {
    world.nodes.forEach((node) => {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    });
  });

  it('每个外层节点都有场景入口，且入口不写死业务类型', () => {
    world.nodes.forEach((node) => {
      const entry = world.sceneEntries.find((e) => e.nodeId === node.id);
      expect(entry).toBeDefined();
      expect(entry?.canEnter).toBe(true);
      expect(entry?.targetScene).toBe(node.type);
    });
  });
});

/**
 * Schedule 局部世界
 *
 * 用**合成的网关输入**构造，不用夹具：跑的产品读的是网关快照，测试从同一形状
 * 出发才有意义。夹具里 `schedule-006` 那些特有构造一旦被当成数据事实，
 * 测试就开始验证原型而不是行为了。
 *
 * 刻意构造的数据：6 次派发，**最早那条失败且无人确认**。
 * 全部一起看是 attention，只看最近 4 次（都是 running）是 active——
 * 所以「聚合必须基于全部而非可见部分」可以被数据反证，而不是靠断言写死。
 */
const SCHEDULE: GatewaySchedule = {
  schedule_id: 'daily',
  name: '每日采集',
  cron: '0 9 * * *',
  timezone: 'UTC',
  enabled: true,
  executor_config_ref: 'localFunction:collect',
};

function taskNode(id: string, status: TaskStatus): TaskNode {
  return { id, type: 'task', label: id, x: 0, y: 0, status };
}

function family(): { tasks: TaskNode[]; dispatches: GatewayDispatch[] } {
  // 下标 0 是最早的一条
  const statuses: TaskStatus[] = ['failed', 'succeeded', 'running', 'running', 'running', 'running'];
  return {
    tasks: statuses.map((status, i) => taskNode(`t${i}`, status)),
    dispatches: statuses.map((_, i) => ({
      occurrence_key: `daily:2026-09-${20 + i}T09:00:00+00:00`,
      schedule_id: 'daily',
      task_ids: [`t${i}`],
      status: 'dispatched',
      updated_at: `2026-09-${20 + i}T09:00:00+00:00`,
    })) as GatewayDispatch[],
  };
}

const COLLAPSED = 4;

describe('Schedule 局部世界：四条关系里有的两条', () => {
  const { tasks, dispatches } = family();
  const model = projectLiveScheduleScene('daily', [SCHEDULE], tasks, dispatches);

  it('creates 的两端是 Schedule 与 occurrence，不越过 occurrence 直接连 Task', () => {
    const edges = model.projection.relations.filter((r) => r.type === 'creates');
    expect(edges).toHaveLength(6);
    edges.forEach((edge) => {
      expect(edge.source).toBe('daily');
      const target = model.projection.nodes.find((n) => n.id === edge.target);
      expect(target?.type === 'resource' && target.resource_kind).toBe('occurrence');
    });
  });

  it('materializes 的两端是 occurrence 与 Core Task', () => {
    const edges = model.projection.relations.filter((r) => r.type === 'materializes');
    expect(edges).toHaveLength(6);
    edges.forEach((edge) => {
      const source = model.projection.nodes.find((n) => n.id === edge.source);
      const target = model.projection.nodes.find((n) => n.id === edge.target);
      expect(source?.type === 'resource' && source.resource_kind).toBe('occurrence');
      expect(target?.type).toBe('task');
    });
  });

  it('只有两条关系：Entry / Definition 这一层已经确定不做', () => {
    // 设计文档列过四条权威关系，其中 has → Schedule Entry、references →
    // Task Definition 需要网关快照里有对应契约。那一层已决定不做，
    // 所以投影只产出两条——不是漏了，是这一层不存在。
    const types = new Set(model.projection.relations.map((r) => r.type));
    expect(types).toEqual(new Set(['creates', 'materializes']));
  });

  it('子 Task 分区只在 Schedule 内部存在，四区之和等于全部子 Task', () => {
    const total =
      model.partitions.needsDecision.length +
      model.partitions.active.length +
      model.partitions.attention.length +
      model.partitions.settled.length;
    expect(total).toBe(model.childTasks.length);
  });
});

describe('Schedule 聚合是派生的，不是写死的', () => {
  it('子 Task 数量等于真实 occurrence 数，而不是外围侧的估计值', () => {
    const { tasks, dispatches } = family();
    projectLiveScheduleNodes([SCHEDULE], tasks, dispatches).forEach((node) => {
      const owned = dispatches
        .filter((d) => d.schedule_id === node.id)
        .flatMap((d) => d.task_ids);
      expect(node.child_task_count).toBe(owned.length);
    });
  });

  it('聚合基于全部子 Task，可被数据反证', () => {
    const { tasks, dispatches } = family();
    const all = projectLiveScheduleScene('daily', [SCHEDULE], tasks, dispatches);
    expect(all.aggregate).toBe('attention');

    // 只看最近 4 次（都是 running）会得出 active：如果聚合被写死，
    // 或者只算最近的几次，下面这条会不成立。
    // 注意要显式切片：不给 maxOccurrences 时 visibleOccurrences 就是全部。
    const recentOnly = all.allOccurrences
      .slice(0, COLLAPSED)
      .map((o) => all.childTasks.find((task) => task.id === o.task_id))
      .filter((task): task is TaskNode => Boolean(task));
    expect(recentOnly).toHaveLength(COLLAPSED);
    expect(aggregateSchedule(recentOnly, 'complete')).toBe('active');
  });

  it('外层节点与局部场景说的是同一个聚合', () => {
    const { tasks, dispatches } = family();
    projectLiveScheduleNodes([SCHEDULE], tasks, dispatches).forEach((node) => {
      const scene = projectLiveScheduleScene(node.id, [SCHEDULE], tasks, dispatches);
      expect(scene.aggregate).toBe(node.aggregated_state);
    });
  });
});

describe('ScheduleProjection：重复执行的历史折叠', () => {
  const { tasks, dispatches } = family();

  it('折叠只削减可见节点，聚合与分区仍基于全部 occurrence', () => {
    const collapsed = projectLiveScheduleScene('daily', [SCHEDULE], tasks, dispatches, { maxOccurrences: COLLAPSED });
    const expanded = projectLiveScheduleScene('daily', [SCHEDULE], tasks, dispatches);

    expect(collapsed.allOccurrences.length).toBeGreaterThan(COLLAPSED);
    expect(collapsed.visibleOccurrences).toHaveLength(COLLAPSED);
    expect(collapsed.hiddenOccurrenceCount).toBe(collapsed.allOccurrences.length - COLLAPSED);

    // 聚合与分区不因折叠而改变
    expect(collapsed.aggregate).toBe(expanded.aggregate);
    expect(collapsed.childTasks).toHaveLength(expanded.childTasks.length);
    expect(collapsed.partitions.settled.length).toBe(expanded.partitions.settled.length);
  });

  it('折叠时画布上只有可见 occurrence 和对应的 Task', () => {
    const collapsed = projectLiveScheduleScene('daily', [SCHEDULE], tasks, dispatches, { maxOccurrences: COLLAPSED });

    const occurrenceNodes = collapsed.projection.nodes.filter(
      (n) => n.type === 'resource' && n.resource_kind === 'occurrence'
    );
    expect(occurrenceNodes).toHaveLength(COLLAPSED);
    expect(collapsed.projection.nodes.filter((n) => n.type === 'task')).toHaveLength(COLLAPSED);

    // 被折叠的 occurrence 既没有节点也没有边
    collapsed.allOccurrences.slice(COLLAPSED).forEach((occurrence) => {
      expect(collapsed.projection.nodes.find((n) => n.id === occurrence.occurrence_id)).toBeUndefined();
      expect(collapsed.projection.relations.some((r) => r.source === occurrence.occurrence_id)).toBe(false);
    });
  });

  it('展开后全部 occurrence 与 Task 都在画布上', () => {
    const expanded = projectLiveScheduleScene('daily', [SCHEDULE], tasks, dispatches);

    expect(expanded.hiddenOccurrenceCount).toBe(0);
    expect(expanded.visibleOccurrences).toHaveLength(expanded.allOccurrences.length);
    expect(expanded.projection.nodes.filter((n) => n.type === 'task')).toHaveLength(expanded.allOccurrences.length);
  });

  it('可见的是最近几次：按触发时间倒序', () => {
    const collapsed = projectLiveScheduleScene('daily', [SCHEDULE], tasks, dispatches, { maxOccurrences: COLLAPSED });
    const times = collapsed.visibleOccurrences.map((o) => o.triggered_at ?? '');
    expect(times).toEqual([...times].sort((a, b) => b.localeCompare(a)));
  });
});


describe('场景入口：可进入性由投影声明，不由节点类型决定', () => {
  it('Schedule 子 Task 是真实 Core Task：能打开自己的局部世界', () => {
    // 外围每次 occurrence 仍创建独立 Core Task（world-model.md 第 3 节），
    // 它们和外层 Task 只有「由谁创建」的区别。数据源只查外层数组时，
    // 这里会返回 null，场景变成「对象不可用」。
    const model = projectTaskScene('sched-task-001', taskSource);

    expect(model.task).not.toBeNull();
    expect(model.task?.label).toBe('数据库备份');
    // 真实引用也照样解析：它的 Executor Configuration 不是空的
    expect(model.executor?.ref).toBe('config-004');
    expect(model.executor?.state).toBe('resolvable');
  });

  it('折叠不改变谁可以被打开：入口按全部子 Task 声明', () => {
    const { tasks, dispatches } = family();
    const collapsed = projectLiveScheduleScene('daily', [SCHEDULE], tasks, dispatches, { maxOccurrences: 4 });

    // 画布上只有最近 4 次，但 6 次都能进：可进入性是对象的属性，不是视口的属性
    expect(collapsed.projection.nodes.filter((n) => n.type === 'task')).toHaveLength(4);
    expect(collapsed.projection.sceneEntries).toHaveLength(collapsed.childTasks.length);
    expect(collapsed.projection.sceneEntries.length).toBeGreaterThan(4);

    collapsed.projection.sceneEntries.forEach((entry) => {
      expect(entry.canEnter).toBe(true);
      expect(entry.targetScene).toBe('task');
    });
  });

  it('入口只给 Core Task：资料节点没有自己的局部世界', () => {
    const { tasks, dispatches } = family();
    const model = projectLiveScheduleScene('daily', [SCHEDULE], tasks, dispatches);
    const enterable = new Set(model.projection.sceneEntries.map((e) => e.nodeId));

    model.projection.nodes
      .filter((node) => node.type === 'resource')
      .forEach((node) => {
        expect(enterable.has(node.id)).toBe(false);
      });
  });

  it('档案馆为每个历史 Task 声明入口', () => {
    // 走 live 投影：跑的产品用的是它，不是那份读夹具的同名函数
    const archive = projectLiveArchiveScene(fixture);

    expect(archive.total).toBeGreaterThan(0);
    expect(archive.projection.sceneEntries).toHaveLength(archive.total);
    archive.projection.sceneEntries.forEach((entry) => {
      expect(entry.canEnter).toBe(true);
      expect(entry.targetScene).toBe('task');
    });
  });
});

describe('TaskProjection', () => {
  it('两条信息线在数据源上就分开：投影只产出 Core 侧', () => {
    const model = projectTaskScene('task-005', taskSource);

    expect(model.events.length).toBeGreaterThan(0);
    // 模型里只有 Core 侧的东西。审计是执行者外围的 checkpoint 投影，
    // 由场景按需从 `GET /api/tasks/{id}/agent-audit` 读——
    // 一旦有人再把审计塞回这个模型，两条线就又混到一起了，所以锁死字段集合。
    expect(Object.keys(model).sort()).toEqual(['events', 'executor', 'pendingToolId', 'task']);
  });

  it('没有 pending_tool_id 时不给 pending Capability 摘要', () => {
    const model = projectTaskScene('task-001', taskSource);
    expect(model.pendingToolId).toBeNull();
  });

  it('pending_tool_id 存在时给出 pending Capability 摘要，且只给引用本身', () => {
    const model = projectTaskScene('task-009', taskSource);
    expect(model.pendingToolId).toBe('payment-gateway');
  });

  it('未知 Task 不伪造替代对象', () => {
    const model = projectTaskScene('task-does-not-exist', taskSource);
    expect(model.task).toBeNull();
    expect(model.executor).toBeNull();
    expect(model.pendingToolId).toBeNull();
  });

  it('局部真实关系解析成引用摘要：uses → Executor Configuration', () => {
    const model = projectTaskScene('task-001', taskSource);

    // 引用来自真实的 executor_config_id；它引用的 profile 是启用着的，所以可解析
    expect(model.task?.executor_config_id).toBe('config-001');
    expect(model.executor?.ref).toBe('config-001');
    expect(model.executor?.state).toBe('resolvable');
  });

  it('引用解析不到时不塌成「未知」：系统知道它曾是什么就说得出原因', () => {
    // 夹具里被用户停用的那个 profile：它不出现在「可被新建引用」的目录里，
    // 但配置状态里还有它那一行——所以是 offline（说得出原因），不是 unknown
    const known = projectTaskScene('task-002', {
      ...taskSource,
      tasks: taskSource.tasks.map((task) =>
        task.id === 'task-002'
          ? { ...task, executor_config_id: 'uniapi:legacy-research' }
          : task),
    });
    expect(known.executor?.state).toBe('offline');
    expect(known.executor?.reason).toContain('停用');

    // 谁都不认识的引用才是 unknown：只能承认不知道，不能编一个原因
    const stranger = projectTaskScene('task-001', {
      ...taskSource,
      tasks: taskSource.tasks.map((task) =>
        task.id === 'task-001' ? { ...task, executor_config_id: 'nobody:knows' } : task),
    });
    expect(stranger.executor?.state).toBe('unknown');
    expect(stranger.executor?.reason).not.toContain('停用');
  });

  // Task 场景没有节点和连线由 sceneOverlay.test.tsx 在 DOM 层断言：
  // 投影层只说「解析出哪些引用」，说不了「画布上有没有图」。
});

describe('LOD', () => {
  it('只改变显示密度，不改变投影节点集合', () => {
    const world = projectWorldScene(worldInput);
    const count = world.nodes.length;
    [0.1, 0.3, 0.6, 1.5].forEach((zoom) => {
      calculateLOD(zoom);
      expect(projectWorldScene(worldInput).nodes.length).toBe(count);
    });
  });

  it('按缩放给出三档密度', () => {
    expect(calculateLOD(0.2)).toBe('far');
    expect(calculateLOD(0.7)).toBe('mid');
    expect(calculateLOD(1.2)).toBe('near');
  });
});
