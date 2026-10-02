/**
 * ScheduleNode 组件
 *
 * 节点解剖（visual-system.md 第 2.2 节）：
 * 编排台名称、规则/启用摘要、子 Task 聚合印记、进入 ScheduleScene 的入口。
 * 不把派发记录画成 Core 成功状态。
 *
 * 视觉：与 Task 节点同一套表面配方（`lib/nodeSurface.ts`），
 * 但**不套 Task 的状态环**——Schedule 的环是子 Task 注意力的聚合投影
 * （state-ring.md 第 1 节），所以用聚合色点 + 聚合文字表达。
 */

import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { ScheduleNode as ScheduleNodeType } from '../../core/types/node';
import { Badge } from '../ui/Badge';
import { effectiveLOD } from '../../lib/lod';
import { scheduleAccent, scheduleStateText } from '../../lib/nodeVisual';
import { nodeSurface, dotGlow } from '../../lib/nodeSurface';
import type { AttentionLevel } from '../../core/types/state';

interface ScheduleNodeComponentProps extends NodeProps {
  data: ScheduleNodeType & {
    zoom?: number;
  };
}

/** 聚合结果 → 注意力级别；unknown/empty 不冒充任何状态 */
function aggregateAttention(state: ScheduleNodeType['aggregated_state']): AttentionLevel {
  switch (state) {
    case 'needs-decision':
      return 'needs-decision';
    case 'attention':
      return 'attention';
    case 'active':
      return 'active';
    default:
      return 'settled';
  }
}

/** 聚合结果 → 徽标语气；颜色只作辅助，文字承担主要语义 */
const AGGREGATE_BADGE: Record<
  ScheduleNodeType['aggregated_state'],
  'default' | 'info' | 'warning' | 'danger'
> = {
  'needs-decision': 'warning',
  attention: 'danger',
  active: 'info',
  settled: 'default',
  empty: 'default',
  unknown: 'default',
};

export const ScheduleNode = memo(({ data, selected }: ScheduleNodeComponentProps) => {
  const zoom = data.zoom || 1;

  // Schedule 不拥有自己的 Core 状态环：它的环是子 Task 注意力的聚合投影
  const attention = aggregateAttention(data.aggregated_state);
  const color = scheduleAccent(data.aggregated_state);

  // 选中和有注意力的 Schedule 永远提升到可读层级
  const lod = effectiveLOD({
    zoom,
    selected,
    attention: attention === 'needs-decision' || attention === 'attention',
  });

  const surface = nodeSurface(attention, { selected });

  // far: 极简标记
  if (lod === 'far') {
    return (
      <div
        className="rounded-xl p-2 flex items-center justify-center"
        style={{
          background: surface.background,
          border: `1px solid ${surface.border}`,
          boxShadow: surface.boxShadow,
        }}
      >
        <span className="text-[13px]" style={{ color }}>
          ▤
        </span>
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl p-3 transition-smooth"
      style={{
        width: surface.width,
        background: surface.background,
        border: `1px solid ${surface.border}`,
        boxShadow: surface.boxShadow,
        backdropFilter: 'blur(10px)',
      }}
    >
      {/* 头部：编排台印记 + 名称 + 聚合色点 */}
      <div className="flex items-center gap-2">
        <span
          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-[13px]"
          style={{ background: `${color}1f`, border: `1px solid ${color}55`, color }}
          aria-hidden
        >
          ▤
        </span>
        <span className="text-[13px] font-semibold text-slate-100 truncate">
          {data.label}
        </span>
        <span
          className={`ml-auto w-2 h-2 rounded-full shrink-0 ${
            attention === 'needs-decision' || attention === 'attention' ? 'pulse' : ''
          }`}
          style={{ background: color, boxShadow: dotGlow(color), color }}
        />
      </div>

      {lod === 'near' && data.rule_summary && (
        <div className="text-[11px] leading-snug text-slate-400 mt-1.5 truncate">
          {data.rule_summary}
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-white/[0.04] border border-white/10 text-slate-300">
          子任务 <span className="num text-slate-100">{data.child_task_count}</span>
        </span>
        <Badge variant={AGGREGATE_BADGE[data.aggregated_state]} size="sm">
          {scheduleStateText(data.aggregated_state)}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-white/5">
        <span className="text-[11px] text-slate-500">
          {data.enabled ? '已启用' : '已停用'}
        </span>
        <span className="text-[11px] text-slate-500">双击进入编排台</span>
      </div>

      <Handle type="source" position={Position.Right} className="opacity-0" />
      <Handle type="target" position={Position.Left} className="opacity-0" />
    </div>
  );
});

ScheduleNode.displayName = 'ScheduleNode';
