import type { GatewaySnapshot } from '../../api/gateway';
import type { ProjectionOutput } from '../types/projection';
import type { TaskNode } from '../types/node';

export interface LiveArchiveModel {
  entries: { task: TaskNode; archived_at: string | null; summary?: string }[];
  total: number;
  projection: ProjectionOutput;
}

/**
 * 档案馆里装的是**归档过的**那些
 *
 * **归档是"外面"那个动作**：一条跑完的 Task 先堆在世界里，收进档案馆才叫归档。
 * 所以判据不是"它跑完了"——跑完只说明**它可以被归档**，不说明有人收过它。
 *
 * 收进来的这些，在这个场景里只剩一个动作：**删除**（`core/task.py` 那三道门：
 * 跑完才能归档、归档才能删、删不可撤销）。
 *
 * ## Schedule 的子 Task **不进这里**（`projection-contract.md` §3）
 *
 * 它们归**编排台**管：在那儿归档、在那儿删。两个理由：
 *
 * - 一条子 Task 在编排台里还有位置（那一格、那次 occurrence），把它同时摆进
 *   档案馆就是同一个东西在两处出现——而两处都能删，删完另一处还不知道；
 * - 归谁管要有**一个**答案。判据是派发记录里的真实 ID 映射（跟
 *   `WorldProjection` 同一条：不是名字前缀之类的猜测），所以两边数的是同一批。
 *
 * 没有连线：档案馆是**并列的历史**，不是拓扑。谁和谁有关系要回到各自的场景里看。
 */
export function projectLiveArchiveScene(snapshot: GatewaySnapshot): LiveArchiveModel {
  // 派发记录里出现过的 Task 就是被某条日程物化出来的那些——它们归编排台
  const ownedTaskIds = new Set(
    (snapshot.dispatches ?? []).flatMap((dispatch) => dispatch.task_ids));
  const entries = snapshot.tasks
    .filter((task) => !ownedTaskIds.has(task.id))
    .filter((task) => Boolean(task.archived_at))
    .map((task) => ({
      task,
      archived_at: task.archived_at ?? null,
      summary: task.delegation_summary,
    }));

  const nodes = entries.map(({ task }, index) => ({
    ...task,
    x: (index % 3) * 280,
    y: Math.floor(index / 3) * 190,
  }));

  return {
    entries,
    total: entries.length,
    projection: {
      nodes,
      relations: [],
      sceneEntries: entries.map(({ task }) => ({
        nodeId: task.id, canEnter: true, targetScene: 'task' as const,
        label: '进入任务世界',
      })),
    },
  };
}
