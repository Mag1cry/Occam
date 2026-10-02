/**
 * Archive Mock 数据
 *
 * 档案馆的内容就是「非 Schedule 的终态 Core Task」本身，不是另造一层条目：
 * 设计里 Archive ChildScene 投影的是「非 Schedule Task 的历史、结果、事件和诊断」，
 * 「历史 Task 默认折叠，选中后再进入 Task 局部世界」——可选中、可进入的对象是 Task。
 *
 * 归档元数据（归档时间、摘要）通过显式 task_id 关联到 Core Task。
 * 不做按名称、时间或数组位置的猜测绑定。
 */

export interface ArchiveMetadata {
  /** 对应的 Core Task；必须显式给出 */
  task_id: string;
  /** 归档时间 */
  archived_at: string;
  /** 归档摘要（字段存在时显示） */
  summary?: string;
}

/**
 * 归档元数据
 *
 * 只描述已经收敛的非 Schedule Task；没有对应 Core Task 的条目不应存在，
 * 也不该被推测地绑定到某个 Task 上。
 */
export const mockArchiveMetadata: ArchiveMetadata[] = [
  {
    task_id: 'task-007',
    archived_at: '2025-01-15T18:30:00Z',
    summary: '月度运营报告已生成并归档',
  },
  {
    task_id: 'task-006',
    archived_at: '2025-01-18T14:00:00Z',
    summary: '第三方同步失败，用户已确认处理',
  },
  {
    task_id: 'task-008',
    archived_at: '2025-01-22T10:00:00Z',
    summary: '用户主动取消，非失败',
  },
];
