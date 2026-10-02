/**
 * 日程的创建与编辑
 *
 * **同一张表单**（`ScheduleEditorOverlay`），差别只有一个：新建时问「日程 ID」，
 * 编辑时那一格**不出现**——名字是身份，不是标题（`upsertSchedule` 里那段说明）。
 *
 * 两条路走的都是声明那几条命令：新建 `manifest.create`（一个文件），
 * 编辑是**一栏一条 `manifest.write`**（后端的 `set_field` 一次只改一栏）。
 *
 * 这里渲染的是**真组件**。第一版这个文件把字段表抄了一份贴在测试里——那样测的是
 * 抄件，不是表单：表单少一格、必填少一个，测试照绿。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ScheduleEditorOverlay } from './components/overlay/ScheduleEditorOverlay';
import { WorldScene } from './scenes/WorldScene/WorldScene';
import { buildMockSnapshot } from './mock/snapshot';
import { sendGatewayCommand } from './api/gateway';
import { tapNode } from './test/interactions';
import { useLayoutStore } from './store/layoutStore';
import { useSelectionStore } from './store/selectionStore';
import type { GatewayExecutor, GatewaySchedule, GatewaySnapshot } from './api/gateway';

const SNAPSHOT = buildMockSnapshot();

/** 夹具里那条日程（名字在声明里、和文件名可以不同） */
const EXISTING: GatewaySchedule = {
  schedule_id: 'weather.daily',
  cron: '0 8 * * *',
  timezone: 'Asia/Shanghai',
  task_ref: 'inputs/weather-daily.md',
  executor_config_ref: 'config-002',
  enabled: true,
};

/**
 * 记录每一次网关命令
 *
 * 桩打在 **HTTP 一层**：组件内部那条链（overlay → `upsertSchedule` →
 * `sendGatewayCommand`）在自己模块里调用，模块边界的桩拦不住
 * （`configCabin.test.tsx` 的说明记着同一条教训）。
 */
function stubGateway(responses: Record<string, unknown> = {}) {
  const calls: { command: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    // 没有 body 的是快照重读（提交成功之后组件会 `load()` 一次）
    if (!init?.body) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
    }
    const request = JSON.parse(String(init.body)) as {
      command: string;
      payload?: Record<string, unknown>;
    };
    calls.push({ command: request.command, payload: request.payload ?? {} });
    const body = (responses[request.command] ?? { ok: true, data: {} }) as { ok?: boolean };
    const rejected = body.ok === false;
    // **拒绝是 400**：前端照着分开处理（`sendGatewayCommand` 翻成 CommandRejectedError）
    return { ok: !rejected, status: rejected ? 400 : 200, json: async () => body };
  }));
  return calls;
}

/** 填到"可以提交"为止。**输入引用**是必填，所以它在这一列里 */
function fill(values: Partial<Record<string, string>> = {}) {
  const fields: Record<string, string> = {
    '日程 ID': 'daily-report',
    '规则（cron）': '0 9 * * *',
    '输入引用': 'inputs/daily-report.md',
    ...values,
  };
  for (const [label, value] of Object.entries(fields)) {
    fireEvent.change(screen.getByLabelText(new RegExp(label)), { target: { value } });
  }
}

function submit(label: string) {
  return act(async () => {
    fireEvent.click(screen.getByText(label, { selector: 'button' }));
  });
}

beforeEach(() => {
  // 选中态与布局都是全局的：上一个用例留下的会让这一个用例点不中东西
  useSelectionStore.setState({ selectedNodeId: null });
  useLayoutStore.setState({ entries: {}, viewports: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // 队列不能漏到下一个用例（`commandSurface.test.tsx` 记着同一条）
  vi.mocked(sendGatewayCommand).mockClear();
  useSelectionStore.setState({ selectedNodeId: null });
  useLayoutStore.setState({ entries: {}, viewports: {} });
});

/** 操作牌上那几个按钮的文案 */
function surfaceLabels(): string[] {
  return Array.from(document.querySelectorAll('button'))
    .map((button) => button.textContent?.trim() ?? '')
    .filter(Boolean);
}

describe('新建日程', () => {
  it('输入引用**可以留空**——和新建任务那一格同一条规矩', () => {
    /*
      `inputs.py::read` 的第一行就是 `if not task_ref: return ""`：没有正文是
      合法的，固定代码的执行者本来也不看它。这一格以前是必填，**比后端更严**——
      逼人编一个文件名出来，而那个文件一旦不存在，每一次派发都会被它拦下。
    */
    render(<ScheduleEditorOverlay schedule={null} snapshot={SNAPSHOT} onClose={() => {}} />);
    const button = () => screen.getByText('创建日程', { selector: 'button' });

    expect(button()).toHaveProperty('disabled', true);      // 差的只是 ID 与 cron

    fill({ '输入引用': '' });
    expect(button()).toHaveProperty('disabled', false);
    // 那一格上写着「可留空」：留空是允许的，不是漏填
    expect(screen.getByText('输入引用（可留空）')).toBeTruthy();
  });

  it('提交的是一份声明：名字就是日程 ID，留空的输入引用**不写那一栏**', async () => {
    const calls = stubGateway();
    render(<ScheduleEditorOverlay schedule={null} snapshot={SNAPSHOT} onClose={() => {}} />);

    fill({ '输入引用': '' });
    await submit('创建日程');

    // 干净的声明里不该出现一个空转的键（和智能体"没有模型就不写 model"同一条）
    expect(calls[0].payload).toEqual({
      target: 'schedule',
      name: 'daily-report',
      data: {
        name: 'daily-report',
        cron: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        executor_ref: 'config-001',
      },
    });
  });

  it('填了输入引用就照写进那份声明', async () => {
    const calls = stubGateway();
    render(<ScheduleEditorOverlay schedule={null} snapshot={SNAPSHOT} onClose={() => {}} />);

    fill();
    await submit('创建日程');

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('manifest.create');
    expect(calls[0].payload).toEqual({
      target: 'schedule',
      name: 'daily-report',
      data: {
        name: 'daily-report',
        cron: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        task_ref: 'inputs/daily-report.md',
        executor_ref: 'config-001',
      },
    });
  });

  it('默认落在**能跑的那一条**执行者上，不是目录里的第一条', () => {
    /*
      目录第一条是基座 `langgraph.agent`（要模型，而没有人给它配一个）。
      默认落在它上面的话，用户什么都不改直接提交，后端回的是"它跑不起来"——
      那句说的是"换一条"，看起来却像表单自己坏了。
    */
    const withBase: GatewaySnapshot = {
      ...SNAPSHOT,
      executors: [
        { id: 'langgraph.agent', display_name: 'LangGraph Agent', runnable: false },
        { id: 'weather.collect', display_name: '每日天气采集', runnable: true },
      ] as GatewayExecutor[],
    };
    render(<ScheduleEditorOverlay schedule={null} snapshot={withBase} onClose={() => {}} />);

    expect((screen.getByLabelText('执行者配置') as HTMLSelectElement).value)
      .toBe('weather.collect');
  });

  it('后端拒绝时显示原因，表单不关闭', async () => {
    stubGateway({ 'manifest.create': { ok: false, error: 'day 的 cron 写不出来: 每天九点' } });
    const onClose = vi.fn();
    render(<ScheduleEditorOverlay schedule={null} snapshot={SNAPSHOT} onClose={onClose} />);

    fill({ '规则（cron）': '每天九点' });
    await submit('创建日程');

    expect(screen.getByText(/提交失败：.*cron 写不出来/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('编辑已有的日程', () => {
  it('不出现「日程 ID」那一格：名字是身份，不给改', () => {
    render(<ScheduleEditorOverlay schedule={EXISTING} snapshot={SNAPSHOT} onClose={() => {}} />);

    expect(screen.queryByLabelText(/日程 ID/)).toBeNull();
    // 但它得看得见——不然用户不知道自己正在改哪一条
    expect(screen.getByText(/weather\.daily/)).toBeTruthy();
  });

  it('预填它现在的那几栏，保存按钮一直可用', () => {
    render(<ScheduleEditorOverlay schedule={EXISTING} snapshot={SNAPSHOT} onClose={() => {}} />);

    expect((screen.getByLabelText(/规则（cron）/) as HTMLInputElement).value).toBe('0 8 * * *');
    expect((screen.getByLabelText(/时区/) as HTMLInputElement).value).toBe('Asia/Shanghai');
    expect((screen.getByLabelText(/输入引用/) as HTMLInputElement).value)
      .toBe('inputs/weather-daily.md');
    expect((screen.getByLabelText('执行者配置') as HTMLSelectElement).value).toBe('config-002');
    expect(screen.getByText('保存', { selector: 'button' })).toHaveProperty('disabled', false);
  });

  it('保存 = **一栏一条** manifest.write，名字用声明里那个', async () => {
    /*
      后端的 `set_field` 一次只改一栏：它按名字找到那份文件、只动那一行。
      前端不另造一条"整份覆盖"——覆盖会把文件里用户自己写的注释一起抹掉。
    */
    const calls = stubGateway();
    render(<ScheduleEditorOverlay schedule={EXISTING} snapshot={SNAPSHOT} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText(/规则（cron）/), { target: { value: '30 6 * * *' } });
    await submit('保存');

    expect(calls.map((call) => call.command))
      .toEqual(['manifest.write', 'manifest.write', 'manifest.write', 'manifest.write']);
    expect(calls.map((call) => call.payload.field))
      .toEqual(['cron', 'timezone', 'executor_ref', 'task_ref']);
    expect(calls.every((call) => call.payload.name === 'weather.daily')).toBe(true);
    expect(calls[0].payload.value).toBe('30 6 * * *');
  });

  it('清空输入引用 = 把那一栏写成空串（改了就得生效）', async () => {
    /*
      留空是**用户的动作**（这一格就在表单上），所以它必须落到文件里：不写的话
      那一行还在，用户明明清掉了它却照旧生效——"我改了但它没变"正是要避免的。
      （`set_field` 只能改一栏、删不掉一个键，空串就是它说"没有正文"的方式。）
    */
    const calls = stubGateway();
    render(<ScheduleEditorOverlay schedule={EXISTING} snapshot={SNAPSHOT} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText(/输入引用/), { target: { value: '   ' } });
    await submit('保存');

    const written = calls.find((call) => call.payload.field === 'task_ref');
    expect(written?.payload.value).toBe('');
  });
});

describe('从节点上走到那张表单', () => {
  it('世界场景：选中一条日程，牌面上的「编辑」打得开它', async () => {
    // 「改一条已有日程」以前**一个入口都没有**：牌面上只有查看 / 触发 / 启停
    render(<WorldScene snapshot={SNAPSHOT} />);

    tapNode('schedule-001');
    expect(surfaceLabels()).toContain('编辑');

    await act(async () => {
      fireEvent.click(screen.getByText('编辑', { selector: 'button' }));
    });

    expect(screen.getByText('编辑日程')).toBeTruthy();
    // 预填的是它现在那几行（夹具里 schedule-001 是 `0 2 * * *`）
    expect((screen.getByLabelText(/规则（cron）/) as HTMLInputElement).value).toBe('0 2 * * *');
  });

  it('打开表单这件事本身**不提交任何命令**：回执要等真正保存之后', async () => {
    const calls = stubGateway();
    render(<WorldScene snapshot={SNAPSHOT} />);

    tapNode('schedule-001');
    await act(async () => {
      fireEvent.click(screen.getByText('编辑', { selector: 'button' }));
    });

    expect(calls).toHaveLength(0);
    expect(screen.getByText('编辑日程')).toBeTruthy();
  });

  it('世界场景里删一条日程：先把子 Task 的**个数**写在闸门上', async () => {
    /*
      删的是"这条日程 + 它派出去的 N 个子 Task"，不是"一条日程"。
      子 Task 在外层看不见、也进不了档案馆，用户平时根本数不出有多少个——
      那个数不写在闸门上，这一按下去消失的东西就比看到的多。
    */
    stubGateway();
    vi.mocked(sendGatewayCommand).mockClear();
    render(<WorldScene snapshot={SNAPSHOT} />);

    tapNode('schedule-001');
    // 高风险那几条的按钮上写着「删除」+ 一枚「需预览」的角标
    await act(async () => {
      fireEvent.click(screen.getByText('删除', { selector: 'button' }));
    });

    // 夹具里 schedule-001 派过两次（一条跑完、一条停在待批）
    expect(screen.getByText(/2 个子 Task/)).toBeTruthy();
    expect(screen.getByText('不可撤回')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText('确认提交', { selector: 'button' }));
    });

    // 走的是 schedule.delete（**不是** manifest.delete：那条路不会碰子 Task）。
    // 这条命令由 `submitCommand` 发出——它调的是 `api/gateway` 那个模块边界，
    // 所以桩要打在那儿（上面那个 fetch 桩拦的是 `sendAccepted` 那一支）
    const sent = vi.mocked(sendGatewayCommand).mock.calls.at(-1);
    expect(sent?.[0]).toBe('schedule.delete');
    expect(sent?.[2]).toEqual({ name: 'schedule-001' });
  });
});
