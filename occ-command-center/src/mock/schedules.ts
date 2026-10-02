/**
 * Schedule 外层数据（种子）
 *
 * 这里只放外围侧提供的字段：名称、规则、启用状态和世界坐标。
 *
 * 刻意**不含** `aggregated_state` 和 `child_task_count`：
 * Schedule 是自动化外围对象，不拥有自己的 Core 状态环，它的环是子 Task
 * 注意力的聚合投影（state-ring.md 第 1 节）。写死在种子数据里就等于
 * 让环可以和子 Task 的真实状态脱钩，所以这两个字段由
 * `projectLiveScheduleNodes()` 从派发记录与子 Task 派生。
 *
 * 注意：`mock/` 里另外还有一套 schedule 夹具（`scheduleFixtures()` /
 * `dispatchFixtures()`，见 snapshot.ts），`buildMockSnapshot()` 用的是那一套。
 * 本文件这组种子只服务已删除的旧投影，留待清理。
 */

export interface ScheduleSeed {
  id: string;
  label: string;
  /** 规则摘要（外围侧字段，人读） */
  rule_summary: string;
  /** 调度规则（5 段 cron；快照与自动化外围实际使用的字段） */
  cron: string;
  /** 启用状态（外围侧字段） */
  enabled: boolean;
  /** World 初始坐标 */
  x: number;
  y: number;
}

export const mockScheduleSeeds: ScheduleSeed[] = [
  {
    id: 'schedule-001',
    label: '每日数据备份',
    rule_summary: '每天凌晨 2:00 自动备份数据库',
    cron: '0 2 * * *',
    enabled: true,
    x: 1080,
    y: 150,
  },
  {
    id: 'schedule-002',
    label: '用户数据同步',
    rule_summary: '每小时从第三方 API 同步用户数据',
    cron: '0 * * * *',
    enabled: true,
    x: 1080,
    y: 350,
  },
  {
    id: 'schedule-003',
    label: '生成日报',
    rule_summary: '每天上午 9:00 生成运营日报',
    cron: '0 9 * * *',
    enabled: true,
    x: 1080,
    y: 550,
  },
  {
    id: 'schedule-004',
    label: '清理过期日志',
    rule_summary: '每周日凌晨 3:00 清理 30 天前的日志',
    cron: '0 3 * * 0',
    enabled: true,
    x: 1300,
    y: 150,
  },
  {
    id: 'schedule-005',
    label: '发送营销邮件（已停用）',
    rule_summary: '每周一上午 10:00 发送营销邮件',
    cron: '0 10 * * 1',
    enabled: false,
    x: 1300,
    y: 350,
  },
  {
    // 每天一次，已经跑了 14 次。最近几次看起来是健康的，
    // 但最早那次失败没有被确认——聚合必须反映它，不能只看当前显示的几次。
    id: 'schedule-006',
    label: '每日数据同步',
    rule_summary: '每天凌晨 02:00 同步用户与订单数据',
    cron: '0 2 * * *',
    enabled: true,
    x: 1080,
    y: 750,
  },
];
