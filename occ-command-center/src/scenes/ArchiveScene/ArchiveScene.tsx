/**
 * ArchiveScene
 *
 * 档案馆局部世界。展开的是「非 Schedule 的终态 Core Task」本身：
 *   Archive → 非 Schedule Task → ControlEvent / Result / 诊断
 *
 * 硬边界：
 * - Schedule 子 Task 即使已经完成、取消或失败，也不能在这里重复出现；
 * - 事件、结果和诊断是时间序列组件，按设计不变成空间图节点，
 *   因此本场景没有连线：Task 之间、Task 与归档元数据之间都没有关系；
 * - 不另造归档条目节点——那会把同一个对象画两遍，而且 Archive → Task
 *   不在设计的合法关系里。
 */

import { useCallback, useMemo, useState } from 'react';
import { SpatialCanvas } from '../../core/scene/SpatialCanvas';
import { useSelectionStore } from '../../store/selectionStore';
import { useFocusLeap } from '../../hooks/useFocusLeap';
import { nodeAccent, nodeStateText } from '../../lib/nodeVisual';
import { CommandSurface } from '../../components/overlay/CommandSurface';
import { TaskResultOverlay } from '../../components/overlay/TaskResultOverlay';
import { SceneOverlayStack, SceneFacts } from '../../components/overlay/SceneOverview';
import { buildNodeCommands } from '../../lib/commandMatrix';
import { TaskNode } from '../../components/nodes/TaskNode';
import { projectLiveArchiveScene } from '../../core/projection/LiveArchiveProjection';
import { executeTaskCommand } from '../../lib/objectCommands';
import { useGatewayStore } from '../../store/gatewayStore';
import type { GatewaySnapshot } from '../../api/gateway';

/** 档案馆的内容是历史 Task 本身，没有资料节点 */
const nodeTypes = { task: TaskNode };

type FilterKey = 'all' | 'succeeded' | 'failed' | 'cancelled';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'succeeded', label: '已完成' },
  { key: 'failed', label: '失败' },
  { key: 'cancelled', label: '已取消' },
];

export interface ArchiveSceneProps {
  /** 后端网关快照：由 SceneRenderer 保证存在，场景自己不兜底 */
  snapshot: GatewaySnapshot;
}

export function ArchiveScene({ snapshot }: ArchiveSceneProps) {
  const { selectedNodeId, setSelected, toggleSelected } = useSelectionStore();
  const { enterScene, isFlying } = useFocusLeap();
  const load = useGatewayStore((state) => state.load);
  const [filter, setFilter] = useState<FilterKey>('all');
  /** 正在看结果的 Task id（`null` 表示没有那个浮窗） */
  const [viewingResultFor, setViewingResultFor] = useState<string | null>(null);

  const model = useMemo(() => projectLiveArchiveScene(snapshot), [snapshot]);

  /** 馆里**存在**哪些（不管当前筛选画不画它们）：布局表按这个留格子 */
  const archivedIds = useMemo(
    () => new Set(model.entries.map((entry) => entry.task.id)),
    [model.entries]);

  // 筛选只改变显示，不改变投影事实
  const nodes = useMemo(() => {
    if (filter === 'all') return model.projection.nodes;
    return model.projection.nodes.filter(
      (node) => node.type === 'task' && node.status === filter
    );
  }, [model.projection.nodes, filter]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  // 可进入的节点由投影声明；筛选只改变显示，不改变入口
  const sceneEntries = model.projection.sceneEntries;
  const selectedEntry = sceneEntries.find((entry) => entry.nodeId === selectedNodeId);

  // 「历史 Task 默认折叠，选中后再进入 Task 局部世界」
  const handleNodeDoubleClick = useCallback(
    (nodeId: string) => {
      const entry = sceneEntries.find((e) => e.nodeId === nodeId);
      if (!entry?.canEnter || !entry.targetScene) return;

      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

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
        sceneId="archive"
        nodes={nodes}
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
        /*
          **筛掉的不是"没了"。** 切筛选只改这一屏画什么，那些 Task 都还在——
          所以"存在哪些"要按**全部条目**给，否则切回"全部"时它们的位置已经被
          清掉，节点会跳回投影算出来的地方。
        */
        known={archivedIds}
      />

      {/* 概览 + 历史筛选：贴在左上角返回锚点下方；顶部中央留给 HUD */}
      <SceneOverlayStack>
        <SceneFacts
          title="档案馆"
          facts={[
            { label: '条目', value: `${model.total} 条` },
            // **装的是归档过的**，不是"所有跑完的"：跑完只说明它可以被归档
            { label: '范围', value: '归档过的 Task：在这儿只剩「删除」' },
          ]}
        >
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                className={`px-2 py-1 rounded text-[11px] transition-smooth ${
                  filter === item.key
                    ? 'bg-occ-accent/15 text-occ-accent-light border border-occ-accent/40'
                    : 'text-gray-400 hover:bg-white/5 border border-transparent'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </SceneFacts>
      </SceneOverlayStack>

      {selectedNode && !isFlying && (
        <CommandSurface
          targetLabel={selectedNode.label}
          model={buildNodeCommands(selectedNode, {
            canEnter: Boolean(selectedEntry?.canEnter),
            enterLabel: selectedEntry?.label ?? '进入任务世界',
            // 馆里只给**删除**：收录入馆是"外面"那个动作（世界 / 任务详情里给「归档」），
            // 在这儿再给一次没有意义——进来的都已经归档过了
            historyAction: 'forget',
          })}
          onEnterScene={() => handleNodeDoubleClick(selectedNode.id)}
          onExecute={async (command) => {
            const outcome = await executeTaskCommand(command, selectedNode.id);
            // 提交成功只表示命令被接受了：真实状态以重读为准（归档那一格也一样）
            if (outcome.submitted && outcome.ok) void load();
            return outcome;
          }}
          // 只读命令没有后端命令，走 `onExecute` 会静默返回（见 `onView` 的说明）。
          // 这里只接「查看结果」；「查看事件 / 查看取消记录」还没接，是已知的。
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
