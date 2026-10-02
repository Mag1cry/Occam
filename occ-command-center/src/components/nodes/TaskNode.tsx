/**
 * TaskNode 组件
 *
 * 节点解剖（visual-system.md 第 2.1 节）：
 * World 层只保留状态环、短标题、状态文字/注意力印记和可选持续时间；
 * 选中才展开委托摘要等细节。
 *
 * 表面按 occ-web 的配方派生（`lib/nodeSurface.ts`）：
 * 状态色淡渐变 + 内高光 + 柔和投影，需要响应的节点加同色外发光，
 * 宽度也随注意力变化。颜色只作辅助，形状与文字承担语义。
 */

import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { TaskNode as TaskNodeType } from '../../core/types/node';
import { StateRing } from './StateRing';
import { Badge } from '../ui/Badge';
import { deriveStateRing } from '../../lib/stateRing';
import { effectiveLOD } from '../../lib/lod';
import { nodeSurface, dotGlow } from '../../lib/nodeSurface';
import { formatDurationSec } from '../../lib/format';

interface TaskNodeComponentProps extends NodeProps {
  data: TaskNodeType & {
    zoom?: number;
  };
}

/** 注意力印记：文字承担语义，不靠颜色 */
const ATTENTION_BADGE = {
  'needs-decision': { text: '待拍板', variant: 'warning' as const },
  attention: { text: '需关注', variant: 'danger' as const },
} as const;

export const TaskNode = memo(({ data, selected }: TaskNodeComponentProps) => {
  const zoom = data.zoom || 1;

  // 派生状态环
  const stateRing = deriveStateRing({
    status: data.status,
    pending_decision: !!data.pending_decision,
    approval_state: data.approval_state,
    acknowledged_failure: data.acknowledged_failure,
  });

  // 页脚时长：紧凑写法，页脚宽度只够这个长度（见下面的注释）
  const durationText = formatDurationSec(data.duration);

  // 选中和待拍板节点永远提升到可读层级
  const lod = effectiveLOD({
    zoom,
    selected,
    attention:
      stateRing.attentionLevel === 'needs-decision' ||
      stateRing.attentionLevel === 'attention',
  });

  const surface = nodeSurface(stateRing.attentionLevel, { selected });
  const badge = ATTENTION_BADGE[stateRing.attentionLevel as 'needs-decision' | 'attention'];

  // far: 只留状态环（空间锚点）
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
        <StateRing shape={stateRing.shape} color={stateRing.color} size={24} />
      </div>
    );
  }

  // mid: 状态环 + 短标题 + 状态文字
  if (lod === 'mid') {
    return (
      <div
        className="rounded-2xl px-3 py-2.5 transition-smooth"
        style={{
          width: surface.width,
          background: surface.background,
          border: `1px solid ${surface.border}`,
          boxShadow: surface.boxShadow,
          backdropFilter: 'blur(10px)',
        }}
      >
        <div className="flex items-center gap-2">
          <StateRing shape={stateRing.shape} color={stateRing.color} size={22} />
          <span className="text-[13px] font-semibold text-slate-100 truncate">
            {data.label}
          </span>
          {badge && (
            <span className="ml-auto shrink-0 text-[11px] px-1.5 py-0.5 rounded-full border border-white/10 bg-white/[0.04] text-slate-300">
              {badge.text}
            </span>
          )}
        </div>
        <Handle type="source" position={Position.Right} className="opacity-0" />
        <Handle type="target" position={Position.Left} className="opacity-0" />
      </div>
    );
  }

  // near: 完整信息（选中或高密度）
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
      {/* 头部：状态环 + 名称 + 发光状态点（occ-web 的节点读法） */}
      <div className="flex items-center gap-2">
        <StateRing shape={stateRing.shape} color={stateRing.color} size={26} />
        <span className="text-[13px] font-semibold text-slate-100 truncate">
          {data.label}
        </span>
        <span
          className={`ml-auto w-2 h-2 rounded-full shrink-0 ${
            stateRing.attentionLevel === 'needs-decision' ||
            stateRing.attentionLevel === 'attention'
              ? 'pulse'
              : ''
          }`}
          style={{
            background: stateRing.color,
            boxShadow: dotGlow(stateRing.color),
            color: stateRing.color,
          }}
        />
      </div>

      {data.delegation_summary && (
        <div className="text-[11px] leading-snug text-slate-400 mt-1.5 line-clamp-2">
          {data.delegation_summary}
        </div>
      )}

      {/* 徽标行：注意力印记与真实引用 */}
      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        {badge && (
          <Badge variant={badge.variant} size="sm">
            {badge.text}
          </Badge>
        )}
        {data.pending_tool_id && (
          <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-white/[0.04] border border-white/10 text-slate-300">
            等待 <span className="num text-occ-warn">{data.pending_tool_id}</span>
          </span>
        )}
        {/* 归档时间只来自显式元数据；缺失就不显示 */}
        {data.archived_at && (
          <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-white/[0.04] border border-white/10 text-slate-400">
            归档于 <span className="num">{new Date(data.archived_at).toLocaleDateString()}</span>
          </span>
        )}
      </div>

      {/*
        页脚：持续时间 + 状态文字（状态文字着色，其它保持中性）

        宽度是算过的：内容盒 154px，最长状态文字「失败（已确认）」占 77px，
        减去 8px 间距只剩 69px 给时长。`持续时间 20m 0s` 要 83px——放不下就
        从中间断成「持续时间 20m / 0s」两行。改用 occ-web 的紧凑写法
        （`20min`，零秒不显示，见 lib/format.ts）后是 66px，一行放得下。
        `flex-wrap` 是兜底：真遇到「1h 15min + 失败（已确认）」这种组合时
        整段换行，而不是把字符串从中间劈开。
      */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 mt-2 pt-1.5 border-t border-white/5">
        <span className="text-[11px] text-slate-500 num whitespace-nowrap">
          {durationText ? `已持续 ${durationText}` : '—'}
        </span>
        <span
          className="text-[11px] shrink-0 ml-auto"
          style={{ color: stateRing.color }}
        >
          {stateRing.label}
        </span>
      </div>

      <Handle type="source" position={Position.Right} className="opacity-0" />
      <Handle type="target" position={Position.Left} className="opacity-0" />
    </div>
  );
});

TaskNode.displayName = 'TaskNode';
