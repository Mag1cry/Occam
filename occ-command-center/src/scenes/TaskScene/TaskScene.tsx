/**
 * TaskScene
 *
 * Task 局部世界。它和后三类场景不是同一类东西：
 * 编排台 / 档案馆 / 配置舱是**子图**（父对象 → 子节点 + 真实关系），
 * Task 是**焦点场景**——`rendering-architecture.md` 的命名约定把
 * 「Task Focus」和「后三类子图」明确分开。所以这里没有画布、没有节点、
 * 没有连线，`uses` / `awaits` 也不画成边。
 *
 * 布局：一块铺满全屏的信息面
 *
 *   标题行：状态环 · 任务名 · 状态胶囊 · 持续时间 · 真实引用 · Controller 观测
 *   ══ Agent Audit / Core Event Log ══
 *      人机交互：一条记录一张卡，横向翻页，身份标在卡片下方
 *      （顶栏内边距避开顶部 HUD）
 *
 * 视觉与整站同源（见 index.css）：近黑中性面 + 青色强调 + 小字号密集排版。
 *
 * 硬边界：
 * - 不显示 Worker 节点、Controller 进程节点、checkpoint 内部节点、
 *   Agent 思考节点和 Configuration → Capability 虚假连线；
 * - Core Event Log 与 Agent Audit 是两条来源不同的信息线，不混成一条事件带；
 * - Controller Observation 是徽标，不是节点；
 * - 卡片内容只来自审计投影，不从 Core Event 拼出参数、结果或流程。
 */

import { useEffect, useMemo, useState } from 'react';
import { projectTaskScene } from '../../core/projection/TaskProjection';
import { CommandSurface } from '../../components/overlay/CommandSurface';
import { TaskResultOverlay } from '../../components/overlay/TaskResultOverlay';
import { AgentAuditPanel } from '../../components/audit/AgentAuditPanel';
import { GlassPanel } from '../../components/ui/GlassPanel';
import { StateRing } from '../../components/nodes/StateRing';
import { ReferencePlaceholder } from '../../components/ui/ReferencePlaceholder';
import { buildNodeCommands } from '../../lib/commandMatrix';
import { deriveStateRing } from '../../lib/stateRing';
import { BackendCapabilityNotice } from '../../components/overlay/BackendCapabilityNotice';
import { useTransitionStore } from '../../store/transitionStore';
import { useGatewayStore } from '../../store/gatewayStore';
import { executorCatalog } from '../../core/projection/executorCatalog';
import { executeTaskCommand } from '../../lib/objectCommands';
import {
  getAgentAudit,
  getTaskResult,
  workerAliveOf,
  workerUnreconciledOf,
  type AgentAudit,
  type GatewaySnapshot,
  type TaskResult,
} from '../../api/gateway';

export interface TaskSceneProps {
  taskId: string;
  /** 后端网关快照：由 SceneRenderer 保证存在，场景自己不兜底 */
  snapshot: GatewaySnapshot;
}

/**
 * 顶部安全区
 *
 * HUD 是顶部中央的 fixed Overlay（top 20 + 胶囊高度）。信息面从这里往下排，
 * 时间线因此不会被 HUD 盖住。
 */
const AUDIT_TOP_INSET = 88;

/** 底部安全区：给操作牌留出位置，卡片不钻到它下面 */
const AUDIT_BOTTOM_INSET = 104;

/**
 * 事实胶囊
 *
 * occ-web 的读法：淡色底 + 同色淡描边 + 等宽数值，字号 11px。
 */
function MetaChip({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warning' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-md border whitespace-nowrap ${
        tone === 'warning'
          ? 'border-occ-warn/30 bg-occ-warn/10 text-occ-warn'
          : 'border-white/10 bg-white/[0.04] text-slate-400'
      }`}
    >
      {label}
      <span className={`num ${tone === 'warning' ? 'text-occ-warn' : 'text-slate-200'}`}>
        {value}
      </span>
    </span>
  );
}

export function TaskScene({ taskId, snapshot }: TaskSceneProps) {
  // 转场期间冻结操作牌；本场景不发起进入，只读飞行标记
  const isFlying = useTransitionStore((state) => state.flying);
  const load = useGatewayStore((state) => state.load);

  const model = useMemo(
    () => projectTaskScene(taskId, {
      tasks: snapshot.tasks,
      events: snapshot.events,
      snapshot,
    }),
    [taskId, snapshot]
  );

  /*
    解析得到时用人读名称（`display_name`，与配置舱共用同一条取值链）；
    解析不到时**没有名字可给**——那时显示的是最小占位，不是某个替代对象。
  */
  const executorNode = useMemo(
    () => model.executor?.state === 'resolvable'
      ? executorCatalog(snapshot).find((node) => node.id === model.executor?.ref) ?? null
      : null,
    [model.executor, snapshot]
  );

  const status = model.task?.status;

  /**
   * 执行结果
   *
   * 只有在任务进入终态之后才去读：运行中读不到东西，还会每次刷新都多打一次。
   * 读不到就什么都不显示——不用「暂无结果」占位，也不从事件里拼一个出来。
   *
   * 结果连 taskId 一起存在 state 里，渲染时核对：切换对象时旧结果自然失效，
   * 不需要在 effect 里同步清空（那会多触发一轮渲染）。
   */
  const [loadedResult, setLoadedResult] = useState<{ taskId: string; result: TaskResult | null } | null>(null);
  useEffect(() => {
    if (status !== 'succeeded' && status !== 'failed') return;
    let cancelled = false;
    getTaskResult(taskId)
      .then((value) => { if (!cancelled) setLoadedResult({ taskId, result: value }); })
      .catch(() => { if (!cancelled) setLoadedResult({ taskId, result: null }); });
    return () => { cancelled = true; };
  }, [taskId, status]);

  /**
   * Agent 执行过程（审计投影）
   *
   * 它在执行者外围的 checkpoint 里，不在快照里，所以按需读。Core 状态每变一次
   * 就重读一次：审批、恢复、完成这些时点正是 Agent 又走了一步的时候。
   *
   * 已知边界：它**不轮询**。执行中连续调用多个工具时，这一屏读的是上一次
   * Core 状态变化时的样子；切走再回来会重新读。
   */
  const [loadedAudit, setLoadedAudit] = useState<{ taskId: string; value: AgentAudit | null } | null>(null);
  const stateVersion = model.task?.state_version;
  useEffect(() => {
    let cancelled = false;
    getAgentAudit(taskId)
      .then((value) => { if (!cancelled) setLoadedAudit({ taskId, value }); })
      .catch(() => { if (!cancelled) setLoadedAudit({ taskId, value: null }); });
    return () => { cancelled = true; };
  }, [taskId, status, stateVersion]);

  /** 操作牌上按下的那条只读命令的 id。`null` 表示没有浮窗开着 */
  const [openView, setOpenView] = useState<string | null>(null);

  if (!model.task) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <GlassPanel className="px-6 py-4">
          <div className="text-sm text-gray-300">对象不可用</div>
          <div className="text-xs text-gray-500 mt-1">
            没有对应的 Core Task —— 不伪造替代对象
          </div>
        </GlassPanel>
      </div>
    );
  }

  const task = model.task;
  const workerAlive = workerAliveOf(snapshot, taskId);
  const workerUnreconciled = workerUnreconciledOf(snapshot, taskId);
  const result = loadedResult?.taskId === taskId ? loadedResult.result : null;
  const audit = loadedAudit?.taskId === taskId ? loadedAudit.value : null;

  /*
    操作牌上那几条只读的（`type === 'view'`）**没有后端命令**——`resolveTaskCommand`
    对它们返回 null，走 `onExecute` 只会静默返回，所以以前按下去什么都不会发生。
    它们由 `onView` 接住，在这里开浮窗。

    「查看结果」那条已经接上了；「查看事件」还没接（它要切的是下面那个 tab 的事，
    和浮窗不是一回事），所以它仍旧什么都不做——**这是已知的，不是遗漏**。
  */
  const viewingResult = openView === 'view-result';

  const stateRing = deriveStateRing({
    status: task.status,
    pending_decision: Boolean(task.pending_decision),
    approval_state: task.approval_state,
    acknowledged_failure: task.acknowledged_failure,
  });

  return (
    <div className="relative w-full h-full">
      {/* 全屏信息面：审计页是完整的人机交互 */}
      <div
        data-task-audit-surface
        className="fixed inset-0 z-20 flex flex-col gap-3 px-5 overflow-hidden"
        style={{ paddingTop: AUDIT_TOP_INSET, paddingBottom: AUDIT_BOTTOM_INSET }}
      >
        {/* 标题区：状态环 + 任务名 + 事实胶囊（occ-web 的小字号密集语言） */}
        <div className="shrink-0 flex items-start gap-3">
          <div className="pt-0.5 shrink-0">
            <StateRing shape={stateRing.shape} color={stateRing.color} size={26} />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-[15px] font-semibold text-slate-100 truncate">
                {task.label}
              </h1>

              <span
                className="text-[12px] px-2 py-0.5 rounded-md border"
                style={{
                  color: stateRing.color,
                  borderColor: `${stateRing.color}55`,
                  background: `${stateRing.color}14`,
                }}
              >
                {stateRing.label}
              </span>

              {task.duration !== undefined && (
                <span className="num text-[11px] px-2 py-0.5 rounded-md border border-white/10 bg-white/[0.04] text-slate-300">
                  已持续 {Math.floor(task.duration / 60)} 分钟
                </span>
              )}

              {/*
                真实引用：来自真实字段，不是节点。

                解析得到就显示它的名字；解析不到就给**最小占位**（引用 + 已下线/未知
                + 原因），绝不换成一个看起来正常的对象，也不干脆不显示——一条历史记录
                引用了一个已下线的执行者，是必须说得出来的事实。
              */}
              {executorNode && <MetaChip label="Executor" value={executorNode.label} />}
              {model.executor && !executorNode && (
                <ReferencePlaceholder view={model.executor} role="Executor" />
              )}
              {model.pendingToolId && (
                <MetaChip label="pending" value={model.pendingToolId} tone="warning" />
              )}

              {/*
                Controller Observation 是徽标，不是节点，也**不是** Task 状态：
                Worker 活着不等于任务成功。没有观测记录时显示未知。
              */}
              <MetaChip
                label="Controller 观测"
                value={
                  workerAlive === undefined
                    ? '未知'
                    : workerAlive
                      ? 'Worker 运行中'
                      : 'Worker 未运行'
                }
              />
            </div>

            {task.delegation_summary && (
              <p className="text-[11px] text-slate-400 mt-1.5 truncate">
                {task.delegation_summary}
              </p>
            )}
          </div>
        </div>

        {/* 执行结果：按需读单个 Task，不进全局快照 */}
        {result && (
          <div className="shrink-0 rounded-xl border border-occ-accent/25 bg-occ-accent/[0.05] px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="label">执行结果</span>
              {result.structured && (
                <span className="text-[10px] text-slate-500">结构化返回，以下是原文</span>
              )}
            </div>
            <div
              className={`mt-1 max-h-[132px] overflow-auto text-[12px] text-slate-200 ${
                result.structured ? 'num whitespace-pre' : 'whitespace-pre-wrap'
              }`}
            >
              {result.text}
            </div>
          </div>
        )}

        <AgentAuditPanel
          events={model.events}
          /* 完整的人机交互——工具调用在这条序列里面，不单列 */
          turns={audit?.turns ?? []}
          auditAvailable={audit?.available ?? false}
          /*
            形状由**后端那句 `kind`** 定（智能体多卡 / 固定代码单卡），前端不自己
            从执行者列表推——那是第二条推导路径，会漂。还没读到时给 `undefined`，
            面板会说"正在读取"，而不是先替用户下一个结论再改口。
          */
          kind={audit?.kind}
          plain={{
            summary: task.delegation_summary ?? '',
            output: result?.text ?? '',
            // 卡片下方那一行写谁跑的；解析不到时 `PlainCallCard` 自己会说"这一次运行"
            executorLabel: executorNode?.label ?? model.executor?.ref ?? '',
          }}
        />
      </div>

      <BackendCapabilityNotice />

      {/* 操作牌由焦点对象当前事实生成，不常驻按钮列 */}
      {!isFlying && (
        <CommandSurface
          targetLabel={task.label}
          model={buildNodeCommands(task, {
            canEnter: false,
            enterLabel: '进入局部场景',
            workerAlive,
            workerUnreconciled,
            // **归档是"外面"的动作**：跑完的 Task 在这儿（和世界里）收进档案馆，
            // 收进去之后才有「删除」可给——那一步在馆里
            historyAction: 'archive',
          })}
          stateVersion={
            task.state_version !== undefined ? `state-${task.state_version}` : undefined
          }
          onExecute={async (command) => {
            const outcome = await executeTaskCommand(command, taskId);
            // 提交成功只表示 Core 已接收：真实状态以重读的对象与事件为准
            if (outcome.submitted && outcome.ok) void load();
            return outcome;
          }}
          onView={(command) => setOpenView(command.id)}
        />
      )}

      {/*
        浮窗**不跟着 `isFlying` 收**：它是"我在读这份东西"，
        和"画布正在飞"是两件事——读一半被收掉比工具栏消失难受得多。
      */}
      {viewingResult && (
        <TaskResultOverlay
          taskId={taskId}
          subtitle={`${task.label} · ${taskId}`}
          onClose={() => setOpenView(null)}
        />
      )}
    </div>
  );
}
