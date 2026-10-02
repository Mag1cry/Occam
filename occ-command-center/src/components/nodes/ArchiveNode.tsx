/**
 * ArchiveNode 组件
 *
 * 外层档案馆入口。只显示档案馆印记和历史数量/摘要，
 * 不使用 Task 运行状态环，也不显示运行中命令。
 *
 * 历史 Task 不铺回 World：条目的浏览发生在 Archive ChildScene 内。
 */

import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { ArchiveNode as ArchiveNodeType } from '../../core/types/node';
import { Badge } from '../ui/Badge';
import { effectiveLOD } from '../../lib/lod';

interface ArchiveNodeComponentProps extends NodeProps {
  data: ArchiveNodeType & { zoom?: number };
}

/** 档案馆印记：档案/收敛语义，不是 Task 生命周期环 */
function ArchiveMark({ size = 44 }: { size?: number }) {
  const stroke = Math.max(2, size * 0.07);
  const r = (size - stroke) / 2;
  const c = size / 2;

  return (
    <svg width={size} height={size} aria-hidden>
      <rect
        x={stroke / 2}
        y={stroke / 2}
        width={size - stroke}
        height={size - stroke}
        rx={size * 0.12}
        fill="none"
        stroke="#64748b"
        strokeWidth={stroke}
      />
      <line
        x1={c - r * 0.5}
        y1={c - r * 0.25}
        x2={c + r * 0.5}
        y2={c - r * 0.25}
        stroke="#94a3b8"
        strokeWidth={stroke * 0.6}
        strokeLinecap="round"
      />
      <line
        x1={c - r * 0.5}
        y1={c + r * 0.15}
        x2={c + r * 0.1}
        y2={c + r * 0.15}
        stroke="#94a3b8"
        strokeWidth={stroke * 0.6}
        strokeLinecap="round"
      />
    </svg>
  );
}

export const ArchiveNode = memo(({ data, selected }: ArchiveNodeComponentProps) => {
  const zoom = data.zoom || 1;
  const lod = effectiveLOD({ zoom, selected });

  if (lod === 'far') {
    return (
      <div className="glass rounded p-2">
        <ArchiveMark size={24} />
      </div>
    );
  }

  return (
    <div
      className={`glass rounded-lg p-3 min-w-[170px] transition-smooth ${
        selected ? 'ring-2 ring-occ-unknown' : ''
      }`}
    >
      <div className="flex items-center gap-3">
        <ArchiveMark size={lod === 'mid' ? 32 : 44} />
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-gray-200 truncate">{data.label}</span>
          {lod === 'near' && data.summary && (
            <span className="text-xs text-gray-500 truncate">{data.summary}</span>
          )}
        </div>
      </div>

      {lod === 'near' && data.record_count !== undefined && (
        <div className="mt-2">
          <Badge variant="default" size="sm">
            <span className="num">{data.record_count}</span> 条归档
          </Badge>
        </div>
      )}

      <Handle type="source" position={Position.Right} className="opacity-0" />
      <Handle type="target" position={Position.Left} className="opacity-0" />
    </div>
  );
});

ArchiveNode.displayName = 'ArchiveNode';
