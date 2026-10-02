/**
 * 网关契约测试
 *
 * 覆盖两件在真实联调里最容易出错、又最难在界面上定位的事：
 *
 * 1. 后端字段 → 前端字段的归一化（翻译错了整站都会显示错）；
 * 2. HTTP 错误说明从哪来（读错字段就只剩一句无信息的失败）。
 *
 * 用 `importActual` 拿真实实现：`src/test/setup.ts` 把整个 `api/gateway`
 * 换成了夹具，这里要测的正是被换掉的那部分。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { LiveState } from './gateway';

const actual = await vi.importActual<typeof import('./gateway')>('./gateway');

/** 一份最小的新后端响应（`GET /api/state`，形状见 `src/web/snapshot.py`） */
function liveState(): LiveState {
  return {
    registry: {
      capabilities: [
        {
          name: 'weather', package: 'weather', enabled: true, loaded: true, problem: '',
          usable: true, status: 'ready', detail: '', approval_required: true,
          idempotency: 'safe-retry',
          tools: [{ tool_id: 'weather.collect', description: '采集', input_schema: {} }],
        },
        {
          // 关着的供给：只有名字和审批，**没有函数名**（工具清单是问出来的）
          name: 'guard', package: 'guard', enabled: false, loaded: false, problem: '',
          usable: false, status: 'offline', detail: '它关着', approval_required: false,
          idempotency: 'safe-retry', tools: [],
        },
      ],
      executors: [
        { name: 'weather.collect', package: 'weather', based_on: '', enabled: true,
          problem: '', runnable: true, why_not: '', needs_llm: false, model: null,
          tools_from: ['weather'], tighten: [] },
        { name: 'ops-readonly', package: 'ops', based_on: 'weather.collect', enabled: true,
          problem: '', runnable: true, why_not: '', needs_llm: false,
          model: { provider: 'deepseek', name: 'deepseek-v4-pro' },
          tools_from: ['weather'], tighten: ['weather.collect'] },
      ],
      providers: [{ name: 'deepseek', base_url: 'https://api.deepseek.com/v1', enabled: true }],
      schedules: [{ name: 'weather.daily', cron: '0 8 * * *', timezone: 'Asia/Shanghai',
                    task_ref: 'inputs/x.md', executor_ref: 'weather.collect', enabled: true }],
      packages: [{ id: 'weather', enabled: true, name: '天气', description: '天气工具' }],
    },
    tasks: [
      {
        task_id: 'task-abc',
        status: 'paused',
        summary: '部署生产环境',
        executor_ref: 'weather.collect',
        pending: { tool_id: 'weather.collect', decision: 'approved' },
        state_version: 7,
        events: [],
      },
      { task_id: 'task-def', status: '某个后端还没定义的状态', summary: '漂移样例' },
    ],
    workers: [{ task_id: 'task-abc', process_id: 4812, started_at: '', alive: true }],
    dispatches: [],
  };
}

describe('快照归一化', () => {
  const mapped = actual.mapLiveState(liveState());
  const [first, second] = mapped.tasks;

  it('executor_ref 映射到 executor_config_id', () => {
    // Task 场景按 executor_config_id 解析引用；映射错了 Executor 徽标永远是空的
    expect(first.executor_config_id).toBe('weather.collect');
  });

  it('pending.decision 映射到 approval_state，不落进同名的对象字段', () => {
    expect(first.approval_state).toBe('approved');
    expect(first.pending_decision).toBeUndefined();
  });

  it('pending_tool_id 与 state_version 原样带过', () => {
    expect(first.pending_tool_id).toBe('weather.collect');
    expect(first.state_version).toBe(7);
  });

  it('unknown 状态不猜测语义', () => {
    expect(second.status).toBe('created');
  });

  it('配置状态里的诊断是空的：**描述不是诊断**', () => {
    /*
      那一格回答的是"它为什么没起来"。以前 `objectRow` 收一个"备注"字符串
      （包说明 / `why_not` / cron / `base_url`）并把它**同时**写进 `last_error`
      和 `diagnostic.message`——于是界面上：

      - 一台好好的供应商挂着「诊断：https://api.deepseek.com/v1」；
      - 一条日程挂着「诊断：0 8 * * *」；
      - 一个包挂着「诊断：<它清单里那句描述>」。

      三句都不是诊断，而它们长得像真的。诊断不落库（ADR-028），所以这一版没有
      "上次为什么失败"可填——那就空着，而不是拿别的字段冒充。
    */
    const rows = mapped.objects ?? [];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.diagnostic)).toEqual([]);
    expect(rows.filter((row) => String(row.last_error ?? '') !== '')).toEqual([]);
  });

  it('needs_llm 与 ref 过到快照里：模型那一格出不出现就看它们', () => {
    /*
      「新建智能体」的模型那一格由**基座自己**决定出不出现（`needs_llm`），
      选项的值又必须和定义里的基座对得上（`ref`）。这两格在映射里丢掉的话：

      - 所有基座都被当成"要模型"——一段写死的代码也会被逼着选一个模型，
        而那个模型没人读；
      - `<option>` 的 value 全是空串——下拉看着有内容，选哪一个都等于没选。
    */
    const [base, agent] = mapped.executors ?? [];

    expect(base.needs_llm).toBe(false);
    expect(base.ref).toBe('weather.collect');
    // 智能体不是基座：`based_on` 有值的那条不进基座候选
    expect(agent.type).toBe('agent');
  });

  it('人读名称取包名，不是那个引用', () => {
    /*
      声明里只有条目名（`weather.collect`），人认的那个名字长在**包**上
      （`weather` 的 `name: 天气`）。所有取值 `display_name` 的下拉都靠这一格，
      它写错就等于每个下拉都在印一个变量名——而画布上那张卡片写的是人话。

      包名取不到的（这条执行者所属的包没在清单里）不编一个：回落到引用本身，
      正是"它是谁"最准的说法。
    */
    expect(mapped.executors?.[0].display_name).toBe('天气');
    expect(mapped.executors?.[1].display_name).toBe('ops-readonly');
  });

  it('每个 Task 都有稳定的 id 与初始坐标', () => {
    mapped.tasks.forEach((task) => {
      expect(task.id).toBeTruthy();
      expect(task.type).toBe('task');
      expect(Number.isFinite(task.x)).toBe(true);
      expect(Number.isFinite(task.y)).toBe(true);
    });
  });

  it('供给 → 一个 ability 节点 + 它的工具，关着的只有名字', () => {
    const byRef = new Map(mapped.abilities.map((item) => [item.ability.ability_ref, item]));
    expect(byRef.get('supply:weather')?.capabilities).toEqual(['weather.collect']);
    // 关着的那台**没有函数名**——它是"已下线"，不是"没有工具"
    expect(byRef.get('supply:guard')?.capabilities).toEqual([]);
    expect(byRef.get('supply:guard')?.ability.health).toBe('offline');
    expect(mapped.capabilities.map((item) => item.tool_id)).toEqual(['weather.collect']);
  });

  it('智能体 = 基于别人的执行者，审批三列由后端那条规则算', () => {
    const agent = mapped.agents?.[0];
    expect(agent?.agent_ref).toBe('agent.ops-readonly');
    expect(agent?.executor_config_ref).toBe('weather.collect');
    // 声明说必须批、执行者又收紧过：两列都要看得出来
    expect(agent?.tools[0]).toEqual({
      tool_id: 'weather.collect', declared: true, effective: true, tightened_by_agent: true,
    });
  });

  it('开关行从声明来，「意图 / 观测」两列还在', () => {
    const rows = new Map((mapped.objects ?? []).map((row) => [row.object_ref, row]));
    expect(rows.get('extension.weather')?.activation).toBe('enabled');
    // 没有第二个写者了：开关就在声明里，"谁定的"只有一个答案
    expect(rows.get('extension.weather')?.source).toBe('manifest');
    expect(rows.get('executor.weather.collect')?.activation).toBe('enabled');
    expect(rows.get('agent.ops-readonly')).toBeTruthy();
    expect(rows.get('schedule.weather.daily')?.activation).toBe('enabled');
  });

  it('启动记录 → controller 观测', () => {
    expect(mapped.controllers['task-abc']).toEqual({
      task_id: 'task-abc', worker_alive: true, status: 'running', worker_unreconciled: undefined,
    });
    expect(actual.workerAliveOf(mapped, 'task-xyz')).toBeUndefined();
  });
});

describe('Controller 观测与执行结果', () => {
  const snapshot = {
    ...actual.mapLiveState(liveState()),
  };

  it('没有观测记录时返回 undefined，而不是 false', () => {
    // 「没有观测」和「观测到没有 Worker」是两件事：前者按未知处理
    expect(actual.workerAliveOf(snapshot, 'task-abc')).toBe(true);
    expect(actual.workerAliveOf(snapshot, 'task-xyz')).toBeUndefined();
  });

  it('结果正文取 result 或 text 两种形状', async () => {
    // 本次运行结束时的内存结果用 result
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ output: { ok: true, result: '杭州今天晴' } }) })));
    expect(await actual.getTaskResult('task-abc')).toEqual({ text: '杭州今天晴', structured: false });

    // 从 checkpoint 回读时用 text
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ output: { ok: true, text: '来自 checkpoint 的回答' } }) })));
    expect(await actual.getTaskResult('task-abc')).toEqual({ text: '来自 checkpoint 的回答', structured: false });
  });

  it('结构化结果保留原文，不加工成一句人话', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ output: { ok: true, result: { city: '杭州', temp: 21 } } }) })));
    const result = await actual.getTaskResult('task-abc');
    expect(result?.structured).toBe(true);
    expect(result?.text).toContain('"temp": 21');
  });

  it('拿不到结果时返回 null，不编一个空字符串', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ output: {} }) })));
    expect(await actual.getTaskResult('task-abc')).toBeNull();
  });

  it('读取失败时抛出后端给的原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ detail: 'Task 不存在: task-x' }) })));
    await expect(actual.getTaskResult('task-x')).rejects.toThrow('Task 不存在: task-x');
  });
});

describe('HTTP 失败原因', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:5173' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown, status: number) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })));
  }

  it('读 FastAPI 的 detail', async () => {
    stubFetch({ detail: 'Task 状态 cancelled 不能调用工具' }, 409);
    await expect(actual.sendGatewayCommand('cancel', 'task-abc')).rejects.toThrow(
      'Task 状态 cancelled 不能调用工具'
    );
  });

  it('校验失败的 detail 是数组时取 msg', async () => {
    stubFetch({ detail: [{ msg: 'summary: String should have at least 1 character' }] }, 422);
    await expect(actual.sendGatewayCommand('create_task')).rejects.toThrow(
      'summary: String should have at least 1 character'
    );
  });

  it('响应体不是 JSON 时退回状态码，不编造原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    })));
    await expect(actual.sendGatewayCommand('cancel', 'task-abc')).rejects.toThrow(
      'Gateway command failed: 502'
    );
  });
});
