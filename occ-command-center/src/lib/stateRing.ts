/**
 * 状态环派生逻辑
 *
 * 根据 Task 状态计算状态环的形状、颜色和注意力级别
 */

import type {
  StateRingInput,
  StateRingOutput,
  StateRingShape,
} from '../core/types/state';

/**
 * 派生状态环输出
 */
export function deriveStateRing(input: StateRingInput): StateRingOutput {
  const { status, approval_state, acknowledged_failure } = input;

  // created: 已创建、尚未启动 Worker
  if (status === 'created') {
    return {
      shape: 'closed',
      color: '#64748b', // occ-unknown
      label: '已创建，尚未启动',
      attentionLevel: 'active',
    };
  }

  // running: 正常运行中
  if (status === 'running') {
    return {
      shape: 'closed',
      color: '#2dd4a7', // occ-accent：活着的
      label: '运行中',
      attentionLevel: 'active',
    };
  }

  // paused: 暂停状态，根据审批状态决定注意力级别
  if (status === 'paused') {
    if (approval_state === 'pending') {
      // 等待拍板：响铃
      return {
        shape: 'gap',
        color: '#ffb020', // occ-warn
        label: '等待拍板',
        attentionLevel: 'needs-decision',
      };
    } else if (approval_state === 'approved') {
      // 已批准，等待恢复：记账
      return {
        shape: 'gap',
        color: '#14b98d', // occ-accent-dark：已记账
        label: '已批准',
        attentionLevel: 'active',
      };
    } else if (approval_state === 'denied') {
      // 已拒绝，需要改方案：亮灯
      return {
        shape: 'gap',
        color: '#ff5470', // occ-crit
        label: '已拒绝',
        attentionLevel: 'attention',
      };
    } else {
      // 普通暂停：记账
      return {
        shape: 'gap',
        color: '#64748b', // occ-unknown
        label: '已暂停',
        attentionLevel: 'active',
      };
    }
  }

  // failed: 失败状态，根据确认状态决定注意力级别
  if (status === 'failed') {
    if (acknowledged_failure) {
      // 已确认失败：已完结
      return {
        shape: 'broken',
        color: '#d93a55', // occ-crit-dark：失败已确认仍是失败，只是退后
        label: '失败（已确认）',
        attentionLevel: 'settled',
      };
    } else {
      // 未确认失败：亮灯
      return {
        shape: 'broken',
        color: '#ff5470', // occ-crit
        label: '失败（待确认）',
        attentionLevel: 'attention',
      };
    }
  }

  // succeeded: 成功完成
  if (status === 'succeeded') {
    return {
      shape: 'closed',
      color: '#14b98d', // occ-accent-dark：已收敛
      label: '已完成',
      attentionLevel: 'settled',
    };
  }

  // cancelled: 已取消
  if (status === 'cancelled') {
    return {
      shape: 'collapsed',
      color: '#64748b', // occ-unknown
      label: '已取消',
      attentionLevel: 'settled',
    };
  }

  // 默认（不应该到达这里）
  return {
    shape: 'closed',
    color: '#64748b',
    label: '未知',
    attentionLevel: 'active',
  };
}

/**
 * 判断状态环形状（用于 CSS 类）
 */
export function getStateRingShape(status: StateRingInput['status']): StateRingShape {
  switch (status) {
    case 'created':
    case 'running':
    case 'succeeded':
      return 'closed';
    case 'paused':
      return 'gap';
    case 'failed':
      return 'broken';
    case 'cancelled':
      return 'collapsed';
    default:
      return 'closed';
  }
}
