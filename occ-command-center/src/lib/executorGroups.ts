/**
 * Executor Configuration 的供应商分组
 *
 * 快照里的 `executors` 是后端 `executors.config.public_config()` 的公开视图，
 * 每条都带一个 `provider_id`（由 `extensions/executor_loader.py` 决定：
 * manifest 显式声明的 `provider:` 优先，没声明的看有没有模型段——
 * 连模型都没有的就是本地写死的函数，归 `localFunction`）。
 *
 * 这是执行者配置**唯一**的取值链：新建任务、新建日程、配置舱都从这里取。
 * 两处各写一遍就会各错一次（后端的人读名称是 `display_name`，不是
 * `label` / `name`）——`executorCatalog.ts` 的文档注释记着同一条教训。
 */

import { LOCAL_FUNCTION_PROVIDER } from '../api/gateway';
import type { GatewayExecutor, GatewaySnapshot } from '../api/gateway';
import type { SelectGroup } from './selectGroups';
import { agentId, agentSelectable } from './agents';

export { LOCAL_FUNCTION_PROVIDER };

/**
 * 默认落在**能跑的第一条**执行者上
 *
 * 目录里也有现在跑不了的那些：`langgraph.agent` 是基座（要模型，而没有人给它配
 * 一个）。默认落在"第一条"上的话，用户什么都不改直接提交，后端会回一句
 * 「它跑不起来」——那句话说的是"换一条"，看起来却像表单自己坏了。
 *
 * 一条 `runnable: true` 都没有时回落到第一条（有总比空着强），
 * 而**连一条都没有**时给空串：让必填校验去挡住提交，别在 state 里留一个假引用。
 */
export function firstRunnableExecutor(executors: GatewayExecutor[]): string {
  const usable = executors.find((executor) => executor.id && executor.runnable === true);
  const any = executors.find((executor) => executor.id);
  return String(usable?.id ?? any?.id ?? '');
}

/** 后端没有给出供应商时的分组 key。空串不是编出来的名字，是一个明确的「没标注」 */
export const UNLABELED_PROVIDER_KEY = '';
export const UNLABELED_PROVIDER_LABEL = '未标注供应商';

/** 「没有模型段」那一组的显示名。**key 是机器名，不该直接印在界面上** */
export const LOCAL_FUNCTION_LABEL = '无供应商';

/**
 * 分组 key → 人读的那句话
 *
 * `localFunction` 是老后端留下的 key（规则还在：不带模型的执行者就是本地写死的
 * 那些）。它是个机器名，直接画出来等于让用户在画布上读一个变量名。
 */
export function providerLabel(key: string): string {
  if (key === LOCAL_FUNCTION_PROVIDER) return LOCAL_FUNCTION_LABEL;
  if (key === UNLABELED_PROVIDER_KEY) return UNLABELED_PROVIDER_LABEL;
  return key;
}

/** 任务层两组的 key。组只是分组轴，永远不是提交值 */
export const TASK_HARDCODED_GROUP = 'localFunction';
export const TASK_AGENT_GROUP = 'agent';

/**
 * 按供应商切成两级下拉的分组。
 *
 * 三条规则：
 *
 * 1. **顺序就是快照顺序**——分组是一个「保序划分」，把各组摊平还是原来的数组，
 *    所以 `firstOptionValue(groupExecutorsByProvider(list))` 恒等于 `list[0].id`。
 *    改造前那个扁平下拉的初值正是第一条，这条性质让默认选中不变。
 * 2. `provider_id` 缺失/空白自成一组「未标注供应商」，按首次出现位置排：
 *    并进某个真实供应商是编造，丢弃则是让用户选不到一条后端真能跑的配置。
 *    key 用 trim 后的值，否则 `' uniapi'` 和 `'uniapi'` 会出现两个同名组。
 * 3. 没有 `id` 的执行者不成选项：提交的必须是后端注册的 id，
 *    不替它回落到 `ref`（那会提交一个后端不认的引用）。
 */
export function groupExecutorsByProvider(executors: GatewayExecutor[]): SelectGroup[] {
  const groups = new Map<string, SelectGroup>();

  for (const executor of executors) {
    const value = String(executor.id ?? '');
    if (!value) continue;

    const key = String(executor.provider_id ?? '').trim();
    let group = groups.get(key);
    if (!group) {
      group = { key, label: providerLabel(key), options: [] };
      groups.set(key, group);
    }
    group.options.push({ value, label: String(executor.display_name ?? value) });
  }

  return [...groups.values()];
}

/**
 * 任务层的执行者列表：**硬编码执行者 ∪ 智能体**（ADR-026）
 *
 * 模型**不在这一层出现**：它下沉成智能体的一个属性。改造前这里是一份按供应商
 * 分组的模型目录（这个仓库里 uniapi 一家就两百多个 profile），于是「谁负责把
 * 这件事推到收敛」的答案是一个模型名——那不是一个有意义的答案。
 *
 * 提交值就是执行者引用本身：硬编码执行者用它自己的 `id`，智能体用 `agent:<id>`
 * （`agent.<id>` 是它在配置状态里的键，两种拼法指同一个对象，换算只有一处）。
 * 组名只是分组轴，永远不进 payload。
 *
 * 停用的智能体不进列表：那是「能不能被新建引用」的清单，与执行者 profile 同一套
 * 规矩（后端 `_executors_snapshot` 里写的就是这一条）。
 */
export function taskExecutorChoices(snapshot: GatewaySnapshot): SelectGroup[] {
  const hardcoded = (snapshot.executors ?? [])
    /*
      两组：**不带模型的**（本地写死的那些），而且**现在起得来**的。

      加后一条是因为新树把"带代码的基座"也放进了执行者列表（`langgraph.agent`
      那种，它 `needs_llm` 却没有模型——模型是配置的事）。它出现在这里，用户选中
      之后建 Task 会被后端当场拒掉（"要用模型，但没有人给它配一个"）。一个下拉里
      列出**选不得的东西**，比少列一条更糟。
    */
    .filter((executor) => String(executor.provider_id ?? '') === LOCAL_FUNCTION_PROVIDER
      && executor.runnable !== false)
    .map((executor) => ({
      value: String(executor.id ?? ''),
      // 人读名称是 display_name；后端缺失时已经回落到裸 id，这里不再猜别的字段
      label: String(executor.display_name ?? executor.id ?? ''),
    }))
    .filter((option) => option.value);

  const agents = (snapshot.agents ?? [])
    .filter(agentSelectable)
    .map((agent) => ({
      /*
        提交的是**执行者的名字**（`probe-agent`），不是 `agent:probe-agent`。

        `agent:<id>` 是**旧后端**的执行者作用域拼法。新树里执行者只有一个名字，
        `Task.executor_ref` 存的是它、`registry.executors.get()` 认的也是它——
        送那个带冒号的过去，每一个由界面建的任务都会被判「没有这个执行者」。
      */
      value: agentId(agent.agent_ref),
      label: agent.label || agent.agent_ref,
    }));

  // 空组不画：一个空的分组标题等于把「没有」画成「有一组空的」
  return [
    ...(hardcoded.length > 0
      ? [{ key: TASK_HARDCODED_GROUP, label: '硬编码执行者', options: hardcoded }]
      : []),
    ...(agents.length > 0
      ? [{ key: TASK_AGENT_GROUP, label: '智能体', options: agents }]
      : []),
  ];
}
