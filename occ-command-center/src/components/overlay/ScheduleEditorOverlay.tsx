/**
 * ScheduleEditorOverlay —— 日程的**创建与编辑**（同一张表单）
 *
 * 一张日程是 `extensions/_schedules/<文件>.yaml`：规则、时区、输入引用、执行者。
 * 四条里**只有名字不给改**——它是身份，不是标题（见 `upsertSchedule` 的说明）。
 * 所以编辑时表单上没有「日程 ID」那一格，标题里带着它。
 *
 * ## 输入引用**可以留空**（和新建任务那一格同一条规矩）
 *
 * 后端本来就是这样：`tasks/inputs.py::read` 的第一行是 `if not task_ref: return ""`。
 * 写错路径的代价是**派发时那一次不起**（`InputMissing` → 一条 FAILED），
 * 而"编一个不存在的文件名"比留空更糟——那会每次都失败。
 *
 * ## 表单本身是公用的那一张
 *
 * `ActionFormOverlay` 只负责收参数与必填校验，不认识"日程"。这里做的是**把日程
 * 翻译成一列字段**，以及提交之后重读快照——节点由快照产生，前端不预置。
 */
import { ActionFormOverlay } from './ActionFormOverlay';
import { upsertSchedule, type GatewaySchedule, type GatewaySnapshot } from '../../api/gateway';
import { firstRunnableExecutor, groupExecutorsByProvider } from '../../lib/executorGroups';
import { useGatewayStore } from '../../store/gatewayStore';

export interface ScheduleEditorOverlayProps {
  /** 要改的那条日程；**null 表示新建** */
  schedule: GatewaySchedule | null;
  /** 后端网关快照：执行者目录与默认值都从它读 */
  snapshot: GatewaySnapshot;
  onClose: () => void;
}

export function ScheduleEditorOverlay({ schedule, snapshot, onClose }: ScheduleEditorOverlayProps) {
  const load = useGatewayStore((state) => state.load);
  const creating = schedule === null;
  const executors = snapshot.executors ?? [];

  return (
    <ActionFormOverlay
      title={creating ? '新建日程' : '编辑日程'}
      description={creating
        ? '规则是 5 段 cron；到点后由调度器派发成真实 Core Task'
        : `${schedule.schedule_id}——名字是身份，不给改；改的是它那份声明里的几行`}
      command={creating ? 'manifest.create' : 'manifest.write'}
      submitLabel={creating ? '创建日程' : '保存'}
      onClose={onClose}
      fields={[
        // 名字只在新建时问：它是文件名、引用名，也是配置状态的键
        ...(creating
          ? [{
              name: 'schedule_id',
              label: '日程 ID',
              placeholder: 'daily-report',
              required: true,
              hint: '建出来之后不再改——派发记录和子 Task 的归属都按它走',
            }]
          : []),
        {
          name: 'cron',
          label: '规则（cron）',
          placeholder: '0 9 * * *',
          required: true,
          defaultValue: schedule?.cron ?? '',
          hint: '分 时 日 月 周，例如 `0 9 * * *` = 每天 09:00',
        },
        {
          name: 'timezone',
          label: '时区',
          defaultValue: schedule?.timezone || 'Asia/Shanghai',
          hint: 'Windows 上的可用值由后端校验',
        },
        {
          name: 'executor_config_ref',
          label: '执行者配置',
          required: true,
          // 默认落在**能跑的第一条**上：目录里第一条是基座 `langgraph.agent`，
          // 它要模型而没有人给它配——默认落在它上面等于让人一提交就被拒
          defaultValue: schedule?.executor_config_ref || firstRunnableExecutor(executors),
          groupsLabel: '供应商',
          groups: groupExecutorsByProvider(executors),
        },
        {
          name: 'task_ref',
          label: '输入引用（可留空）',
          placeholder: 'inputs/daily-report.md',
          defaultValue: schedule?.task_ref ?? '',
          // 旁边给一个「选择文件」：手打与选择两种填法都留着
          workspaceFile: true,
          /*
            **可以留空——和新建任务那一格同一条规矩**（`NewTaskOverlay`）。
            后端本来就是这样：`tasks/inputs.py::read` 的第一行是
            `if not task_ref: return ""`，docstring 写的是"不是每个执行者都要一份正文"。

            界面这一格以前是**必填**，比后端更严：固定代码的执行者（`weather.collect`
            那种，城市来自配置的旋钮、根本不看正文）也被逼着编一个文件名出来——
            而 `inputs.read` 在起进程**之前**就读它，读不到会把这次运行当场收成
            `failed`。也就是说，**编一个不存在的文件名比留空更糟**。
          */
          hint: '工作区内的文件；留空 = 没有正文（固定代码的执行者不看它）。'
            + '「选择文件」是从你的电脑上挑一份**放进来**（重名自动加序号）；'
            + '写错路径的话，派发时那次运行不会起起来，编排台里留一条失败',
        },
      ]}
      onSubmit={async (values) => {
        await upsertSchedule({
          // 编辑时用**声明里那个名字**，不是表单里那一格（编辑时根本没有那一格）
          scheduleId: creating ? values.schedule_id.trim() : schedule.schedule_id,
          cron: values.cron.trim(),
          timezone: values.timezone.trim() || 'UTC',
          taskRef: values.task_ref.trim(),
          executorRef: values.executor_config_ref,
          creating,
        });
        // 提交成功不等于节点已经变了：那条日程由重读的快照呈现
        await load();
      }}
    />
  );
}
