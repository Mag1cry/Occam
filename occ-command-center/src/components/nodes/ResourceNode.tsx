/**
 * ResourceNode 组件
 *
 * 子场景资料节点：Executor Configuration、Extension、Capability、
 * Schedule Entry、Task Definition、occurrence。
 *
 * 档案馆不使用资料节点：它的内容是「非 Schedule 的终态 Core Task」本身，
 * 由 TaskNode 渲染，不另造一层归档条目节点。
 *
 * 它们不是外层第五类节点，只在父场景的 ChildScene 中出现。
 *
 * 视觉边界：
 * - 不使用 Task 的 Core 生命周期状态环；
 * - 不显示百分比或推测值；
 * - 派发状态只表示派发，不表示执行成功；
 * - 字段缺失时不显示，不补造。
 */

import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { ResourceNode as ResourceNodeType, ResourceKind } from '../../core/types/node';
import { Badge } from '../ui/Badge';
import { ReferencePlaceholder } from '../ui/ReferencePlaceholder';
import { effectiveLOD } from '../../lib/lod';
import { configColumns } from '../../lib/nodeVisual';

interface ResourceNodeComponentProps extends NodeProps {
  data: ResourceNodeType & { zoom?: number };
}

/** 资料类别的印记语义与强调色 */
const KIND_META: Record<ResourceKind, { label: string; color: string; glyph: string }> = {
  'executor-config': { label: 'Executor', color: '#94a3b8', glyph: '◆' },
  // 供应商和它名下的配置同色：区别靠几何印记，不靠颜色
  'executor-provider': { label: 'Provider', color: '#94a3b8', glyph: '⬢' },
  extension: { label: 'Extension', color: '#94a3b8', glyph: '⬡' },
  capability: { label: 'Capability', color: '#94a3b8', glyph: '✦' },
  // 智能体是对象坐标里的中间那级，用与资源同一族的浅色但换一个几何印记
  agent: { label: 'Agent', color: '#ffb020', glyph: '◈' },
  'schedule-entry': { label: 'Entry', color: '#94a3b8', glyph: '▤' },
  'task-definition': { label: 'Definition', color: '#64748b', glyph: '❖' },
  occurrence: { label: 'Occurrence', color: '#64748b', glyph: '◷' },
};

/**
 * 一级节点里装的是什么
 *
 * 同一个 `child_count` 对不同类别读作不同东西：供应商里是配置，扩展里是能力。
 * 没有这一格的类别就不显示计数。
 */
const CHILD_UNIT: Partial<Record<ResourceKind, string>> = {
  // 供应商那一格报的是**它的模型目录**——那才是打开它要看的东西
  'executor-provider': ' 个模型',
  extension: ' 项声明',
};

/** 派发状态文案：只表示派发，不表示执行成功 */
const DISPATCH_TEXT = {
  dispatched: '已派发',
  'not-dispatched': '未派发',
  // 后端明确说了失败，就不能渲染成「未知」——那是把它给的结论丢掉
  failed: '派发失败',
  unknown: '派发状态未知',
} as const;

/** 资料印记：几何形状区分类别，不依赖颜色 */
function ResourceMark({ kind, size = 24 }: { kind: ResourceKind; size?: number }) {
  const meta = KIND_META[kind];
  return (
    <span
      className="flex items-center justify-center rounded shrink-0"
      style={{
        width: size,
        height: size,
        background: `${meta.color}1f`,
        border: `1px solid ${meta.color}55`,
        color: meta.color,
        fontSize: size * 0.6,
        lineHeight: 1,
      }}
      aria-hidden
    >
      {meta.glyph}
    </span>
  );
}

export const ResourceNode = memo(({ data, selected }: ResourceNodeComponentProps) => {
  const zoom = data.zoom || 1;
  const lod = effectiveLOD({ zoom, selected });
  const meta = KIND_META[data.resource_kind];

  if (lod === 'far') {
    return (
      <div className="glass rounded p-2">
        <ResourceMark kind={data.resource_kind} size={22} />
      </div>
    );
  }

  return (
    <div
      className={`glass rounded-lg p-3 min-w-[164px] transition-smooth ${
        selected ? 'ring-2 ring-occ-accent' : ''
      }`}
      style={{ borderLeft: `3px solid ${meta.color}` }}
    >
      <div className="flex items-center gap-2">
        <ResourceMark kind={data.resource_kind} size={lod === 'mid' ? 22 : 28} />
        <div className="flex flex-col min-w-0">
          <span className="text-sm text-gray-200 truncate">{data.label}</span>
          {lod === 'near' && !data.compact && data.summary && (
            <span className="text-[11px] text-gray-500 truncate">{data.summary}</span>
          )}
        </div>
      </div>

      {lod === 'near' && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {/*
            类别优先用后端报的那个：同一个 resource_kind 底下可能是执行者实现、
            供应商目录、能力包或工具包，都渲染成「Extension」等于什么都没说
          */}
          <Badge variant="default" size="sm">
            {data.category ?? meta.label}
          </Badge>

          {data.agent && (
            <>
              <Badge variant="default" size="sm">
                {data.agent.tools.length} 项工具
              </Badge>
              <Badge variant="default" size="sm">
                {data.agent.packages.length} 个包
              </Badge>
            </>
          )}

          {data.dispatch_status && (
            <Badge
              variant={data.dispatch_status === 'dispatched' ? 'info'
                : data.dispatch_status === 'failed' ? 'danger' : 'default'}
              size="sm"
            >
              {DISPATCH_TEXT[data.dispatch_status]}
            </Badge>
          )}

          {data.dispatch_error && (
            <span className="w-full text-[11px] text-occ-crit-light break-words">
              {data.dispatch_error}
            </span>
          )}

          {/*
            一级节点：收起时也要看得出背后有多少东西。
            计数值直接来自快照，不在这里估算；0 项就不画这一格。
          */}
          {Boolean(data.child_count) && (
            <Badge variant="default" size="sm">
              {data.child_count}
              {CHILD_UNIT[data.resource_kind] ?? ' 项'}
            </Badge>
          )}
        </div>
      )}

      {/*
        配置对象的两栏：**意图**与**观测**分开显示，另有诊断一句。
        合成一个布尔值就说不清「你要它开着，但它起不来」——那正是这一版要能
        说出来的话。没有 facts 时这一块整个不出现（没有数据就不显示）。

        **条目（`compact`）不画这一块**：它们的状态归左上角那块卡。条目一多，
        每张卡都背着一小段状态文字，整块画布就变成一片读不完的字。
      */}
      {lod === 'near' && !data.compact && configColumns(data.config).map((column) => (
        <div key={column.label} className="flex items-baseline gap-1.5 mt-1">
          <span className="text-[10px] text-gray-500 shrink-0">{column.label}</span>
          <span
            className={`text-[11px] break-words ${
              column.tone === 'danger' ? 'text-occ-crit-light'
                : column.tone === 'warning' ? 'text-occ-warn' : 'text-slate-300'
            }`}
          >
            {column.value}
          </span>
        </div>
      ))}

      {/*
        这个节点本身就是一个解析不到的引用的占位：给它引用 + 标记 + 原因，
        不给一个看起来正常的名字。
      */}
      {lod === 'near' && data.reference && data.reference.state !== 'resolvable' && (
        <ReferencePlaceholder view={data.reference} variant="block" />
      )}

      {/* 它指向的东西解析不到时（智能体的模型、能力所属的包）同样给最小占位 */}
      {lod === 'near' && data.agent?.model && data.agent.model.state !== 'resolvable' && (
        <ReferencePlaceholder view={data.agent.model} role="模型" variant="block" />
      )}
      {lod === 'near' && data.owner && data.owner.state !== 'resolvable' && (
        <ReferencePlaceholder view={data.owner} role="所属包" variant="block" />
      )}

      {lod === 'near' && Boolean(data.child_count) && (
        <div className="text-[11px] text-gray-500 mt-1.5">
          {data.expanded ? '双击收起' : '双击展开'}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="opacity-0" />
      <Handle type="target" position={Position.Left} className="opacity-0" />
    </div>
  );
});

ResourceNode.displayName = 'ResourceNode';
