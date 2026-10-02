/**
 * WorldScene
 *
 * 外层世界：自由空间拓扑，不是上下分层清单。
 * 节点位置由用户拖动决定，不表达优先级、状态或时间顺序；
 * 节点可以没有连线，只有真实关系才画线。
 */

import { useCallback, useMemo, useState } from 'react';
import { SpatialCanvas } from '../../core/scene/SpatialCanvas';
import { projectWorldScene } from '../../core/projection/WorldProjection';
import { useSelectionStore } from '../../store/selectionStore';
import { useFocusLeap } from '../../hooks/useFocusLeap';
import { nodeAccent, nodeStateText } from '../../lib/nodeVisual';
import { WorldContextMenu } from '../../components/overlay/WorldContextMenu';
import { CommandSurface } from '../../components/overlay/CommandSurface';
import { TaskResultOverlay } from '../../components/overlay/TaskResultOverlay';
import { buildNodeCommands } from '../../lib/commandMatrix';
import { NewTaskOverlay } from '../../components/overlay/NewTaskOverlay';
import { TaskNode } from '../../components/nodes/TaskNode';
import { ScheduleNode } from '../../components/nodes/ScheduleNode';
import { ArchiveNode } from '../../components/nodes/ArchiveNode';
import { ConfigurationNode } from '../../components/nodes/ConfigurationNode';
import { workerAliveOf, workerUnreconciledOf,
         type GatewaySchedule, type GatewaySnapshot } from '../../api/gateway';
import { ScheduleEditorOverlay } from '../../components/overlay/ScheduleEditorOverlay';
import { executeScheduleCommand, executeTaskCommand } from '../../lib/objectCommands';
import { useGatewayStore } from '../../store/gatewayStore';

const nodeTypes = {
  task: TaskNode,
  schedule: ScheduleNode,
  archive: ArchiveNode,
  configuration: ConfigurationNode,
};

export interface WorldSceneProps {
  /** 后端网关快照：由 SceneRenderer 保证存在，场景自己不兜底 */
  snapshot: GatewaySnapshot;
}

export function WorldScene({ snapshot }: WorldSceneProps) {
  const { selectedNodeId, setSelected, toggleSelected } = useSelectionStore();
  const { enterScene, isFlying } = useFocusLeap();

  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [creatingSchedule, setCreatingSchedule] = useState(false);
  /** 正在编辑的那条日程（`null` 表示没有那个表单）——新建走 `creatingSchedule` */
  const [editingSchedule, setEditingSchedule] = useState<GatewaySchedule | null>(null);
  /** 正在看结果的 Task id（`null` 表示没有那个浮窗） */
  const [viewingResultFor, setViewingResultFor] = useState<string | null>(null);

  const load = useGatewayStore((state) => state.load);
  const projection = useMemo(
    () => projectWorldScene({
      tasks: snapshot.tasks,
      schedules: snapshot.schedules ?? [],
      dispatches: snapshot.dispatches ?? [],
    }),
    [snapshot]
  );
  // 节点只来自快照：没有本地草稿，也没有前端预置的 Task
  const nodes = projection.nodes;

  // 节点是否可展开由投影返回的 SceneEntry 决定，SceneRenderer 不写死业务类型
  const sceneEntries = projection.sceneEntries;

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );

  const handleNodeDoubleClick = useCallback(
    (nodeId: string) => {
      const entry = sceneEntries.find((e) => e.nodeId === nodeId);
      if (!entry?.canEnter || !entry.targetScene) return;

      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      // Focus Leap 只改变 UI Scene State，不修改外层节点坐标和业务数据
      enterScene({
        nodeId,
        targetScene: entry.targetScene,
        label: node.label,
        color: nodeAccent(node),
        stateText: nodeStateText(node),
      });
    },
    [sceneEntries, nodes, enterScene]
  );

  return (
    <div className="relative w-full h-full">
      <SpatialCanvas
        sceneId="world"
        nodes={nodes}
        relations={projection.relations}
        nodeTypes={nodeTypes}
        selectedNodeId={selectedNodeId}
        interactive={!isFlying}
        onNodeClick={toggleSelected}
        onSelectionRestore={setSelected}
        onNodeDoubleClick={handleNodeDoubleClick}
        onPaneClick={() => setSelected(null)}
        onPaneContextMenu={(position) => setMenuPosition(position)}
        onNodeLongPress={setSelected}
      />

      {/* 空白处长按或桌面右键打开的 World Context Menu */}
      {menuPosition && (
        <WorldContextMenu
          position={menuPosition}
          onClose={() => setMenuPosition(null)}
          onNewTask={() => {
            setMenuPosition(null);
            setCreatingTask(true);
          }}
          onNewSchedule={() => {
            setMenuPosition(null);
            setCreatingSchedule(true);
          }}
        />
      )}

      {/* 新建任务：只有真实 Core 命令提交后才产生 Task 节点 */}
      {creatingTask && (
        <NewTaskOverlay
          initialPosition={menuPosition ?? { x: 400, y: 300 }}
          snapshot={snapshot}
          onClose={() => setCreatingTask(false)}
        />
      )}

      {/*
        新建日程 = **写一个文件**（`extensions/_schedules/<name>.yaml`）。
        日程一条就是一个文件，所以走的是声明那两条命令里的"新建"——
        新节点由重读的快照产生，前端不预置任何东西。

        表单本身在 `ScheduleEditorOverlay` 里（**编辑用的是同一张**，只是没有
        「日程 ID」那一格）：两处各写一遍字段，迟早会有一处漏掉必填项。
      */}
      {creatingSchedule && (
        <ScheduleEditorOverlay
          schedule={null}
          snapshot={snapshot}
          onClose={() => setCreatingSchedule(false)}
        />
      )}

      {/* 改一条已有的日程：同一张表单，预填它现在的那几行 */}
      {editingSchedule && (
        <ScheduleEditorOverlay
          schedule={editingSchedule}
          snapshot={snapshot}
          onClose={() => setEditingSchedule(null)}
        />
      )}

      {/* 选中节点后才出现上下文操作牌，普通节点不常驻按钮列 */}
      {selectedNode && !isFlying && (
        <CommandSurface
          targetLabel={selectedNode.label}
          model={buildNodeCommands(selectedNode, {
            canEnter: Boolean(
              sceneEntries.find((e) => e.nodeId === selectedNode.id && e.canEnter)
            ),
            enterLabel:
              sceneEntries.find((e) => e.nodeId === selectedNode.id)?.label ??
              '进入局部场景',
            workerAlive:
              selectedNode.type === 'task'
                ? workerAliveOf(snapshot, selectedNode.id)
                : undefined,
            workerUnreconciled:
              selectedNode.type === 'task'
                ? workerUnreconciledOf(snapshot, selectedNode.id)
                : undefined,
            // 跑完的 Task 堆在这儿，**归档是"外面"的动作**——收进档案馆之后
            // 才轮到「删除」，那一步在馆里
            historyAction: 'archive',
          })}
          onEnterScene={() => handleNodeDoubleClick(selectedNode.id)}
          stateVersion={
            selectedNode.type === 'task' && selectedNode.state_version !== undefined
              ? `state-${selectedNode.state_version}`
              : undefined
          }
          onExecute={async (command) => {
            /*
              **编辑日程不是一条后端命令**：它打开那张表单，由表单去写声明。
              所以这里返回 `submitted: false`——牌面上不出回执，回执等真正提交之后。
            */
            if (command.id === 'edit-schedule') {
              const schedule = (snapshot.schedules ?? [])
                .find((item) => item.schedule_id === selectedNode.id);
              // 快照里没有它就不打开：对着一个不存在的东西弹出空表单是在承诺一件没有的事
              if (schedule) setEditingSchedule(schedule);
              return { submitted: false } as const;
            }
            /*
              日程那三条（触发 / 删除 / 启停）走**和编排台同一条**路。
              以前这里把它们交给了 Task 那条链，于是牌面看着能点、按下去什么都不发生
              （同 R-009 那次返工：改了内部不改外部）。
            */
            if (selectedNode.type === 'schedule') {
              const outcome = await executeScheduleCommand(
                command,
                { scheduleId: selectedNode.id, enabled: selectedNode.enabled },
                snapshot.declarations ?? []
              );
              if (outcome.submitted && outcome.ok) void load();
              return outcome;
            }
            const outcome = await executeTaskCommand(
              command,
              selectedNode.type === 'task' ? selectedNode.id : ''
            );
            // 提交成功只表示 Core 已接收：真实状态以重读的对象与事件为准
            if (outcome.submitted && outcome.ok) void load();
            return outcome;
          }}
          // 只读命令没有后端命令，落到 `onExecute` 会静默返回（见 `onView` 的说明）。
          // 这里只接「查看结果」——**其余几条只读命令（查看事件…）还没接**，
          // 它们要的是切 tab 或跳别处，和浮窗不是一回事。这是已知的，不是漏掉。
          onView={(command) => {
            if (command.id === 'view-result') setViewingResultFor(selectedNode.id);
          }}
        />
      )}

      {viewingResultFor && (
        <TaskResultOverlay
          taskId={viewingResultFor}
          onClose={() => setViewingResultFor(null)}
        />
      )}
    </div>
  );
}
