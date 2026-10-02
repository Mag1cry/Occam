/**
 * 操作矩阵
 *
 * 权威来源：focus-leap.md 第 5 节“状态生成操作牌”。
 *
 * 操作由对象类型和真实接口共同生成。命令回执不能直接成为新状态，
 * 必须等待对象重读和事件重读。
 *
 * 没有完整 Web 契约的操作（重试、切换配置、暂停、重新分配）
 * 一律不出现在牌面上。
 *
 * **每条命令都自带后果申报**（`preview`）：影响哪些字段、预计怎么变、能不能撤回。
 * 它们在这里填，因为只有这里知道这条命令要改什么；预览组件不按命令名兜底——
 * 兜底的那句话会被套在真正不可逆的命令上（见 `core/types/projection.ts`）。
 */

import type { Command, CommandEffects, CommandSurfaceModel } from '../core/types/projection';
import type { Node as DomainNode, ResourceNode, TaskNode } from '../core/types/node';

/**
 * 后端能力开关
 *
 * 依据后端网关快照的实际字段与命令，不是目标契约：
 * 快照已含 `schedules` / `dispatches`，网关也有 `schedule.pause` /
 * `schedule.resume` / `schedule.trigger`，因此编排台的启停是真的可用。
 * `acknowledge` 与增量游标（Change Feed）仍是目标能力，未就绪时不得
 * 在前端伪造可用性。
 */
export const BACKEND_CAPABILITIES = {
  /** POST /api/tasks/{id}/acknowledge */
  acknowledge: false,
  /** 快照 schedules/dispatches + 网关 schedule.pause/resume/trigger */
  scheduleControl: true,
  /** GET /api/changes */
  changeFeed: false,
} as const;

/**
 * 只读命令的申报
 *
 * 「不改变任何状态」也是一句必须说得出来的话——预览那一栏对用户永远可见。
 * 但它只对**真的只读**的命令成立，所以每条命令各自引用它，不做兜底默认值。
 */
const READ_ONLY: CommandEffects = {
  impact: '无（只读）',
  transition: '不改变任何状态',
  reversible: true,
};

/**
 * 为 Task 生成操作牌
 *
 * `workerAlive` 是 Controller 的观测，只影响「启动 Worker 是否可用」这一类
 * 判断；它**不参与**任何状态派生。省略表示没有观测记录，此时按未知处理：
 * 没有观测不等于没有 Worker，所以不提供启动入口——重复启动会被 Core 拒绝，
 * 但界面不该主动提供一个大概率失败的动作。
 */
export function commandsForTask(
  task: TaskNode,
  workerAlive?: boolean,
  workerUnreconciled = false
): Command[] {
  const commands: Command[] = [];

  // paused + pending → 批准、拒绝、查看等待原因
  if (task.status === 'paused' && task.approval_state === 'pending') {
    commands.push({
      id: 'view-waiting-reason',
      label: '查看等待原因',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: '查看当前等待的决策详情',
    });
    commands.push({
      id: 'approve',
      label: '批准',
      type: 'approve',
      highRisk: true,
      preview: {
        impact: 'Task.pending_decision → approved；可能立即触发这次能力调用',
        transition: '保持 paused，等 Controller/Worker 恢复；恢复失败也仍是「已批准」',
        // 没有「撤回批准」这条命令：批准是决定，不是开关
        reversible: false,
      },
      description: '批准可能立即触发能力调用',
    });
    commands.push({
      id: 'deny',
      label: '拒绝',
      type: 'deny',
      highRisk: true,
      preview: {
        impact: 'Task.pending_decision → denied',
        transition: '保持 paused，等待 Agent 改方案',
        reversible: false,
      },
      description: '拒绝后 Agent 需要改方案',
    });
    return commands;
  }

  // paused + approved → 已批准，等控制侧恢复
  if (task.status === 'paused' && task.approval_state === 'approved') {
    commands.push({
      id: 'view-approval',
      label: '查看已批准决定',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: '已批准，等待 Controller/Worker 恢复',
    });
    /*
      自动恢复不一定成得了（checkpoint 没了、worker 起不来），它是一条后台路径，
      失败时没人会告诉用户——任务就静静卡在这个状态上。而 `needsAttention`
      还把它算成「亮灯」：界面把它标成待办，然后什么都不给做。

      所以这里必须留出路，两条：

      - 重试恢复：不是让用户自己按 resume（恢复仍然是控制侧的事），而是**再问
        一次**。后端每次 approve 都会重跑自动恢复，而 Core 在决定已经相同时
        提前返回、不重复追加事件，所以重试是安全的。
      - 取消：确定恢复不了就结束它，别把一个任务永久挂在这里。
    */
    commands.push({
      id: 'retry-resume',
      label: '重试恢复',
      type: 'approve',
      highRisk: false,
      preview: {
        impact: '重跑一次控制侧的自动恢复；**不追加新的决定**',
        transition: 'paused 不变；只有恢复成功才转 running',
        reversible: true,
      },
      description: '再让控制侧恢复一次；批准已经记下，不会重复记录',
    });
    commands.push({
      id: 'cancel',
      label: '取消',
      type: 'cancel',
      highRisk: true,
      preview: {
        impact: 'Task.status → cancelled（终态）',
        transition: 'running/paused → cancelled（收束环），此任务不再变化',
        reversible: false,
      },
      description: '放弃恢复并结束这个 Task',
    });
    return commands;
  }

  // paused + denied → 查看拒绝决定、等待改方案
  if (task.status === 'paused' && task.approval_state === 'denied') {
    commands.push({
      id: 'view-denial',
      label: '查看拒绝决定',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: '已拒绝，等待 Agent 改方案',
    });
    return commands;
  }

  // failed → 查看失败原因（+ 确认已处理，接口就绪时）
  if (task.status === 'failed') {
    commands.push({
      id: 'view-failure',
      label: '查看失败原因',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: '确认失败不等于成功，仍保留 failed 语义',
    });
    commands.push({
      id: 'acknowledge',
      label: '确认已处理',
      type: 'acknowledge',
      highRisk: false,
      preview: {
        impact: '追加一条可审计的确认事件；**不改 Task.status**',
        transition: '仍是 failed，只是不再按「需要关注」亮灯',
        // 确认这个事实记下之后没有反向命令；但它不改变任务状态，所以不拦
        reversible: false,
      },
      description: BACKEND_CAPABILITIES.acknowledge
        ? '追加可审计确认事件，不改变 Task.status'
        : '后端 acknowledge 接口未就绪',
      unavailable: !BACKEND_CAPABILITIES.acknowledge,
    });
    return commands;
  }

  // running → 查看事件、查看 Controller 观测、取消
  if (task.status === 'running') {
    // Core 把「已创建」和「已运行」合并成一档：新建的 Task 就是 running，
    // 但还没有 Worker。所以「启动 Worker」的判据不是状态，而是
    // 「状态 running 且观测到没有 Worker」。
    //
    // 「可能还有孤儿在外面跑」是第四种情况，绝不能并进 `workerAlive === false`：
    // 重启之后句柄必然是空的，而外面那个进程可能还活着——起第二个就会有两个
    // 写者写同一条 LangGraph 线程。这种情况下不给启动入口，并说明为什么。
    if (workerAlive === false && workerUnreconciled) {
      commands.push({
        id: 'view-recovery',
        label: '查看对账情况',
        type: 'view',
        highRisk: false,
        preview: READ_ONLY,
        description: '上一次退出时可能有 Worker 没被收走，需要先确认它已经不在了',
      });
    } else if (workerAlive === false) {
      commands.push({
        id: 'run',
        label: '启动 Worker',
        type: 'run',
        highRisk: false,
        preview: {
          impact: '拉起执行者进程；**不改 Task 字段**',
          transition: 'running 不变；Controller 观测变成「Worker 运行中」',
          reversible: true,
        },
        description: '为该 Task 拉起执行者；重复启动会被同一进程里的守卫拒绝',
      });
    }
    commands.push({
      id: 'view-events',
      label: '查看事件',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: 'Core Event Log',
    });
    commands.push({
      id: 'view-observation',
      label: '查看 Controller 观测',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: '外部观测标签，不能覆盖 Core 状态',
    });
    commands.push({
      id: 'cancel',
      label: '取消',
      type: 'cancel',
      highRisk: true,
      preview: {
        impact: 'Task.status → cancelled（终态）；执行者先被终止',
        transition: 'running → cancelled（收束环），此任务不再变化',
        reversible: false,
      },
      description: '不可逆操作，提交前需要预览',
    });
    return commands;
  }

  return commandsForTaskBody(task);
}

/**
 * 历史的那一半动作（见 `buildNodeCommands` 的 `historyAction`）
 *
 * 两道门都写在牌面上，因为它们是**后端真的会拒**的理由，不是文案：
 *
 * - **归档**只对跑完的 Task（还在动的不是历史），而且它**不改状态**——
 *   只是多一条事件；
 * - **删除**只对归档过的（归档是那道确认门，删不可撤销），删完那条引用也就没了。
 */
function historyCommands(
  task: Extract<DomainNode, { type: 'task' }>,
  half: 'archive' | 'forget',
  /** 「收起来之后它去哪儿」——外层世界进档案馆，编排台里的子 Task 留在原地 */
  scope: 'world' | 'schedule' = 'world'
): Command[] {
  if (half === 'archive') {
    if (task.archived_at) return [];                 // 已经收进去了，再归一次没有意义
    if (!(task.status === 'succeeded' || task.status === 'failed'
          || task.status === 'cancelled')) return [];
    return [{
      id: 'archive-task',
      label: '归档',
      type: 'archive',
      highRisk: false,
      preview: {
        impact: '记一条 TASK_ARCHIVED（进事件链）；**状态不变**',
        /*
          **子 Task 不进外层档案馆**（`projection-contract.md` §3：档案馆只投影
          非 Schedule Task）。所以编排台里的归档是**就地**的：那一格留在原地，
          只是多出「删除」。照抄外层那句话会让用户去档案馆里找一个永远不在那儿的
          东西。
        */
        transition: scope === 'schedule'
          ? '它留在编排台里（子 Task 不进外层档案馆），这一格上多出「删除」'
          : '它从世界里收进档案馆，在那儿只剩「删除」',
        reversible: true,
      },
      description: '收起来：它跑完了，我不再管它了',
    }];
  }
  // 馆里：**只有删除**。收录入馆是外面的动作，馆里重复给一次没有意义
  if (!task.archived_at) return [];
  return [{
    id: 'forget-task',
    label: '删除',
    type: 'forget',
    // **不可撤销**：它从列表里拿掉，所以按第 6 节先预览
    highRisk: true,
    preview: {
      impact: '这条 Task 从列表里拿掉；**事件链一条都不动**',
      transition: '删掉之后，它对执行者的引用也就没了',
      reversible: false,
    },
    description: '删掉这条历史（事件留痕）',
  }];
}

/** 一条 Task 的分支命令（不含档案馆那两步） */
function commandsForTaskBody(task: Extract<DomainNode, { type: 'task' }>): Command[] {
  const commands: Command[] = [];

  // succeeded → 查看结果、查看事件
  if (task.status === 'succeeded') {
    commands.push({
      id: 'view-result',
      label: '查看结果',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: '查看执行结果',
    });
    commands.push({
      id: 'view-events',
      label: '查看事件',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: 'Core Event Log',
    });
    return commands;
  }

  // cancelled → 查看取消记录
  if (task.status === 'cancelled') {
    commands.push({
      id: 'view-cancellation',
      label: '查看取消记录',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: '取消不等于失败，不使用红色错误语言',
    });
    return commands;
  }

  // Task 创建但尚未启动 Worker
  commands.push({
    id: 'view-task',
    label: '查看任务',
    type: 'view',
    highRisk: false,
    preview: READ_ONLY,
    description: '查看任务详情',
  });
  commands.push({
    id: 'run',
    label: '启动 Worker',
    type: 'run',
    highRisk: false,
    preview: {
      impact: '拉起执行者进程；**不改 Task 字段**',
      transition: '状态不变；Controller 观测变成「Worker 运行中」',
      reversible: true,
    },
    description: '启动执行',
  });
  return commands;
}

/**
 * 为配置舱资料生成操作牌
 *
 * 资料不是可执行单位，所以牌面上只有两样东西：**只读的「查看资料」**，
 * 以及**那条开关**（ADR-025 只有一条开关实现）。
 *
 * 「停用」按 `focus-leap.md` 第 6 节属于必须先预览的不可逆动作，
 * 所以它是高风险的：先预览再提交。
 *
 * 开关**只在有配置状态那一行时**才给（`objects` 里有它）→ `config.set_enabled`：
 * 意图与观测分开，「你要它开着但它起不来」说得出来。没有这一行就不给——
 * 后端对没有种子化的对象会直接回「配置对象不存在」。
 *
 * ## 这里以前还有一条 `ability.start / stop / health`（已删）
 *
 * 那是旧模型（供给 / 设备 / 内置三类 Ability + 上下线生命周期）的东西，
 * 判据是 `node.ability` 这一格。新树里**没有任何地方给它赋值**——资料节点只挂
 * `config`（配置状态那一行）与 `owner`（所属包）——所以那条支路一次都走不到：
 * 前端会发出的 `ability.start` 在后端命令面上根本不存在。
 *
 * 一起删掉的还有 `device-sample`（它挂在 `ability.device_ref` 上，同一个模型），
 * 以及那几条**手搓 fixture** 才测得到的用例：真链路给不出带 `ability` 的节点，
 * 那种测试是在为不存在的数据鼓掌。
 */
export function commandsForResource(node: ResourceNode): Command[] {
  const commands: Command[] = [
    {
      id: 'view-resource',
      label: '查看资料',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: '公开字段、manifest 或引用完整性',
    },
  ];

  const facts = node.config;
  if (facts) {
    /*
      两个方向各给一条，且只给**当前不是的那个**：按当前 activation 给相反的那一个。
      认不出的取值（契约漂移）两个都不给——不知道现在是什么，就无从说「相反」。
    */
    if (facts.activation === 'enabled') {
      commands.push({
        id: 'config-disable',
        label: '停用',
        type: 'config-disable',
        highRisk: true,
        preview: {
          impact: '配置状态 activation: enabled → disabled；它的能力不再可用',
          transition: '已加载的卸载并注销它的能力；已 import 进进程的代码要重启才真卸掉',
          // 反向命令就是下面那条「启用」，所以它可撤回
          reversible: true,
        },
        description: '停用后它的能力不再可用',
      });
    } else if (facts.activation === 'disabled') {
      commands.push({
        id: 'config-enable',
        label: '启用',
        type: 'config-enable',
        highRisk: false,
        preview: {
          impact: '配置状态 activation: disabled → enabled',
          transition: '当场尝试启动或加载；失败时**意图保持启用**并记下诊断',
          reversible: true,
        },
        description: '启用后当场尝试让它真正起来',
      });
    }
  }

  // 按对象类型给编辑入口：智能体编辑定义，能力编辑权限（写在它所属包的 manifest 里）
  if (node.resource_kind === 'agent') {
    commands.push({
      id: 'edit-agent',
      label: '编辑',
      type: 'edit-agent',
      highRisk: false,
      preview: {
        impact: '打开编辑页；**提交之前不改变任何东西**',
        transition: '保存时才写那份声明（manifest.create / write），之后由重读的快照呈现',
        reversible: true,
      },
      description: '模型、system_prompt、扩展包与逐工具的收紧',
    });
  }
  if (node.resource_kind === 'capability' && node.owner?.state === 'resolvable') {
    commands.push({
      id: 'edit-tool',
      label: '编辑权限',
      type: 'edit-tool',
      highRisk: false,
      preview: {
        impact: '打开权限编辑；**提交之前不改变任何东西**',
        transition: '保存时改 manifest 并立刻重载该包（改的是声明，不是运行状态）',
        reversible: true,
      },
      description: '改它所属包的这个工具的声明字段',
    });
  }

  return commands;
}

/**
 * 删除一个智能体
 *
 * 它不在节点操作牌上：删除不可逆，放在它自己的编辑页里——用户动手时正看着
 * 这份定义，而不是在画布上点了一个按钮。仍然要先预览（第 6 节），也仍然可能
 * 被拒：还有 running / paused 的任务在用它时后端会拒绝，并把那些任务 ID 一起回告。
 */
export function deleteAgentCommand(): Command {
  return {
    id: 'delete-agent',
    label: '删除智能体',
    type: 'delete-agent',
    highRisk: true,
    preview: {
      impact: '删除这份定义；配置状态里那一行**留着**',
      transition: '不再能被新建任务引用；历史引用仍解析成「已下线」，不是「查不到」',
      reversible: false,
    },
    description: '还有任务在用它时会被拒绝，原因里会带着那些任务 ID',
  };
}

/**
 * 依据节点类型和真实状态生成操作牌
 */
export function buildNodeCommands(
  node: DomainNode,
  options: {
    canEnter: boolean;
    enterLabel: string;
    workerAlive?: boolean;
    /** 可能还有孤儿 worker 在外面跑：此时不给「启动 Worker」 */
    workerUnreconciled?: boolean;
    /**
     * 这个场景给历史的那**一半**动作
     *
     * - `'archive'` —— **外面的场景**（世界 / 任务详情）：一条跑完的 Task 堆在那儿，
     *   按「归档」把它收进档案馆；
     * - `'forget'` —— **档案馆**：收进来的那些，按「删除」拿掉。
     *
     * 两个动作是一件事的两半，而**在哪儿给哪一半由场景说**，不由节点类型说：
     * 馆里再给一次"归档"没有意义（它已经归档了），世界里给"删除"则把不可撤销的
     * 那一步混进了日常操作。
     *
     * **编排台两个都给**（按节点自己的 `archived_at` 选那一半）：它的子 Task
     * 在外层根本看不见，归档后也不会进档案馆（§3：馆里只投影非 Schedule Task），
     * 所以「收起来」那一步只能在这儿走完。
     */
    historyAction?: 'archive' | 'forget';
    /** 归档之后它去哪儿——只说给预览听（见 `historyCommands` 的 `scope`） */
    historyScope?: 'world' | 'schedule';
  }
): CommandSurfaceModel {
  const commands: Command[] = [];

  if (node.type === 'task') {
    commands.push(...commandsForTask(node, options.workerAlive, options.workerUnreconciled));
    if (options.historyAction) {
      commands.push(...historyCommands(node, options.historyAction,
                                       options.historyScope ?? 'world'));
    }
  } else if (node.type === 'schedule') {
    commands.push({
      id: 'view-schedule',
      label: '查看编排台',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: '规则摘要、启用状态和 occurrence',
    });
    commands.push({
      id: 'edit-schedule',
      label: '编辑',
      type: 'edit-schedule',
      highRisk: false,
      preview: {
        // 改的是**磁盘上那份声明**，不是内存里一个字段：说清楚改哪儿
        impact: 'extensions/_schedules 里那份声明的 cron / 时区 / 输入引用 / 执行者',
        transition: '改完立刻重读；下一次派发按新规则，已经建出来的子 Task 不受影响',
        reversible: true,
      },
      description: '改规则、输入引用与执行者（名字是身份，不给改）',
    });
    commands.push({
      id: 'trigger-schedule',
      label: '立即触发',
      type: 'trigger',
      // 触发会真的创建并运行一个 Core Task，且没有撤回契约：按第 6 节先预览
      highRisk: true,
      preview: {
        impact: '立刻创建并运行一个 Core Task（新节点会出现）',
        transition: '不改动计划本身；只多出一条 occurrence 与它的 Task',
        // Task 一旦跑起来就没有「撤回这次派发」的命令
        reversible: false,
      },
      description: '立刻派发一次，不改动计划本身',
      unavailable: !BACKEND_CAPABILITIES.scheduleControl,
    });
    commands.push({
      id: 'toggle-schedule',
      label: '启停',
      type: 'toggle',
      highRisk: true,
      preview: {
        impact: 'Schedule.enabled 翻转',
        transition: '停用后不再创建新的 occurrence；已创建的不受影响',
        reversible: true,
      },
      description: BACKEND_CAPABILITIES.scheduleControl
        ? '停用后不再创建新的 occurrence'
        : 'Schedule 接口未就绪',
      unavailable: !BACKEND_CAPABILITIES.scheduleControl,
    });
    commands.push({
      id: 'delete-schedule',
      label: '删除',
      type: 'delete-schedule',
      // **不可撤销**：那份声明和它的子 Task 一起没了，所以按第 6 节先预览
      highRisk: true,
      preview: {
        /*
          **把那个数写在闸门上**：删的是"这条日程 + 它派出去的 N 个子 Task"，
          不是"一条日程"。子 Task 在外层看不见、也进不了档案馆，用户平时根本
          数不出有多少个——不写出来的话，这一按下去消失的东西比看到的多。
        */
        impact: `删掉这条日程，连同它派出去的 ${node.child_task_count ?? 0} 个子 Task`,
        transition: '在跑的先取消；子 Task 归档后删除（不可撤销）',
        reversible: false,
      },
      description: '连它派出去的子 Task 一起删掉',
    });
  } else if (node.type === 'archive') {
    commands.push({
      id: 'view-archive',
      label: '查看历史',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: '非 Schedule Task 的历史、结果和事件',
    });
  } else if (node.type === 'configuration') {
    commands.push({
      id: 'view-config',
      label: '查看配置资料',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: 'Executor Configuration、Extension、Capability manifest',
    });
    commands.push({
      id: 'diagnose-config',
      label: '诊断',
      type: 'view',
      highRisk: false,
      preview: READ_ONLY,
      description: 'Extension 诊断信息',
    });
  } else {
    commands.push(...commandsForResource(node));
  }

  // 进入 ChildScene 的入口由投影器提供，SceneRenderer 不根据业务类型写死
  if (options.canEnter) {
    commands.push({
      id: 'enter-scene',
      label: options.enterLabel,
      type: 'enter',
      highRisk: false,
      preview: {
        impact: '无（只是换一屏看）',
        transition: '不改变任何状态',
        reversible: true,
      },
      description: '进入局部场景',
    });
  }

  return {
    targetId: node.id,
    targetType: node.type,
    commands,
  };
}
