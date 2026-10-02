/**
 * Core Task 全集
 *
 * 真实世界里的 Core Task 只有一个来源：Core。
 * 外层 Task 与 Schedule 子 Task 的差别是**谁创建了它**，不是它是什么：
 * `world-model.md` 第 3 节明确「外围每次 occurrence 仍创建独立 Core Task」，
 * 且「Schedule 不拥有自己的 Core Event Chain 或 Task 生命周期」。
 *
 * 所以「按 ID 找一个 Task」必须跨这两份 mock 查找。只查外层数组，
 * 会让 Schedule 子 Task 打开后变成「对象不可用」——那不是设计边界，
 * 而是数据源拆错了。
 */

import type { TaskNode } from '../core/types/node';
import { mockTasks } from './tasks';
import { mockScheduleChildTasks } from './scheduleChildren';

/** 全部 Core Task：外层 Task + Schedule 子 Task */
export const allCoreTasks: TaskNode[] = [...mockTasks, ...mockScheduleChildTasks];

const taskById = new Map(allCoreTasks.map((task) => [task.id, task]));

/**
 * 按 ID 查 Core Task
 *
 * 找不到时返回 null：调用方必须显示「对象不可用」，不伪造替代对象。
 */
export function findCoreTask(taskId: string): TaskNode | null {
  return taskById.get(taskId) ?? null;
}
