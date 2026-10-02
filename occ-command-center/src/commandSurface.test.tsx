/**
 * 操作牌与命令预览测试
 *
 * 对应 focus-leap.md 第 5 节操作矩阵与第 6 节命令预览：
 * - 只出现该对象真实允许的动作；
 * - 第一层不直接执行高风险命令；
 * - 高风险命令先预览、再确认；
 * - 回执只表示 accepted，不表示执行成功。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import App from './App';
import { useSceneStore } from './store/sceneStore';
import { useSelectionStore } from './store/selectionStore';
import { buildNodeCommands, commandsForTask, BACKEND_CAPABILITIES } from './lib/commandMatrix';
import { CommandSurface } from './components/overlay/CommandSurface';
import { executeScheduleCommand } from './lib/objectCommands';
import { tapNode } from './test/interactions';
import { sendGatewayCommand } from './api/gateway';
import type { ResourceNode, ScheduleNode, TaskNode } from './core/types/node';
import type { GatewayObject } from './api/gateway';
import type { Command } from './core/types/projection';

const baseTask = (over: Partial<TaskNode>): TaskNode => ({
  id: 't',
  type: 'task',
  label: 't',
  x: 0,
  y: 0,
  status: 'running',
  ...over,
});

describe('操作矩阵', () => {
  it('running 只提供查看与取消', () => {
    const ids = commandsForTask(baseTask({ status: 'running' })).map((c) => c.id);
    expect(ids).toContain('view-events');
    expect(ids).toContain('cancel');
    expect(ids).not.toContain('approve');
    expect(ids).not.toContain('deny');
  });

  it('paused + pending 提供批准、拒绝、查看等待原因', () => {
    const ids = commandsForTask(
      baseTask({ status: 'paused', approval_state: 'pending' })
    ).map((c) => c.id);
    expect(ids).toEqual(['view-waiting-reason', 'approve', 'deny']);
  });

  it('paused + approved 不提供拒绝', () => {
    const ids = commandsForTask(
      baseTask({ status: 'paused', approval_state: 'approved' })
    ).map((c) => c.id);
    expect(ids).not.toContain('deny');
    expect(ids).toContain('view-approval');
  });

  it('可能还有孤儿 worker 在外面跑时，不给「启动 Worker」', () => {
    // 重启之后 Controller 手里必然是空的，workerAlive 一定是 false；但外面那个
    // 进程可能还活着并持有同一条 LangGraph 线程。起第二个就有两个写者。
    const commands = commandsForTask(baseTask({ status: 'running' }), false, true);
    const ids = commands.map((c) => c.id);
    expect(ids).not.toContain('run');
    expect(ids).toContain('view-recovery');

    const note = commands.find((c) => c.id === 'view-recovery');
    expect(note?.description).toContain('确认');
  });

  it('没有孤儿嫌疑时，照旧给「启动 Worker」', () => {
    const ids = commandsForTask(baseTask({ status: 'running' }), false, false).map((c) => c.id);
    expect(ids).toContain('run');
    expect(ids).not.toContain('view-recovery');
  });

  it('paused + approved 必须留出路：取消与重试恢复', () => {
    // 自动恢复是后台路径，失败时没人告诉用户；而这个状态还被 attention 算作
    // 「亮灯」——把它标成待办却什么都不给做，任务就永久挂在中间态。
    const commands = commandsForTask(baseTask({ status: 'paused', approval_state: 'approved' }));
    const ids = commands.map((c) => c.id);

    expect(ids).toContain('cancel');
    expect(ids).toContain('retry-resume');

    const retry = commands.find((c) => c.id === 'retry-resume');
    // 复用 approve：每次 approve 都会重跑自动恢复，而 Core 在决定已相同时
    // 提前返回、不重复追加事件——所以重试安全，也不需要用户自己按 resume
    expect(retry?.type).toBe('approve');
    expect(retry?.highRisk).toBe(false);
    // 取消是不可逆的，必须走预览
    expect(commands.find((c) => c.id === 'cancel')?.highRisk).toBe(true);
  });

  it('失败确认在后端接口未就绪时标记不可用', () => {
    const acknowledge = commandsForTask(
      baseTask({ status: 'failed', acknowledged_failure: false })
    ).find((c) => c.id === 'acknowledge');

    expect(acknowledge).toBeDefined();
    if (!BACKEND_CAPABILITIES.acknowledge) {
      expect(acknowledge?.unavailable).toBe(true);
    }
  });

  it('不提供没有 Web 契约的操作（重试、暂停、重新分配）', () => {
    const ids = commandsForTask(baseTask({ status: 'running' })).map((c) => c.id);
    expect(ids).not.toContain('retry');
    expect(ids).not.toContain('pause');
    expect(ids).not.toContain('reassign');
  });

  it('running 且观测到没有 Worker 时才提供启动入口', () => {
    const running = baseTask({ status: 'running' });

    // 观测到 Worker 在跑：重复启动会被 Core 拒绝，界面不该给这个入口
    expect(commandsForTask(running, true).map((c) => c.id)).not.toContain('run');

    // 新建的 Task 就是 running 但还没有 Worker：这才是「启动」该出现的时候
    expect(commandsForTask(running, false).map((c) => c.id)).toContain('run');

    // 没有观测记录 = 未知：不提供大概率失败的入口
    expect(commandsForTask(running).map((c) => c.id)).not.toContain('run');
  });
});

describe('配置舱资料的操作牌', () => {
  /*
    真链路上的资料节点只有两样可操作的东西：`config`（配置状态那一行，开关走它）
    与 `owner`（所属包，编辑权限走它）。这里以前还有一族 `ability` 的用例
    （启动/停止/健康检查/模拟采样），**它们的夹具是手搓的**——`node.ability`
    在投影里没有任何地方被赋值，真链路给不出那种节点，所以那几条测的是
    一条永远走不到的支路。连着那段代码一起删了（`commandMatrix` 的说明记着经过）。
  */

  /** 一条配置状态的记录；只写这个用例关心的字段，其余给中性的默认值 */
  const objectRow = (activation: string): GatewayObject => ({
    object_ref: 'extension.weather',
    kind: 'package',
    activation,
    observed: '',
    health: '',
    source: 'seed',
    seed_value: true,
    last_error: '',
    diagnostic: null,
  });

  const resource = (over: Partial<ResourceNode> = {}): ResourceNode => ({
    type: 'resource',
    id: 'cap-001',
    resource_kind: 'capability',
    label: 'S3 Storage',
    x: 0,
    y: 0,
    ...over,
  });

  const ids = (node: ResourceNode) =>
    buildNodeCommands(node, { canEnter: false, enterLabel: '' }).commands.map((c) => c.id);

  it('没有配置状态那一行的资料只给「查看资料」', () => {
    expect(ids(resource())).toEqual(['view-resource']);
  });

  it('有配置状态那一行的资料给那条开关，方向按**当前**状态给', () => {
    const enabled = resource({ id: 'extension.weather', config: objectRow('enabled') });
    expect(ids(enabled)).toContain('config-disable');
    expect(ids(enabled)).not.toContain('config-enable');

    const disabled = resource({ id: 'extension.weather', config: objectRow('disabled') });
    expect(ids(disabled)).toContain('config-enable');
    expect(ids(disabled)).not.toContain('config-disable');
  });

  it('认不出的 activation 两个方向都不给', () => {
    // 不知道现在是什么，就无从说「相反」——按当前状态给反方向，前提是那个状态认得出
    expect(ids(resource({ config: objectRow('something-else') }))).toEqual(['view-resource']);
  });
});

describe('编排台的操作牌', () => {
  const scheduleNode: ScheduleNode = {
    id: 'weather.daily',
    type: 'schedule',
    label: '每日天气采集',
    x: 0,
    y: 0,
    aggregated_state: 'empty',
    enabled: true,
    child_task_count: 0,
  };

  it('给出立即触发与启停，且都先预览', () => {
    const commands = buildNodeCommands(scheduleNode, { canEnter: false, enterLabel: '' }).commands;
    expect(commands.map((c) => c.id)).toContain('trigger-schedule');
    expect(commands.find((c) => c.id === 'trigger-schedule')?.type).toBe('trigger');
    // 触发会真的创建并运行一个 Core Task，没有撤回契约
    expect(commands.find((c) => c.id === 'trigger-schedule')?.highRisk).toBe(true);
  });

  it('触发与删除各自映射到真实的后端命令', async () => {
    const effects = { impact: 'x', transition: 'y', reversible: false };
    const command = (type: Command['type']): Command =>
      ({ id: type, label: type, type, highRisk: true, preview: effects });
    const facts = { scheduleId: 'weather.daily', enabled: true };

    await executeScheduleCommand(command('trigger'), facts);
    expect(sendGatewayCommand)
      .toHaveBeenCalledWith('schedule.trigger', '', { name: 'weather.daily' });

    /*
      **删日程走 `schedule.delete`，不是 `manifest.delete`**：那条路只删文件,
      而子 Task 归这条日程管（外层看不见、馆里不装），声明一没它们就没有归属了。
      后端那条命令会把它们先处理掉（在跑的先取消 → 归档 → 删除）。
    */
    await executeScheduleCommand(command('delete-schedule'), facts);
    expect(sendGatewayCommand)
      .toHaveBeenCalledWith('schedule.delete', '', { name: 'weather.daily' });
  });

  it('启停不是一条命令名：它改的是声明里那一行', async () => {
    /*
      新模型里"关掉一条日程"就是改它那份声明里的一行，走的是那个开关
      （`set_enabled`）。从前这里有 `schedule.pause` / `schedule.resume`
      两条——后端已经没有它们了。

      这一条桩在 **HTTP 一层**：开关那条链整个跑在 `api/gateway.ts` 内部
      （`executeConfigCommand` → `setConfigEnabled` → `sendAccepted`），
      模块边界上的桩拦不住它（`configCabin.test.tsx` 的说明记着同一条教训）。
    */
    const sent: { command: string; payload: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        command: string; payload: Record<string, unknown>;
      };
      sent.push(request);
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
    }));
    const effects = { impact: 'x', transition: 'y', reversible: false };
    const toggle: Command = {
      id: 'toggle-schedule', label: '启停', type: 'toggle', highRisk: true, preview: effects,
    };

    // 现在开着 → 提交的是"关掉"；名字用的是**声明里那个名字**
    await executeScheduleCommand(toggle, { scheduleId: 'weather.daily', enabled: true });

    expect(sent.at(-1)?.command).toBe('set_enabled');
    expect(sent.at(-1)?.payload).toMatchObject({
      target: 'schedule', name: 'weather.daily', enabled: false,
    });
    vi.unstubAllGlobals();
  });
});

/**
 * 高风险命令的预览文案
 *
 * `ActionPreview` 曾经对认不出的命令兜底成「无字段变更 / 只读，不改变状态」，
 * 而当时一条 highRisk 的命令（旧模型里的 `ability-stop`，那条支路已经删了）
 * 正好吃了这套兜底——那句话是**假的**，而且盖在真正不可逆的操作上。
 * 现在文案由生成命令的地方填，缺失在类型上不可表达。
 */
describe('高风险命令的预览文案', () => {
  /** 配置类对象：有配置状态那一行，开关走 config.set_enabled */
  const configNode = (activation: string): ResourceNode => ({
    type: 'resource',
    id: 'extension.weather',
    resource_kind: 'extension',
    label: '天气',
    x: 0,
    y: 0,
    config: {
      object_ref: 'extension.weather',
      kind: 'package',
      activation,
      observed: 'online',
      health: 'ok',
      source: 'seed',
      seed_value: true,
      last_error: '',
      diagnostic: null,
    },
  });

  it('生成出来的每条高风险命令都带得出文案（空串也算没有）', () => {
    const scheduleNode: ScheduleNode = {
      id: 'weather.daily', type: 'schedule', label: '每日天气采集', x: 0, y: 0,
      aggregated_state: 'empty', enabled: true, child_task_count: 0,
    };
    const commands: Command[] = [
      ...commandsForTask(baseTask({ status: 'running' }), false),
      ...commandsForTask(baseTask({ status: 'paused', approval_state: 'pending' })),
      ...commandsForTask(baseTask({ status: 'paused', approval_state: 'approved' })),
      ...buildNodeCommands(scheduleNode, { canEnter: true, enterLabel: '进入' }).commands,
      ...buildNodeCommands(configNode('enabled'), { canEnter: false, enterLabel: '' }).commands,
    ];

    const risky = commands.filter((command) => command.highRisk);
    expect(risky.length).toBeGreaterThan(0);
    for (const command of risky) {
      expect(command.preview.impact.trim()).not.toBe('');
      expect(command.preview.transition.trim()).not.toBe('');
    }
  });

  it('「高风险但没有预览文案」在类型上不可表达', () => {
    // @ts-expect-error 高风险必须自带 preview——这一行**故意**不合法
    const missing: Command = { id: 'cancel', label: '取消', type: 'cancel', highRisk: true };
    expect(missing).toBeDefined();
  });

  it('停用一个配置对象说的是真话：字段、状态、可撤回', () => {
    const stop = buildNodeCommands(configNode('enabled'), { canEnter: false, enterLabel: '' })
      .commands.find((command) => command.id === 'config-disable');

    expect(stop?.type).toBe('config-disable');
    expect(stop?.highRisk).toBe(true);
    expect(stop?.preview.impact).toContain('activation: enabled → disabled');
    expect(stop?.preview.impact).not.toContain('无字段变更');
    // 反向命令就是「启用」，所以它可撤回；但它的后果必须写出来
    expect(stop?.preview.reversible).toBe(true);

    // 停用之后牌面给的是相反的那一个
    const enable = buildNodeCommands(configNode('disabled'), { canEnter: false, enterLabel: '' })
      .commands.find((command) => command.id === 'config-enable');
    expect(enable?.preview.impact).toContain('activation: disabled → enabled');
    expect(enable?.highRisk).toBe(false);
  });

  it('预览里显示的是命令自己的文案，不是按命令名兜底的默认值', () => {
    const model = buildNodeCommands(configNode('enabled'), { canEnter: false, enterLabel: '' });
    render(
      <CommandSurface
        targetLabel="天气"
        model={model}
        onExecute={() => ({ submitted: false })}
      />
    );

    fireEvent.click(screen.getByText('停用', { selector: 'button' }));

    expect(screen.getByText('命令预览')).toBeTruthy();
    expect(screen.getByText(/activation: enabled → disabled/)).toBeTruthy();
    // 兜底过的那两句话一句都不该出现
    expect(screen.queryByText('无字段变更')).toBeNull();
    expect(screen.queryByText('只读，不改变状态')).toBeNull();
  });
});

describe('操作牌交互', () => {
  it('选中运行中的 Task 出现操作牌，取消命令需要先预览', async () => {
    useSceneStore.setState({
      stack: [
        {
          sceneId: 'world',
          focusId: '',
          viewport: { zoom: 1, pan: { x: 0, y: 0 } },
          selection: { selectedNodeId: null },
        },
      ],
      currentScene: 'world',
      isTransitioning: false,
    });
    useSelectionStore.setState({ selectedNodeId: null });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      render(<App />);
    });
    errorSpy.mockRestore();

    expect(document.querySelector('.react-flow__node[data-id="task-001"]')).toBeTruthy();

    // 用手指/鼠标的完整指针序列选中：单击选中走的是 pointer 判定，不是裸 click
    await act(async () => {
      tapNode('task-001');
    });

    // 操作牌出现，且只列出真实允许的动作
    expect(screen.getByText('操作牌')).toBeTruthy();
    const cancelButton = screen.getByText('取消', { selector: 'button' });

    await act(async () => {
      fireEvent.click(cancelButton);
    });

    // 高风险命令先进入预览，而不是直接提交
    expect(screen.getByText('命令预览')).toBeTruthy();
    expect(screen.getByText('不可撤回')).toBeTruthy();

    const confirm = screen.getByText('确认提交', { selector: 'button' });
    await act(async () => {
      fireEvent.click(confirm);
    });

    // 回执只表示 accepted
    expect(screen.getByText('accepted')).toBeTruthy();
    expect(screen.queryByText('命令预览')).toBeNull();
  });

  it('提交失败显示原因，不显示「Core 已接受」', async () => {
    vi.mocked(sendGatewayCommand).mockRejectedValueOnce(
      new Error('Task 状态 cancelled 不能取消')
    );

    useSceneStore.setState({
      stack: [
        {
          sceneId: 'world',
          focusId: '',
          viewport: { zoom: 1, pan: { x: 0, y: 0 } },
          selection: { selectedNodeId: null },
        },
      ],
      currentScene: 'world',
      isTransitioning: false,
    });
    useSelectionStore.setState({ selectedNodeId: null });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      render(<App />);
    });
    errorSpy.mockRestore();

    await act(async () => {
      tapNode('task-001');
    });
    await act(async () => {
      fireEvent.click(screen.getByText('取消', { selector: 'button' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('确认提交', { selector: 'button' }));
    });

    // 失败必须说清楚失败：提交失败也提示「已接受」是在编造事实
    expect(screen.getByText('rejected')).toBeTruthy();
    expect(screen.getByText(/未提交：Task 状态 cancelled 不能取消/)).toBeTruthy();
    expect(screen.queryByText('accepted')).toBeNull();
  });
});

describe('只读命令（view）', () => {
  it('走 onView，不走 onExecute —— 它们本来就没有后端命令', () => {
    /*
      现场：「查看结果」按下去什么都不发生。根因是它落到 `submit` → `onExecute`
      → `executeTaskCommand` → `resolveTaskCommand`，而后者对 view 命令返回 null，
      于是拿到 `{submitted:false}` 静默返回——按钮看着能点，既没有浮窗也没有回执。

      它们和"提交一条命令"是两回事：读的是已经在本地的数据，由调用方去开浮窗。
    */
    const onView = vi.fn();
    const onExecute = vi.fn();
    const task = baseTask({ status: 'succeeded' });

    render(
      <CommandSurface
        model={{ targetId: 't', targetType: 'task', commands: commandsForTask(task) }}
        onView={onView}
        onExecute={onExecute}
      />,
    );

    fireEvent.click(screen.getByText('查看结果', { selector: 'button' }));

    expect(onView).toHaveBeenCalledTimes(1);
    expect((onView.mock.calls[0][0] as Command).id).toBe('view-result');
    // 关键：没有把它当成一条后端命令提交出去
    expect(onExecute).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  // 用例里用 mockRejectedValueOnce 造失败，队列不能漏到下一个用例
  vi.mocked(sendGatewayCommand).mockClear();
});
