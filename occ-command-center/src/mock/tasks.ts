/**
 * Task Mock 数据
 *
 * 覆盖所有状态矩阵的 Task 示例
 */

import type { TaskNode } from '../core/types/node';

/**
 * Task Mock 数据
 */
export const mockTasks: TaskNode[] = [
  // 1. running: 正常运行中
  {
    id: 'task-001',
    type: 'task',
    label: '分析用户反馈数据',
    x: 200,
    y: 150,
    status: 'running',
    delegation_summary: '使用 data-analysis 工具处理最近 30 天的用户反馈',
    duration: 3600,
    executor_config_id: 'config-001',
  },

  // 2. paused + pending: 等待拍板
  {
    id: 'task-002',
    type: 'task',
    label: '部署生产环境',
    x: 420,
    y: 150,
    status: 'paused',
    approval_state: 'pending',
    pending_decision: {
      decision_id: 'decision-001',
      description: '需要批准部署到生产环境',
      created_at: '2025-01-26T10:30:00Z',
    },
    delegation_summary: '将新版本部署到生产环境',
    duration: 1800,
    executor_config_id: 'config-002',
  },

  // 3. paused + approved: 已批准，等待恢复
  {
    id: 'task-003',
    type: 'task',
    label: '发送通知邮件',
    x: 640,
    y: 150,
    status: 'paused',
    approval_state: 'approved',
    delegation_summary: '向所有用户发送更新通知',
    duration: 900,
    executor_config_id: 'config-001',
  },

  // 4. paused + denied: 已拒绝，需要改方案
  {
    id: 'task-004',
    type: 'task',
    label: '删除旧数据',
    x: 860,
    y: 150,
    status: 'paused',
    approval_state: 'denied',
    delegation_summary: '删除 2024 年之前的所有日志数据',
    duration: 600,
    executor_config_id: 'config-003',
  },

  // 5. failed + !acknowledged: 失败未确认
  {
    id: 'task-005',
    type: 'task',
    label: '备份数据库',
    x: 200,
    y: 350,
    status: 'failed',
    acknowledged_failure: false,
    delegation_summary: '创建生产数据库的完整备份',
    duration: 7200,
    executor_config_id: 'config-004',
  },

  // 6. failed + acknowledged: 失败已确认
  {
    id: 'task-006',
    type: 'task',
    label: '同步第三方数据',
    x: 420,
    y: 350,
    status: 'failed',
    acknowledged_failure: true,
    delegation_summary: '从外部 API 同步用户数据',
    duration: 1200,
    executor_config_id: 'config-001',
  },

  // 7. succeeded: 成功完成
  {
    id: 'task-007',
    type: 'task',
    label: '生成报告',
    x: 640,
    y: 350,
    status: 'succeeded',
    acknowledged_success: true,
    delegation_summary: '生成月度运营报告',
    duration: 4500,
    executor_config_id: 'config-002',
    // **归档过的才在档案馆里**：跑完只是"它可以被归档"，收进去才是归档
    archived_at: '2026-09-20T09:30:00Z',
  },

  // 8. cancelled: 已取消
  {
    id: 'task-008',
    type: 'task',
    label: '清理临时文件',
    x: 860,
    y: 350,
    status: 'cancelled',
    delegation_summary: '清理所有临时文件和缓存',
    duration: 300,
    executor_config_id: 'config-003',
    archived_at: '2026-09-21T16:05:00Z',
  },

  // 9. running + pending_tool: 等待工具响应
  {
    id: 'task-009',
    type: 'task',
    label: '调用支付接口',
    x: 200,
    y: 550,
    status: 'running',
    pending_tool_id: 'payment-gateway',
    delegation_summary: '处理用户支付请求',
    duration: 600,
    executor_config_id: 'config-005',
  },

  // 10. paused: 普通暂停（无审批状态）
  {
    id: 'task-010',
    type: 'task',
    label: '等待外部依赖',
    x: 420,
    y: 550,
    status: 'paused',
    delegation_summary: '等待第三方服务恢复',
    duration: 1500,
    executor_config_id: 'config-001',
  },
];
