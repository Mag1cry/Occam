/**
 * ConfigurationNode 组件
 *
 * 外层配置舱入口。只显示配置舱印记、配置摘要和诊断印记，
 * 不使用 Task 的 Core Event Log 或 Agent Audit 作为主视觉，
 * 也不把配置显示成可执行单位。
 *
 * Executor Configuration、Extension、Capability 是子场景资料，
 * 不在外层出现——它们由 ResourceNode 渲染。
 */

import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { ConfigurationNode as ConfigurationNodeType } from '../../core/types/node';
import { Badge } from '../ui/Badge';
import { effectiveLOD } from '../../lib/lod';

interface ConfigurationNodeComponentProps extends NodeProps {
  data: ConfigurationNodeType & { zoom?: number };
}

/** 配置舱印记：配置/诊断语义，不是 Task 生命周期环 */
function ConfigurationMark({ size = 44 }: { size?: number }) {
  const stroke = Math.max(2, size * 0.07);
  const c = size / 2;
  const r = (size - stroke) / 2;

  return (
    <svg width={size} height={size} aria-hidden>
      <rect
        x={stroke / 2}
        y={stroke / 2}
        width={size - stroke}
        height={size - stroke}
        rx={size * 0.2}
        fill="none"
        stroke="#2dd4a7"
        strokeWidth={stroke}
      />
      {/* 配置刻度盘印记 */}
      <circle
        cx={c}
        cy={c}
        r={r * 0.28}
        fill="none"
        stroke="#2dd4a7"
        strokeWidth={stroke * 0.6}
      />
      <line
        x1={c}
        y1={stroke * 1.6}
        x2={c}
        y2={c - r * 0.28}
        stroke="#2dd4a7"
        strokeWidth={stroke * 0.6}
        strokeLinecap="round"
      />
      <line
        x1={c}
        y1={c + r * 0.28}
        x2={c}
        y2={size - stroke * 1.6}
        stroke="#2dd4a7"
        strokeWidth={stroke * 0.6}
        strokeLinecap="round"
      />
    </svg>
  );
}

export const ConfigurationNode = memo(
  ({ data, selected }: ConfigurationNodeComponentProps) => {
    const zoom = data.zoom || 1;
    const lod = effectiveLOD({ zoom, selected });

    if (lod === 'far') {
      return (
        <div className="glass rounded p-2">
          <ConfigurationMark size={24} />
        </div>
      );
    }

    return (
      <div
        className={`glass rounded-lg p-3 min-w-[170px] transition-smooth ${
          selected ? 'ring-2 ring-occ-accent' : ''
        }`}
      >
        <div className="flex items-center gap-3">
          <ConfigurationMark size={lod === 'mid' ? 32 : 44} />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-medium text-gray-200 truncate">{data.label}</span>
            {lod === 'near' && data.summary && (
              <span className="text-xs text-gray-500 truncate">{data.summary}</span>
            )}
          </div>
        </div>

        {lod === 'near' && data.diagnostics_ok !== undefined && (
          <div className="mt-2">
            <Badge variant={data.diagnostics_ok ? 'default' : 'warning'} size="sm">
              诊断：{data.diagnostics_ok ? '正常' : '需检查'}
            </Badge>
          </div>
        )}

        <Handle type="source" position={Position.Right} className="opacity-0" />
        <Handle type="target" position={Position.Left} className="opacity-0" />
      </div>
    );
  }
);

ConfigurationNode.displayName = 'ConfigurationNode';
