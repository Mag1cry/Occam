/**
 * ScheduleScene
 *
 * 编排台局部世界。集中管理该 Schedule 的多个 occurrence 和其展开的 Task，
 * 避免这些 Task 混入外层 Task 归档。
 *
 * 权威关系（projection-contract.md 第 4 节）：
 *   Schedule ──has──> Schedule Entry ──references──> Task Definition
 *   Schedule ──creates──> occurrence ──materializes──> Core Task
 *
 * 硬边界：
 * - 子 Task 的分区只在 Schedule 内部存在，不进入外层已收敛区，
 *   也不重复增加外层响铃/亮灯数量；
 * - 「不进外层」指的是归档与注意力计数，不是「不能打开」：子 Task 是真实
 *   Core Task，和外层 Task 一样双击进入自己的局部世界（入口由投影声明）；
 * - 重复执行的历史默认折叠，只显示最近几次；但聚合状态始终基于全部
 *   occurrence——不能用当前显示的几次冒充完整 Schedule 状态；
 * - 外围只提供映射时，不补造缺失的 Definition 或 occurrence。
 */

import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { SpatialCanvas } from '../../core/scene/SpatialCanvas';
import { projectLiveScheduleScene } from '../../core/projection/ScheduleProjection';
import { useSelectionStore } from '../../store/selectionStore';
import { useFocusLeap } from '../../hooks/useFocusLeap';
import { nodeAccent, nodeStateText } from '../../lib/nodeVisual';
import { CommandSurface } from '../../components/overlay/CommandSurface';
import { TaskResultOverlay } from '../../components/overlay/TaskResultOverlay';
import { SceneOverlayStack, SceneFacts } from '../../components/overlay/SceneOverview';
import type { SceneFact } from '../../components/overlay/SceneOverview';
import { buildNodeCommands } from '../../lib/commandMatrix';
import type { Command } from '../../core/types/projection';
import { scheduleStateText } from '../../lib/nodeVisual';
import { TaskNode } from '../../components/nodes/TaskNode';
import { ScheduleNode } from '../../components/nodes/ScheduleNode';
import { ResourceNode } from '../../components/nodes/ResourceNode';
import { workerAliveOf, workerUnreconciledOf,
         type GatewaySchedule, type GatewaySnapshot } from '../../api/gateway';
import { ScheduleEditorOverlay } from '../../components/overlay/ScheduleEditorOverlay';
import { executeScheduleCommand, executeTaskCommand } from '../../lib/objectCommands';
import { useGatewayStore } from '../../store/gatewayStore';

/** Entry / Definition / occurrence 是资料节点，不是外层 Schedule 节点 */
const nodeTypes = {
  task: TaskNode,
  schedule: ScheduleNode,
  resource: ResourceNode,
};

export interface ScheduleSceneProps {
  scheduleId: string;
  /** 后端网关快照：由 SceneRenderer 保证存在，场景自己不兜底 */
  snapshot: GatewaySnapshot;
}

/**
 * 默认显示最近几次执行
 *
 * 每天跑一次的日程三周就能积累二十多次，全铺开既读不动也画不下。
 * 历史默认折叠，展开是用户显式动作。
 */
const RECENT_OCCURRENCE_COUNT = 4;

/** 子 Task 分区：只在 Schedule 内部存在 */
const PARTITIONS = [
  { key: 'needsDecision', label: '待拍板' },
  { key: 'active', label: '运行' },
  { key: 'attention', label: '待检查' },
  { key: 'settled', label: '历史折叠' },
] as const;

export function ScheduleScene({ scheduleId, snapshot }: ScheduleSceneProps) {
  const { selectedNodeId, setSelected, toggleSelected } = useSelectionStore();
  const { enterScene, isFlying } = useFocusLeap();
  const load = useGatewayStore((state) => state.load);
  const [expandedPartitions, setExpandedPartitions] = useState<string[]>([
    'needsDecision',
    'active',
    'attention',
  ]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  /** 正在看结果的子 Task id（`null` 表示没有那个浮窗） */
  const [viewingResultFor, setViewingResultFor] = useState<string | null>(null);
  /** 正在编辑的这条日程（`null` 表示没有那个表单） */
  const [editingSchedule, setEditingSchedule] = useState<GatewaySchedule | null>(null);

  const model = useMemo(
    () => projectLiveScheduleScene(scheduleId, snapshot.schedules ?? [], snapshot.tasks, snapshot.dispatches ?? [], {
      maxOccurrences: historyExpanded ? undefined : RECENT_OCCURRENCE_COUNT,
    }),
    [scheduleId, historyExpanded, snapshot]
  );

  const schedule = model.projection.nodes.find((n) => n.id === scheduleId) ?? null;
  const selectedNode = model.projection.nodes.find((n) => n.id === selectedNodeId) ?? null;

  /**
   * 编排台里**存在**哪些节点（画着的 + 折叠起来的历史）
   *
   * 折叠只改这一屏画什么：那些派发和子 Task 都还在，它们的格子得留着，
   * 否则展开历史时它们会跳回投影算出来的地方。
   */
  const known = useMemo(() => new Set([
    ...model.projection.nodes.map((node) => node.id),
    ...(snapshot.dispatches ?? []).map((dispatch) => dispatch.occurrence_key),
    ...snapshot.tasks.map((task) => task.id),
  ]), [model.projection.nodes, snapshot]);

  const visibleNodeIds = useMemo(
    () => new Set(model.projection.nodes.map((n) => n.id)),
    [model.projection.nodes]
  );

  /**
   * 子 Task 是真实 Core Task，和 Outer Task 有同一套入口
   *
   * 可进入性由投影的 SceneEntry 声明，场景不按节点类型写死。
   */
  const sceneEntries = model.projection.sceneEntries;
  const selectedEntry = sceneEntries.find((entry) => entry.nodeId === selectedNodeId);

  /**
   * Schedule 自己的命令
   *
   * 触发 / 删除 / 启停三条都归 `executeScheduleCommand`（世界场景调的是**同一个**）。
   * 这里只管"编辑"那一格：它不是后端命令，而是打开那张表单。
   */
  const submitScheduleCommand = async (command: Command) => {
    /*
      **编辑不是一条后端命令**：它打开那张表单（和世界场景里那一格是同一张），
      由表单去写声明。返回 `submitted: false`——牌面上不出回执，回执等真正提交之后。
    */
    if (command.id === 'edit-schedule') {
      const target = (snapshot.schedules ?? [])
        .find((item) => item.schedule_id === scheduleId);
      if (target) setEditingSchedule(target);
      return { submitted: false } as const;
    }
    return executeScheduleCommand(
      command,
      {
        scheduleId,
        // **当前**的启用状态（提交前刚重读过），不是前端猜的意图
        enabled: selectedNode?.type === 'schedule' && selectedNode.enabled,
      },
      snapshot.declarations ?? []
    );
  };

  /**
   * 双击进入子 Task 的局部世界
   *
   * 进入是导航，不改变选中态：源场景视口与选中由 SceneStack 冻结恢复。
   */
  const handleNodeDoubleClick = useCallback(
    (nodeId: string) => {
      const entry = sceneEntries.find((e) => e.nodeId === nodeId);
      if (!entry?.canEnter || !entry.targetScene) return;

      const node = model.projection.nodes.find((n) => n.id === nodeId);
      if (!node) return;

      enterScene({
        nodeId,
        targetScene: entry.targetScene,
        label: node.label,
        color: nodeAccent(node),
        stateText: nodeStateText(node),
      });
    },
    [sceneEntries, model.projection.nodes, enterScene]
  );

  /**
   * 分区列表点击
   *
   * 条目可能落在被折叠的历史里：先展开，再选中，避免选到画布上不存在的节点。
   */
  const selectTask = (taskId: string) => {
    if (!visibleNodeIds.has(taskId)) setHistoryExpanded(true);
    setSelected(taskId);
  };

  return (
    <div className="relative w-full h-full">
      <SpatialCanvas
        sceneId="schedule"
        nodes={model.projection.nodes}
        relations={model.projection.relations}
        nodeTypes={nodeTypes}
        selectedNodeId={selectedNodeId}
        interactive={!isFlying}
        fitView
        onNodeClick={toggleSelected}
        onSelectionRestore={setSelected}
        onNodeDoubleClick={handleNodeDoubleClick}
        onPaneClick={() => setSelected(null)}
        onNodeLongPress={setSelected}
        known={known}
      />

      {/* 概览：贴在左上角返回锚点下方；顶部中央留给 HUD */}
      <SceneOverlayStack>
        <SceneFacts
          title={schedule?.label ?? 'Schedule'}
          facts={[
            ...(schedule?.type === 'schedule' && schedule.rule_summary
              ? [{ label: '规则', value: schedule.rule_summary }]
              : []),
            ...(schedule?.type === 'schedule'
              ? [
                  {
                    label: '启用',
                    value: schedule.enabled ? '已启用' : '已停用',
                    tone: (schedule.enabled ? 'info' : 'default') as SceneFact['tone'],
                  },
                  {
                    label: '聚合',
                    value: scheduleStateText(schedule.aggregated_state),
                  },
                ]
              : []),
            ...(model.completeness === 'partial'
              ? [
                  {
                    label: '映射',
                    value: '不完整，按等待对账处理',
                    tone: 'warning' as const,
                  },
                ]
              : []),
            { label: '子 Task', value: `${model.childTasks.length} 个` },
            {
              label: '当前显示',
              value: historyExpanded
                ? `全部 ${model.allOccurrences.length} 次`
                : `最近 ${model.visibleOccurrences.length} 次`,
            },
          ]}
        />
      </SceneOverlayStack>

      {/* 子 Task 分区 + 执行历史：仅在 Schedule 内部 */}
      <div className="fixed bottom-24 left-5 z-30 w-[320px] max-h-[40vh] overflow-auto">
        <div className="glass rounded-xl p-3">
          <div className="label topline pb-1.5 mb-2">子 Task 分区 · 仅编排台内部</div>
          <div className="space-y-2">
            {PARTITIONS.map((partition) => {
              const tasks = model.partitions[partition.key];
              const open = expandedPartitions.includes(partition.key);
              return (
                <div key={partition.key}>
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedPartitions((prev) =>
                        prev.includes(partition.key)
                          ? prev.filter((k) => k !== partition.key)
                          : [...prev, partition.key]
                      )
                    }
                    className="w-full flex items-center justify-between text-[12px] text-slate-300 hover:text-white transition-smooth"
                  >
                    <span>{partition.label}</span>
                    <span className="num text-slate-500">{tasks.length}</span>
                  </button>

                  {open && tasks.length > 0 && (
                    <div className="mt-1 space-y-1">
                      {tasks.map((task) => (
                        <button
                          key={task.id}
                          type="button"
                          onClick={() => selectTask(task.id)}
                          className="w-full text-left px-2 py-1 rounded-lg text-[11px] text-slate-300 bg-white/[0.03] border border-white/5 hover:border-white/20 hover:text-slate-100 transition-smooth truncate"
                        >
                          {task.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 执行历史折叠：只改变可见节点，不改变聚合 */}
          {model.hiddenOccurrenceCount > 0 || historyExpanded ? (
            <button
              type="button"
              onClick={() => setHistoryExpanded((prev) => !prev)}
              className="mt-3 pt-2 w-full flex items-center justify-between text-[11px] text-occ-accent hover:text-occ-accent-light transition-smooth border-t border-white/10"
            >
              <span className="flex items-center gap-1">
                {historyExpanded ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
                {historyExpanded
                  ? '收起较早的执行'
                  : `展开更早的 ${model.hiddenOccurrenceCount} 次执行`}
              </span>
              <span className="num text-slate-500">
                {model.visibleOccurrences.length}/{model.allOccurrences.length}
              </span>
            </button>
          ) : null}
        </div>
      </div>

      {selectedNode && !isFlying && (
        <CommandSurface
          targetLabel={selectedNode.label}
          model={buildNodeCommands(selectedNode, {
            canEnter: Boolean(selectedEntry?.canEnter),
            enterLabel: selectedEntry?.label ?? '进入局部场景',
            workerAlive:
              selectedNode.type === 'task'
                ? workerAliveOf(snapshot, selectedNode.id)
                : undefined,
            workerUnreconciled:
              selectedNode.type === 'task'
                ? workerUnreconciledOf(snapshot, selectedNode.id)
                : undefined,
            /*
              **跑完的子 Task 在这儿归档、然后删掉。**

              它们在外层根本看不见，归档后也不会进档案馆（§3：馆里只投影非
              Schedule Task）——所以这两半都得在这里给：少给一半，跑完的子 Task
              就永远堆在这一屏上，而「删除」在别处一个入口都没有。
              按节点自己的 `archived_at` 选那一半，同一条 Task 不会同时出现两格。
            */
            historyAction: selectedNode.type === 'task'
              ? (selectedNode.archived_at ? 'forget' : 'archive')
              : undefined,
            historyScope: 'schedule',
          })}
          onEnterScene={() => handleNodeDoubleClick(selectedNode.id)}
          onExecute={async (command) => {
            // 编排台里的子 Task 是真实 Core Task：命令走和 World 上一样的 Task 映射
            const outcome = selectedNode.type === 'task'
              ? await executeTaskCommand(command, selectedNode.id)
              : await submitScheduleCommand(command);
            // 提交成功只表示 Core 已接收：真实状态以重读的对象为准
            if (outcome.submitted && outcome.ok) void load();
            return outcome;
          }}
          // 编排台里的子 Task 是真实 Core Task，所以它也有「查看结果」那一条——
          // 只读命令没有后端命令，走 `onExecute` 会静默返回（见 `onView` 的说明）
          onView={(command) => {
            if (command.id === 'view-result' && selectedNode.type === 'task') {
              setViewingResultFor(selectedNode.id);
            }
          }}
        />
      )}

      {viewingResultFor && (
        <TaskResultOverlay
          taskId={viewingResultFor}
          onClose={() => setViewingResultFor(null)}
        />
      )}

      {/* 改这条日程：和工作场景里那一格是同一张表单 */}
      {editingSchedule && (
        <ScheduleEditorOverlay
          schedule={editingSchedule}
          snapshot={snapshot}
          onClose={() => setEditingSchedule(null)}
        />
      )}
    </div>
  );
}
