/**
 * 智能体的两种拼法，以及「这份定义展开出哪些工具」
 *
 * 同一个智能体有两种合法写法，两个命名空间服务两件事（镜像后端
 * `localconfig/agents.py`）：
 *
 * - **配置状态的键** `agent.<id>`——「这个对象在配置里叫什么」，进 objects 表、
 *   进配置舱的对象列表；
 * - **执行者的引用** `agent:<id>`——「谁来干这件事」，进 `Task.executor_config_ref`，
 *   与 `uniapi:qwen-max` 同形。
 *
 * **归一只有一处**（就是这里）。散出去写两遍就会像后端那样反复出错：一次是判不出
 * `agent:ops` 于是拼出 `agent.agent:ops`，报错说「执行者配置不存在」（看起来像配置
 * 没建，其实是名字拼错）；一次是拿 `agent.` 去比 `agent:`，于是该拦的删除放行了。
 */

import type { GatewaySnapshot, GatewayToolSpec } from '../api/gateway';

export const AGENT_PREFIX = 'agent.';
/** 执行者命名空间里的作用域段。与 `uniapi:` 同形 */
export const AGENT_SCOPE = 'agent:';

/**
 * 包的引用前缀：`extension.weather`
 *
 * 它是**配置状态里的键**（`objects` 那一行就是这么写的），不是"扩展"这个词——
 * 一个目录名叫 weather 的包，引用就是 `extension.weather`。
 */
export const PACKAGE_SCOPE = 'extension.';

/** 从**任何**拼法里取出裸 id */
export function agentId(reference: string): string {
  for (const prefix of [AGENT_SCOPE, AGENT_PREFIX]) {
    if (reference.startsWith(prefix)) return reference.slice(prefix.length);
  }
  return reference;
}

/** 配置状态的键 `agent.<id>` */
export function agentKey(reference: string): string {
  return `${AGENT_PREFIX}${agentId(reference)}`;
}

/** 执行者引用 `agent:<id>`——Task 里存的就是它 */
export function agentExecutorRef(reference: string): string {
  return `${AGENT_SCOPE}${agentId(reference)}`;
}

/**
 * 编辑中的草稿会展开出哪些工具
 *
 * 为什么前端要算一遍：**后端只在保存之后才算**（`resolve()` 拿到的是落库的定义），
 * 而编辑器必须在保存之前就让人看见「勾上这个包，我会多出哪些工具、哪些要审批」。
 * 规则与 `localconfig/agents.py` 的 `resolve()` 一致，三点：
 *
 * - 工具来自**包集的并集**（整包选，不逐个工具），按 `tool_id` 去重并保序；
 * - `declared` 是能力 manifest 声明的地板（ADR-006），来自快照的 capability 记录；
 * - 生效 = `declared or tightened`（ADR-027）：**只能更严**，所以收紧一个声明
 *   本来就是 true 的工具毫无作用，后端也会拒——界面上因此不给那个勾。
 */
export function previewAgentTools(
  snapshot: GatewaySnapshot,
  packages: readonly string[],
  tighten: readonly string[]
): GatewayToolSpec[] {
  const declaredOf = new Map(
    snapshot.capabilities.map((item) => [item.tool_id, Boolean(item.approval_required)])
  );
  // 键是**供给名**：`packages` 这个参数最终写成 `tools_from`，而后端按供给名找
  const toolsOfPackage = new Map(
    snapshot.abilities.map((item) => [item.supply ?? item.ability.ability_ref,
                                     item.capabilities ?? []])
  );

  const ordered: string[] = [];
  for (const packageRef of packages) {
    for (const toolId of toolsOfPackage.get(packageRef) ?? []) {
      if (!ordered.includes(toolId)) ordered.push(toolId);
    }
  }

  return ordered.map((toolId) => {
    const declared = declaredOf.get(toolId) ?? false;
    const tightened = tighten.includes(toolId);
    return {
      tool_id: toolId,
      declared,
      effective: declared || tightened,
      tightened_by_agent: tightened,
    };
  });
}

/** 智能体是否还能被新建的任务引用。停用是一个显式选择，其余值不替用户解读 */
export function agentSelectable(agent: { activation?: string }): boolean {
  return agent.activation !== 'disabled';
}
