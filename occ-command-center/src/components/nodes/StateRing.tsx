/**
 * StateRing 组件
 *
 * 状态环视觉组件，根据形状和颜色渲染状态环
 */

import type { StateRingShape } from '../../core/types/state';

interface StateRingProps {
  /** 状态环形状 */
  shape: StateRingShape;
  /** 颜色 */
  color: string;
  /** 尺寸（像素） */
  size?: number;
  /** 状态标签 */
  label?: string;
  /** 是否显示标签 */
  showLabel?: boolean;
}

export function StateRing({
  shape,
  color,
  size = 48,
  label,
  showLabel = false,
}: StateRingProps) {
  const strokeWidth = size * 0.1;
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;

  // 根据形状渲染不同的路径
  const renderPath = () => {
    switch (shape) {
      case 'closed':
        // 闭合环：完整圆环
        return (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
          />
        );

      case 'gap':
        // 缺口环：顶部有缺口
        const gapAngle = 30; // 缺口角度
        const startAngle = -90 + gapAngle / 2; // 从顶部缺口开始
        const endAngle = 270 - gapAngle / 2; // 到顶部缺口结束
        const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;

        const startRad = (startAngle * Math.PI) / 180;
        const endRad = (endAngle * Math.PI) / 180;

        const x1 = center + radius * Math.cos(startRad);
        const y1 = center + radius * Math.sin(startRad);
        const x2 = center + radius * Math.cos(endRad);
        const y2 = center + radius * Math.sin(endRad);

        return (
          <path
            d={`M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2}`}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
        );

      case 'broken':
        // 断裂环：多处断点
        const segments = [
          { start: -90, end: -30 },
          { start: 30, end: 90 },
          { start: 150, end: 210 },
        ];

        return (
          <g>
            {segments.map((seg, idx) => {
              const sRad = (seg.start * Math.PI) / 180;
              const eRad = (seg.end * Math.PI) / 180;
              const sx = center + radius * Math.cos(sRad);
              const sy = center + radius * Math.sin(sRad);
              const ex = center + radius * Math.cos(eRad);
              const ey = center + radius * Math.sin(eRad);

              return (
                <path
                  key={idx}
                  d={`M ${sx} ${sy} A ${radius} ${radius} 0 0 1 ${ex} ${ey}`}
                  fill="none"
                  stroke={color}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                />
              );
            })}
          </g>
        );

      case 'collapsed':
        // 收束环：收缩的圆环
        const collapsedRadius = radius * 0.6;
        return (
          <circle
            cx={center}
            cy={center}
            r={collapsedRadius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            opacity={0.6}
          />
        );

      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} className="transition-smooth">
        {renderPath()}
      </svg>
      {showLabel && label && (
        <span className="text-xs text-gray-400 num">{label}</span>
      )}
    </div>
  );
}
