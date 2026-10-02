/**
 * 操作牌命令 → 后端网关命令
 *
 * 各场景的操作牌共用这一份映射：各写一份必然走偏。
 *
 * 只读命令（`view`）和导航命令（`enter`）不在这里——它们要么不提交任何东西，
 * 要么由 Focus Leap 处理，**不能**在提交后显示「Core 已接受」。
 */

import { setConfigEnabled, sendGatewayCommand,
         type GatewayObject, type LiveDeclaration } from '../api/gateway';
import type { Command } from '../core/types/projection';
import { activationFailureText } from './nodeVisual';

const TASK_COMMAND: Partial<Record<Command['type'], string>> = {
  run: 'start_task',
  approve: 'approve',
  deny: 'deny',
  cancel: 'cancel',
  archive: 'archive',
  forget: 'forget',
};

export type CommandOutcome =
  /**
   * 命令被接受，但结果里带着一句必须说出来的保留
   *
   * 典型是审批：批准这个事实**确实记下了**，但它之后要做的自动恢复失败了——
   * 那是两件事，把 `ok` 写成 false 会把已经发生的事实也说成没发生。
   */
  | { submitted: true; ok: true; warning?: string }
  | { submitted: true; ok: false; error: string }
  /** 不是后端命令：没有提交任何东西，界面不能显示回执 */
  | { submitted: false };

/** Task 操作牌 → 后端命令；只读/导航返回 null */
export function resolveTaskCommand(command: Command): string | null {
  return TASK_COMMAND[command.type] ?? null;
}

/**
 * Schedule 命令的提交入口
 *
 * **世界场景与编排台共用这一条**：两处各写一遍的话，改了一处另一处还是死的
 * （「查看结果」那次返工就是同一个病：改了内部不改外部）。
 *
 * 三条命令的去处各不相同：
 *
 * | 牌面上 | 后端 |
 * | --- | --- |
 * | 立即触发 | `schedule.trigger` |
 * | 删除 | `schedule.delete`（**连它派出去的子 Task 一起处理**，见后端那条命令） |
 * | 启停 | **不是命令**——它是改声明里那一行（`config.set_enabled`） |
 *
 * 启停用哪个方向取决于对象**当前的启用状态**：提交前对象刚重新读取过，
 * 所以这里用的是已知事实，不是前端猜的意图。
 */
export async function executeScheduleCommand(
  command: Command,
  facts: { scheduleId: string; enabled: boolean },
  declarations: LiveDeclaration[] = []
): Promise<CommandOutcome> {
  if (command.type === 'toggle') {
    return executeConfigCommand(
      { ...command, type: facts.enabled ? 'config-disable' : 'config-enable' },
      // 目标是**配置状态的键**，不是别处那个引用（`schedule.<name>`）
      { object_ref: `schedule.${facts.scheduleId}` } as never,
      declarations
    );
  }
  const backend = command.type === 'trigger' ? 'schedule.trigger'
    : command.type === 'delete-schedule' ? 'schedule.delete'
    : null;
  // 参数名以**声明里的那个名字**为准：日程的一个文件就叫 `name`
  return backend ? submitCommand(backend, '', { name: facts.scheduleId }) : { submitted: false };
}

/**
 * 配置对象开关的提交入口
 *
 * 目标是**配置状态的键**（`extension.weather` / `executor.uniapi:qwen-max`），
 * 不是 ability_ref 那个引用——同一个对象在两处可能不同形（智能体是
 * `agent.ops` 与 `agent:<id>`），换算收在引用解析那一处，这里照用。
 *
 * 一条命令两件事，必须分开说：
 *
 * - **已接受但没生效**（`status: failed`）：意图已经落库，用户要的那个状态记下了，
 *   只是当场没能生效。「未提交」会把已经发生的事实说成没发生；
 * - **被拒绝**（HTTP 200 + accepted:false，或传输层出错）：什么都没发生。
 */
export async function executeConfigCommand(
  command: Command,
  facts: GatewayObject,
  declarations: LiveDeclaration[] = []
): Promise<CommandOutcome> {
  const enabled = command.type === 'config-enable' ? true
    : command.type === 'config-disable' ? false
      : null;
  if (enabled === null || !facts.object_ref) return { submitted: false };
  try {
    // `kind` 不再进载荷：容器从 `object_ref` 的前缀就看得出（`extension.` / `schedule.` …）
    const outcome = await setConfigEnabled(facts.object_ref, enabled, declarations);
    const note = activationFailureText(outcome);
    return note
      ? { submitted: true, ok: true, warning: note }
      : { submitted: true, ok: true };
  } catch (error) {
    return {
      submitted: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 提交一条已解析的后端命令
 *
 * 后端返回 200 只表示**已接收**，不表示执行成功；失败一律带回原因，
 * 不用 `catch(() => undefined)` 吞掉——那会让失败也显示成「已接受」。
 *
 * 目标在哪一格是**后端定的**，不能随便挪：
 * - Task 命令（start/approve/deny/cancel）读 `task_id`，把它塞进 payload
 *   会变成「Task 不存在」；
 * - Ability 与 Schedule 命令读 payload 里的 `ability_ref` / `schedule_id`
 *   （两者都不是 Task，借 `task_id` 传引用只会让日志读起来像另一回事）。
 */
export async function submitCommand(
  backend: string,
  targetId: string,
  payload: Record<string, unknown> = {}
): Promise<CommandOutcome> {
  try {
    const response = await sendGatewayCommand(backend, targetId, payload);
    /*
      HTTP 200 也可能是**拒绝**：网关把校验没过表达成 `accepted: false` + 一句
      给人看的原因。只认状态码就会把一次拒绝显示成「Core 已接受」——那是这个
      仓库最不能出现的那类假话。`accepted` 缺失时按已接收处理：契约漂移不该
      被前端翻译成失败。
    */
    if (response.accepted === false) {
      return { submitted: true, ok: false, error: response.error || '命令被后端拒绝，没有给出原因' };
    }
    return { submitted: true, ok: true, ...readWarning(response.data) };
  } catch (error) {
    return {
      submitted: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 从回执里读出后端明说、但 HTTP 状态说不出来的保留
 *
 * 审批/拒绝返回 200 且 `accepted: true`，可它们的 `data.auto_resume` 可能告诉
 * 你「批准记下了，但恢复没做成」。**那是 200**，所以只能从 body 里读；丢掉它
 * 就等于让用户以为批准成功了，然后看着任务卡在 `paused + approved` 上——
 * 而那个状态在界面里本来是没有出路的。后端的三态：
 * `resumed` 干净；`skipped`、`failed` 都表示还在 paused，各带自己的原因。
 */
function readWarning(data: unknown): { warning?: string } {
  if (!data || typeof data !== 'object') return {};
  const auto = (data as { auto_resume?: unknown }).auto_resume;
  if (!auto || typeof auto !== 'object') return {};
  const { status, error, reason } = auto as { status?: unknown; error?: unknown; reason?: unknown };
  if (status === 'resumed' || status === undefined) return {};
  const why = typeof error === 'string' && error ? error
    : typeof reason === 'string' && reason ? reason
      : '未知原因';
  return { warning: `自动恢复没有完成：${why}` };
}

/** Task 操作牌的提交入口：目标走 `task_id` */
export async function executeTaskCommand(command: Command, taskId: string): Promise<CommandOutcome> {
  const backend = resolveTaskCommand(command);
  if (!backend || !taskId) return { submitted: false };
  return submitCommand(backend, taskId);
}
