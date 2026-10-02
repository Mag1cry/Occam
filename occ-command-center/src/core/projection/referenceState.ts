/**
 * 引用解析：快照侧的三态
 *
 * 只从**快照里同一批事实**算：已注册的对象清单（abilities / executors / agents /
 * schedules）+ 配置状态的那张 objects 表。判据与后端 `Gateway.resolve_reference`
 * 一致，但**它不是权威**：要单个对象的权威答案时走 `api/gateway.ts` 的
 * `resolveObject()`（`GET /api/objects/{ref}`，按对象重读）。
 *
 * 为什么要它：画布上的引用是**批量**的（一条 Task 一条引用、一个能力一个所属包），
 * 每个引用发一次请求会把一次刷新变成 N 次网络往返；而这些判断的输入本来就都在
 * 手里这份快照里。
 *
 * 三种结果，不是两种：
 *
 * ```text
 * resolvable  系统知道它指向什么，而且它现在可用
 * offline     系统知道它曾经是什么，但它现在不可用 → 最小占位 + 原因
 * unknown     系统不知道它是什么 → 明确未知，不猜
 * ```
 *
 * 塌成 `exists() -> bool` 的后果后端已经吃过一次：一条历史记录引用了一个已下线的
 * 配置，整个界面打不开。更要紧的是 `offline` 与 `unknown` 对用户是两件事——
 * 一个能说清原因（「用户已停用它」），一个只能承认不知道。
 */

import type { GatewayObject, GatewaySnapshot } from '../../api/gateway';
import type { ReferenceView } from '../types/node';
import { AGENT_PREFIX, AGENT_SCOPE, PACKAGE_SCOPE, agentKey } from '../../lib/agents';

/**
 * 引用 → 配置状态的键
 *
 * 与后端 `_object_ref_for` 同一套换算：智能体的两种拼法归一，扩展/设备/MCP/日程
 * 的引用本身就是键，其余（执行者）加 `executor.` 前缀。**只有这一处做换算**。
 */
export function objectRefOf(ref: string): string {
  if (ref.startsWith(AGENT_SCOPE) || ref.startsWith(AGENT_PREFIX)) return agentKey(ref);
  if (/^(extension|device|mcp|schedule)\./.test(ref)) return ref;
  return `executor.${ref}`;
}

/** 配置状态里的一行；没有就是 undefined（**不等于**「停用了」） */
export function objectRowOf(
  ref: string,
  snapshot: GatewaySnapshot
): GatewayObject | undefined {
  const key = objectRefOf(ref);
  return (snapshot.objects ?? []).find((row) => row.object_ref === key);
}

/** 已下线的一句话：系统知道它曾经是什么，只是现在不可用 */
const DISABLED_REASON = '用户已停用它；历史引用照旧可读';
/** 系统里连记录都没有：只能承认不知道 */
const UNKNOWN_REASON = '系统里没有这个引用的任何记录';

/**
 * 它在不在「能被解析」的清单里
 *
 * 与后端 `_resolves()` 一一对应。注意**停用的对象仍然算「在」**：注册表知道它，
 * 只是它现在不可用——那正是 `offline` 与 `unknown` 的分界。执行者尤其明显：
 * 后端按设计把被用户停用的 profile 从公开目录里过滤掉了，但 `exists()` 照旧为真，
 * 所以这里要两边都看（清单里有，或配置状态里有它这一行）。
 */
function resolves(ref: string, snapshot: GatewaySnapshot): boolean {
  if (ref.startsWith(AGENT_SCOPE)) {
    // 定义还在、或配置状态里还有它那一行（删掉定义时后端会留着那一行）
    const key = agentKey(ref);
    return (snapshot.agents ?? []).some((agent) => agent.agent_ref === key) || hasRow(key, snapshot);
  }
  if (ref.startsWith(PACKAGE_SCOPE)) {
    /*
      **包在"那棵树"上，不在供给列表里。**

      两条引用以前对不上：`objects` 那一行写的是 `extension.weather`，而
      `abilities` 里的 ref 是前端现造的 `supply:weather`，于是这个函数**永远认不出包**，
      每一次都掉到下面"配置状态里有它那一行"那一支，答 `offline`。

      后果在界面上：**每一个工具节点都挂着一句「所属包 extension.weather 已下线」**，
      而那个包好好的。一句假话，还长得像真的。

      停用的包**仍然算「在」**——控制状态里那一行说了它是停用，那是 `offline`
      与 `unknown` 的分界（下面 `referenceStateOf` 会读那一行）。
    */
    const id = ref.slice(PACKAGE_SCOPE.length);
    return (snapshot.console ?? [])
      .some((node) => node.kind === 'package' && node.name === id);
  }
  if ((snapshot.executors ?? []).some((executor) => String(executor.id ?? '') === ref)) return true;
  if ((snapshot.abilities ?? []).some((item) => item.ability.ability_ref === ref)) return true;
  if (ref.startsWith('schedule.')) {
    return (snapshot.schedules ?? []).some((item) => `schedule.${item.schedule_id}` === ref);
  }
  return false;
}

function hasRow(objectRef: string, snapshot: GatewaySnapshot): boolean {
  return (snapshot.objects ?? []).some((row) => row.object_ref === objectRef);
}

/**
 * 解析一个引用
 *
 * `activation` 只用来判断「是用户把它关了」还是「它自己坏了」——这两句话不一样，
 * 而界面上必须说得出来。
 */
export function referenceStateOf(ref: string, snapshot: GatewaySnapshot): ReferenceView {
  const objectRef = objectRefOf(ref);
  const row = (snapshot.objects ?? []).find((item) => item.object_ref === objectRef);

  if (resolves(ref, snapshot)) {
    // 注册表里有它，但用户把它关了：这不是「查不到」，是「它被停用了」
    if (row && row.activation === 'disabled') {
      return view(ref, objectRef, row, 'offline', DISABLED_REASON);
    }
    return view(ref, objectRef, row, 'resolvable', '');
  }

  if (row) {
    // 在配置状态里存在、却解析不到：它曾经是什么系统知道，只是现在起不来
    return { ...offlineViewOf(row), ref };
  }

  return { ref, object_ref: '', state: 'unknown', kind: '', reason: UNKNOWN_REASON };
}

/**
 * 一个只剩配置状态那一行的对象：它的「已下线」长什么样
 *
 * 与 `referenceStateOf` 的 offline 分支是**同一条规则**，只是调用方手里已经
 * 拿着那一行（占位节点就是从这里来的），不必再按引用找一遍。
 *
 * 原因取最近一条诊断（它为什么没起来）；没有诊断才回落到上次失败留下的那句话。
 * **用户停用**与**它坏了**因此是两句不同的话：前者是配置状态说的，后者是诊断说的。
 */
export function offlineViewOf(row: GatewayObject): ReferenceView {
  const reason = row.activation === 'disabled'
    ? DISABLED_REASON
    : row.diagnostic?.message || row.last_error || '它现在不可用';
  return {
    ref: row.object_ref,
    object_ref: row.object_ref,
    state: 'offline',
    kind: row.kind,
    reason,
  };
}

function view(
  ref: string,
  objectRef: string,
  row: GatewayObject | undefined,
  state: ReferenceView['state'],
  reason: string
): ReferenceView {
  return { ref, object_ref: objectRef, state, kind: row?.kind ?? '', reason };
}

/**
 * 引用指向的那个对象**曾经**叫什么
 *
 * 最小占位不伪造一个正常的名字，但把系统确实知道的那个键给出来
 * （`agent.ops` / `executor.uniapi:qwen-max`），用户才有线索去查。
 * 系统不知道时返回空串。
 */
export function referencePlaceholderLabel(view: ReferenceView): string {
  return view.object_ref || view.ref;
}
