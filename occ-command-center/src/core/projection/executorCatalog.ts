/**
 * Executor Configuration 资料目录
 *
 * 快照里的 `executors` 是后端 `executors.config.public_config()` 的公开视图。
 * Task 场景的引用摘要和配置舱的资料节点都从这一份解析——两处各写一遍取值链
 * 就会各错一次（后端的人读名称是 `display_name`，不是 `label` / `name`）。
 */

import type { GatewaySnapshot } from '../../api/gateway';
import type { ResourceNode } from '../types/node';

export function executorCatalog(snapshot: GatewaySnapshot): ResourceNode[] {
  return (snapshot.executors ?? []).map((executor, index) => ({
    type: 'resource' as const,
    id: String(executor.id ?? executor.ref ?? `executor-${index}`),
    resource_kind: 'executor-config' as const,
    // display_name 在后端缺失时已经回落到 ref，所以这里它就是人读名称
    label: String(executor.display_name ?? executor.id ?? executor.ref ?? 'Executor'),
    // 坐标由场景铺：它才知道一个 profile 目录会有多大（这里可能有几百项），
    // 只有它能把几种资料排成互不重叠的带
    x: 0,
    y: 0,
    summary: String(executor.description || executor.type || ''),
    // 不带 enabled：公开视图里没有启用/禁用这个概念，
    // 写 true 会让配置舱对着一个未知状态说「已启用」。
  }));
}
