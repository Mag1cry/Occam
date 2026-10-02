/**
 * LOD (Level of Detail) 计算逻辑
 *
 * 根据缩放级别调整节点的信息密度
 */

export type LODLevel = 'far' | 'mid' | 'near';

const ORDER: Record<LODLevel, number> = { far: 0, mid: 1, near: 2 };

/**
 * 根据缩放级别计算 LOD
 */
export function calculateLOD(zoom: number): LODLevel {
  if (zoom < 0.5) {
    return 'far';
  } else if (zoom < 1.0) {
    return 'mid';
  } else {
    return 'near';
  }
}

/**
 * 至少达到某一档密度
 */
export function atLeast(level: LODLevel, minimum: LODLevel): LODLevel {
  return ORDER[level] >= ORDER[minimum] ? level : minimum;
}

/**
 * 实际生效的 LOD
 *
 * LOD 只改变渲染表现，不删除投影节点；且选中节点、聚焦节点和
 * 待拍板节点不能因为缩小而完全失去可访问文字。
 */
export function effectiveLOD(params: {
  zoom: number;
  selected?: boolean;
  /** 需要用户注意的节点（响铃/亮灯） */
  attention?: boolean;
}): LODLevel {
  const base = calculateLOD(params.zoom);
  if (params.selected) return atLeast(base, 'near');
  if (params.attention) return atLeast(base, 'mid');
  return base;
}

