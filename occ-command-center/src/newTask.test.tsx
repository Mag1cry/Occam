/**
 * 新建任务入口测试
 *
 * 这件事曾经是原型本地提交（只写本地草稿），现在必须是真实 Core 命令：
 * 节点由重新读取的快照产生，前端不预置任何 Task。
 *
 * 这里 stub 的是 `fetch`，不是 `sendGatewayCommand`：`createTask` /
 * `startTask` 在模块内部调用后者，桩在模块边界上拦不住它。打桩打到
 * HTTP 一层，测到的才是真正会跑的那段代码。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { NewTaskOverlay } from './components/overlay/NewTaskOverlay';
import { useLayoutStore } from './store/layoutStore';
import { executeTaskCommand } from './lib/objectCommands';
import { sendGatewayCommand, type GatewaySnapshot } from './api/gateway';
import { buildMockSnapshot } from './mock/snapshot';
import type { Command } from './core/types/projection';

/**
 * 任务层的执行者列表来自**快照**（硬编码执行者 ∪ 智能体），不是一份手写的目录：
 * 夹具就是后端那条链路的输入，测到的才是运行时真的会看到的列表。
 */
const SNAPSHOT = buildMockSnapshot();

/** 夹具里唯一的硬编码执行者（没有模型段、归 localFunction 的那种） */
const HARDCODED = 'config-004';
/**
 * 夹具里那个智能体**执行者的名字**
 *
 * 就是它：`Task.executor_ref` 存的是这个，后端 `registry.executors.get()` 认的
 * 也是这个。`agent:<id>` 是旧后端的拼法，送过去会被判「没有这个执行者」。
 */
const AGENT = 'ops';

/** 记录每一次网关命令：断言用的是命令名与载荷，不是调用次数 */
function stubGateway(responses: Record<string, { status?: number; body: unknown }>) {
  const calls: { command: string; taskId: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    // **命令面只有两个字段**：命令名 + 载荷（`task_id` 是载荷的一部分）
    const request = JSON.parse(String(init?.body ?? '{}')) as {
      command: string;
      payload?: Record<string, unknown>;
    };
    const payload = request.payload ?? {};
    calls.push({ command: request.command, taskId: String(payload.task_id ?? ''), payload });
    const response = responses[request.command] ?? { body: { ok: true, data: {} } };
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      json: async () => response.body,
    };
  }));
  return calls;
}

function renderOverlay(onClose: () => void = () => {}, snapshot: GatewaySnapshot = SNAPSHOT) {
  render(<NewTaskOverlay initialPosition={{ x: 10, y: 20 }} snapshot={snapshot} onClose={onClose} />);
}

function fillForm() {
  fireEvent.change(screen.getByPlaceholderText('例如：查一下今天的天气'), {
    target: { value: '查一下今天的天气' },
  });
  fireEvent.change(screen.getByPlaceholderText('工作区内的文件，例如 inputs/weather-now.md'), {
    target: { value: 'inputs/weather-now.md' },
  });
}

const submit = async (label: string) => {
  await act(async () => {
    fireEvent.click(screen.getByText(label, { selector: 'button' }));
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 目标字段的归属是后端定的，挪一格就变成「Task 不存在」——
 * 这条真的发生过一次看似无害的重构里，所以钉在网关调用上。
 */
describe('命令目标的落点', () => {
  const approve: Command = {
    id: 'approve', label: '批准', type: 'approve', highRisk: true,
    preview: { impact: 'x', transition: 'y', reversible: false },
  };

  it('Task 命令的目标走 task_id，不走 payload', async () => {
    vi.mocked(sendGatewayCommand).mockClear();
    await executeTaskCommand(approve, 'task-123');
    expect(vi.mocked(sendGatewayCommand).mock.calls[0]).toEqual(['approve', 'task-123', {}]);
  });

  it('没有目标的命令不提交', async () => {
    vi.mocked(sendGatewayCommand).mockClear();
    await expect(executeTaskCommand(approve, '')).resolves.toEqual({ submitted: false });
    expect(vi.mocked(sendGatewayCommand)).not.toHaveBeenCalled();
  });

  /*
    审批是 200 + accepted，所以「批准记下了，但自动恢复没做成」只可能从 body 里
    读出来。丢掉它，用户就会以为批准生效了，然后看着任务卡在 paused + approved。
    它不能变成 ok:false——批准这个事实确实发生了。
  */
  it('自动恢复失败时，回执带出后端说的原因', async () => {
    vi.mocked(sendGatewayCommand).mockResolvedValueOnce({
      accepted: true,
      command_result: null,
      error: '',
      data: { auto_resume: { status: 'failed', error: 'checkpoint 不存在' } },
    });
    await expect(executeTaskCommand(approve, 'task-1')).resolves.toEqual({
      submitted: true,
      ok: true,
      warning: '自动恢复没有完成：checkpoint 不存在',
    });
  });

  it('skipped 同样意味着还停在 paused，也要说', async () => {
    vi.mocked(sendGatewayCommand).mockResolvedValueOnce({
      accepted: true,
      command_result: null,
      error: '',
      data: { auto_resume: { status: 'skipped', reason: 'Task 不在等待恢复的状态' } },
    });
    const outcome = await executeTaskCommand(approve, 'task-1');
    expect(outcome).toEqual({
      submitted: true,
      ok: true,
      warning: '自动恢复没有完成：Task 不在等待恢复的状态',
    });
  });

  it('恢复成功、或这条命令根本没有自动恢复，回执都是干净的', async () => {
    vi.mocked(sendGatewayCommand).mockResolvedValueOnce({
      accepted: true,
      command_result: null,
      error: '',
      data: { auto_resume: { status: 'resumed', checkpoint_ref: 'cp-1' } },
    });
    await expect(executeTaskCommand(approve, 'task-1')).resolves.toEqual({ submitted: true, ok: true });

    vi.mocked(sendGatewayCommand).mockResolvedValueOnce({
      accepted: true, command_result: null, error: '', data: {},
    });
    await expect(executeTaskCommand(approve, 'task-1')).resolves.toEqual({ submitted: true, ok: true });
  });
});

describe('新建任务', () => {
  it('执行者列表 = 硬编码执行者 ∪ 智能体，模型不在这一层', () => {
    renderOverlay();
    const select = screen.getByLabelText('执行者') as HTMLSelectElement;

    // 两组：硬编码函数与智能体（ADR-026 的对象坐标）
    expect(Array.from(select.querySelectorAll('optgroup')).map((group) => group.label)).toEqual([
      '硬编码执行者',
      '智能体',
    ]);
    // 提交值就是执行者的名字：硬编码执行者用它自己的，智能体也是
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      HARDCODED,
      AGENT,
      'payments',
    ]);

    // 模型一个都不在这一层：它们下沉成智能体的属性了
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).not.toContain('config-001');
    expect(values.some((value) => value.startsWith('uniapi:'))).toBe(false);
  });

  it('选智能体后提交的是**执行者的名字**，不是配置状态的键', async () => {
    const calls = stubGateway({
      create_task: { body: { ok: true, data: { task_id: 'task-swapped' } } },
    });

    renderOverlay();
    fireEvent.change(screen.getByLabelText('执行者'), { target: { value: AGENT } });

    fillForm();
    await submit('创建并启动');

    // 两种拼法指同一个对象，但 Task 里存的是**冒号**那种（agent.<id> 是配置键）
    expect(calls[0].payload).toEqual({
      summary: '查一下今天的天气',
      task_ref: 'inputs/weather-now.md',
      executor_ref: AGENT,
    });
    // 分组只是展示轴：它一个字段都不该出现在载荷里
    expect(Object.keys(calls[0].payload).sort()).toEqual([
      'executor_ref',
      'summary',
      'task_ref',
    ]);
  });

  it('快照里没有执行者时不能提交', () => {
    renderOverlay(() => {}, { ...SNAPSHOT, executors: [], agents: [] });
    // 一个可选项都没有时给一句实话，而不是一列假的空组
    const select = screen.getByLabelText('执行者') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      '没有可用的执行者',
    ]);
    expect(screen.getByText('创建并启动', { selector: 'button' })).toHaveProperty('disabled', true);
  });

  it('「创建并启动」提交真实的 create_task 与 start_task', async () => {
    const close = vi.fn();
    const calls = stubGateway({
      create_task: { body: { ok: true, data: { task_id: 'task-new' } } },
    });

    renderOverlay(close);
    fillForm();
    await submit('创建并启动');

    expect(calls[0]).toEqual({
      command: 'create_task',
      taskId: '',
      payload: {
        summary: '查一下今天的天气',
        task_ref: 'inputs/weather-now.md',
        executor_ref: HARDCODED,
      },
    });
    // 启动用的是后端返回的 ID，不是前端猜的
    expect(calls[1]).toEqual({ command: 'start_task', taskId: 'task-new', payload: { task_id: 'task-new' } });
    // 菜单位置只进布局记忆，不写进 Task 字段
    expect(useLayoutStore.getState().getPosition('world', 'task-new')).toEqual({ x: 10, y: 20 });
    expect(close).toHaveBeenCalled();
  });

  it('「仅创建」不启动 Worker', async () => {
    const calls = stubGateway({
      create_task: { body: { accepted: true, command_result: { task_id: 'task-only' } } },
    });

    renderOverlay();
    fillForm();
    await submit('仅创建');

    expect(calls.map((call) => call.command)).toEqual(['create_task']);
  });

  it('后端没回 task_id 时如实报错，不编一个 ID 继续', async () => {
    const close = vi.fn();
    stubGateway({ create_task: { body: { accepted: true, data: {} } } });

    renderOverlay(close);
    fillForm();
    await submit('创建并启动');

    expect(screen.getByText(/提交失败：create_task 已被接受，但后端没有返回 task_id/)).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
  });

  it('提交失败时显示后端给的原因', async () => {
    const close = vi.fn();
    stubGateway({
      create_task: { status: 404, body: { detail: '执行者配置不存在: nope' } },
    });

    renderOverlay(close);
    fillForm();
    await submit('创建并启动');

    expect(screen.getByText(/提交失败：执行者配置不存在: nope/)).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
  });

  it('输入引用可以缺省：后端本来就不要它', () => {
    /*
      `tasks/inputs.py::read` 第一行是 `if not task_ref: return ""`，docstring 写着
      "不是每个执行者都要一份正文"。界面以前把它做成必填——**比后端更严**，
      逼着固定代码的执行者（`weather.collect` 那种，城市来自配置、根本不看正文）
      也编一个文件名出来。而那个名字读不到时，`inputs.read` 会在起进程**之前**
      把这次运行收成 failed：编一个不存在的名字，比留空更糟。
    */
    renderOverlay();
    fireEvent.change(screen.getByPlaceholderText('例如：查一下今天的天气'), {
      target: { value: '只有摘要' },
    });
    expect(screen.getByText('创建并启动', { selector: 'button' })).toHaveProperty('disabled', false);
  });

  it('摘要还空着时，按钮旁边说清还差什么', () => {
    // 禁用的按钮不会再弹任何东西，所以原因必须一直看得见（R-001）
    renderOverlay();
    expect(screen.getByText(/还差：/).textContent).toContain('委托摘要');
  });
});
