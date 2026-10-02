/**
 * 真连一次后端
 *
 * **默认跳过**（没有后端时它不该红）。跑它：
 *
 * ```powershell
 * cd occ-next; OCC_NEXT_ROOT=demo uv run python -m src.serve
 * cd occ-command-center
 * $env:VITE_GATEWAY_URL='http://127.0.0.1:8765'   # 客户端的 base：浏览器里是相对路径，node 里得给全
 * $env:VITE_OCC_LIVE='http://127.0.0.1:8765'
 * npx vitest run src/api/live.test.ts
 * ```
 *
 * 它验的是**两份代码真的对得上**：后端的形状进得来、配置舱画得出节点、
 * 命令面收得下、引用答得出三态。那些用假数据测不出来的地方——比如
 * "字段名对不上"和"供给关着时列表里还有没有它"——只有真连一次才知道。
 */

import { describe, expect, it, vi } from 'vitest';
import { projectLiveConfiguration } from '../core/projection/LiveConfigurationProjection';
import { taskExecutorChoices } from '../lib/executorGroups';
import { projectWorldScene } from '../core/projection/WorldProjection';

const actual = await vi.importActual<typeof import('./gateway')>('./gateway');

// `OCC_LIVE=http://127.0.0.1:8765`（只认 VITE_ 前缀的话读不到，所以走 env 的那个名字）
const LIVE = (import.meta.env.VITE_OCC_LIVE as string | undefined) ?? '';

describe.skipIf(!LIVE)('真后端', () => {
  it('快照进得来，而且配置舱画得出节点', async () => {
    const response = await fetch(`${LIVE}/api/state`);
    expect(response.status).toBe(200);

    const snapshot = actual.mapLiveState(await response.json());
    const model = projectLiveConfiguration(snapshot);

    // 供给 → 扩展节点；工具挂在它下面
    expect(model.abilities.length).toBeGreaterThan(0);
    expect(model.capabilities.length).toBeGreaterThan(0);
    // 执行者与供应商分组
    expect(model.executorConfigurations.length).toBeGreaterThan(0);
    expect(model.providers.length).toBeGreaterThan(0);

    /*
      **供应商那一栏带着它的模型目录。**

      模型目录住在 `_providers/<name>.yaml` 里，**不挂在任何执行者上**——
      当年把每个模型做成一条执行者，于是"换模型"变成了"换执行者"。
      这一条钉的就是新形状：目录来自供应商，而"用哪个"是配置（下一条自己建一个）。

      智能体那一栏**这里是空的**，而且应该允许是空的：它由人在配置舱里建
      （下一条就建一个）。所以这里不断言它非空——那会把"这一版恰好没有"
      写成"系统应该有"，而新建那条会把这条路径验完。
    */
    const catalogued = (snapshot.providers ?? []).filter((item) => (item.models ?? []).length > 0);
    expect(catalogued.length).toBeGreaterThan(0);
    expect(catalogued.some((item) => item.enabled)).toBe(true);
  });

  it('配置舱画得出**每一家声明的**供应商，而且带着它的模型目录', async () => {
    /*
      这一条钉的是配置舱最显眼的那一格。之前它画的不是供应商，是"执行者按供应商
      分出来的组"——而新树里那个 `provider_id` 要由模型引用算出来，算不出来的时候
      所有执行者挤进一个叫"未标注供应商"的假节点里，**两家真供应商一个都不在画布上**。

      两条都要钉死：
      - **声明的供应商都在**，哪怕还没有任何执行者引用它（一份声明在不在系统里，
        不由有没有人用它决定）；
      - 每一家**带着它的目录**——那是打开这一格唯一想看的东西，也是"这家是什么"
        的全部内容。
    */
    const snapshot = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
    const model = projectLiveConfiguration(snapshot, '', new Set<string>());

    const drawn = new Set(model.providers.map((node) => node.id));
    for (const provider of snapshot.providers ?? []) {
      expect([provider.name, drawn.has(`provider:${provider.name}`)]).toEqual([provider.name, true]);
    }

    const biggest = model.providers
      .slice()
      .sort((a, b) => (b.catalog?.models.length ?? 0) - (a.catalog?.models.length ?? 0))[0];
    expect(biggest?.catalog?.models.length ?? 0).toBeGreaterThan(0);
    // 计数报的就是目录里有多少——不是"几条执行者引用它"
    expect(biggest?.child_count).toBe(biggest?.catalog?.models.length);
  });

  it('配置舱画的是**那棵树**：包按目录名，条目收在包里', async () => {
    /*
      前端只出渲染器——结构全部来自后端那棵树（`console`）。这一条钉的就是
      "画出来的东西与那棵树一一对应"：

      - 一级包的身份是**目录名**（`weather`），不是注册表里那个引用；
      - 每个节点说得出"我在哪个文件里"；
      - 条目收在包里，默认一个都不在画布上。
    */
    const snapshot = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
    const packages = (snapshot.console ?? []).filter((node) => node.kind === 'package');
    expect(packages.length).toBeGreaterThan(0);

    const model = projectLiveConfiguration(snapshot, '', new Set<string>());
    expect(model.abilities.map((node) => node.id).sort())
      .toEqual(packages.map((node) => node.name).sort());
    expect(model.abilities.every((node) => (node.path ?? '').endsWith('manifest.yaml')))
      .toBe(true);

    const drawn = new Set(model.projection.nodes.map((node) => node.id));
    for (const item of packages) {
      for (const entry of item.nodes ?? []) {
        expect([entry.full, drawn.has(String(entry.full))]).toEqual([entry.full, false]);
      }
    }
  });

  it('工具条目上不再挂着「所属包已下线」——那个包好好的', async () => {
    /*
      两条引用以前对不上：配置状态那一行写的是 `extension.weather`，而前端自己造的
      供给列表用的 ref 是 `supply:weather`——于是"包能不能解析"这个判断**永远认不出包**，
      每一次都答"已下线"。

      后果是**每一个工具节点都挂着一句假话**：`extension.weather 已下线 / 它现在不可用`，
      而那个包是好的。
    */
    const snapshot = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
    const model = projectLiveConfiguration(snapshot, '', new Set(['weather']));
    const tool = model.projection.nodes.find((node) => node.id === 'weather.current');

    expect(tool?.type === 'resource' && tool.owner?.state).toBe('resolvable');
  });

  it('清单里那句描述归左上角那块卡，不是一句诊断', async () => {
    /*
      `诊断` 那一栏回答的是"它为什么没起来"。以前 `mapLiveState` 把包清单里那句
      描述**同时**塞进 `last_error` 和 `diagnostic.message`——于是每个包在界面上
      都挂着一句长得像故障的描述。**描述是描述，诊断是诊断。**
    */
    const snapshot = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
    const weather = projectLiveConfiguration(snapshot, '', new Set<string>())
      .abilities.find((node) => node.id === 'weather');

    expect(weather?.panel_note ?? '').not.toBe('');
    const row = (snapshot.objects ?? []).find((item) => item.object_ref === 'extension.weather');
    expect(row?.diagnostic ?? null).toBeNull();
    expect(String(row?.last_error ?? '')).toBe('');
  });

  it('智能体：建 → 用（提交的是执行者名）→ 改 → 删', async () => {
    /*
      四条路走一遍，**每一步都靠重读证明**，不看回执。

      这里不真的建 Task：建了之后这个包就被历史引用钉住、删不掉了（那是对的），
      而测试得自己收拾干净。所以"用"验的是**它会提交什么值**——那个值就是
      `create_task` 的 `executor_ref`，而 `executor_ref` 认的是执行者的名字。
    */
    const read = async () => actual.mapLiveState(
      await (await fetch(`${LIVE}/api/state`)).json());

    // 建：它就是一个包，名字写在清单的 `name:` 里
    await actual.upsertAgent({
      id: 'live-lifecycle', label: '联调四步', description: '走一遍四条路',
      base: 'weather.collect', modelRef: 'deepseek:deepseek-v4-pro',
      system_prompt: '你是联调', packages: ['weather'], tighten: [], creating: true,
    });
    let snapshot = await read();
    let agent = snapshot.agents?.find((item) => item.agent_ref === 'agent.live-lifecycle');
    expect(agent?.label).toBe('联调四步');
    expect(agent?.executor_config_ref).toBe('weather.collect');

    // 用：下拉里那一格提交的必须是**执行者的名字**
    const offered = taskExecutorChoices(snapshot)
      .flatMap((group) => group.options.map((option) => option.value));
    expect(offered).toContain('live-lifecycle');
    expect(offered).not.toContain('agent:live-lifecycle');

    // 改：名字、说明、模型**都要真的写进那份文件**
    await actual.upsertAgent({
      id: 'live-lifecycle', label: '联调四步（改过）', description: '改过了',
      base: 'weather.collect', modelRef: 'deepseek:deepseek-flash',
      system_prompt: '你是联调', packages: ['weather'], tighten: ['weather.current'],
      creating: false,
    });
    snapshot = await read();
    agent = snapshot.agents?.find((item) => item.agent_ref === 'agent.live-lifecycle');
    expect(agent?.label).toBe('联调四步（改过）');
    expect(agent?.model_ref).toBe('deepseek:deepseek-flash');
    expect(agent?.tools[0]?.tightened_by_agent).toBe(true);

    // 删：没有历史引用，删得掉
    await actual.deleteAgent('live-lifecycle');
    snapshot = await read();
    expect(snapshot.agents?.find((item) => item.agent_ref === 'agent.live-lifecycle'))
      .toBeUndefined();
  });

  it('归档 → 删除：那条历史拿掉之后，引用它的包才删得掉', async () => {
    /*
      "有引用就不许删"是对的，但**没有出路的安全是死锁**：用户说"这个智能体我
      不要了"，系统答"它上个月跑过三个任务"。

      这一条钉的就是那条出路：跑完 → 归档 → 删掉，然后包就是没人用的了。
    */
    await actual.upsertAgent({
      id: 'live-archive', label: '联调归档', description: '',
      base: 'weather.collect', modelRef: 'deepseek:deepseek-flash',
      system_prompt: 'x', packages: ['weather'], tighten: [], creating: true,
    });
    const created = await actual.sendGatewayCommand('create_task', '', {
      summary: '联调：要被归档的', task_ref: 'inputs/weather-daily.md',
      executor_ref: 'live-archive',
    });
    const taskId = String(created.command_result?.task_id ?? '');
    await actual.sendGatewayCommand('cancel', '', { task_id: taskId });

    // 它跑过了：包被钉住，而且**点名**是哪个 Task
    await expect(actual.deleteAgent('live-archive')).rejects.toThrow('还被');

    // 先归档：它还在库里（归档是"我不管它了"，不是"它没了"），但**离开了主屏**
    await actual.sendGatewayCommand('archive', '', { task_id: taskId });
    let state = await (await fetch(`${LIVE}/api/state`)).json();
    expect(state.tasks.find((t: {task_id: string}) => t.task_id === taskId)?.archived)
      .toBe(true);
    const drawn = projectWorldScene({
      tasks: actual.mapLiveState(state).tasks, schedules: [], dispatches: [],
    }).nodes.map((node) => node.id);
    expect(drawn).not.toContain(taskId);

    // 再删：这一步之后引用就没了
    await actual.sendGatewayCommand('forget', '', { task_id: taskId });
    state = await (await fetch(`${LIVE}/api/state`)).json();
    expect(state.tasks.some((t: {task_id: string}) => t.task_id === taskId)).toBe(false);

    await actual.deleteAgent('live-archive');
    const after = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
    expect(after.agents?.find((item) => item.agent_ref === 'agent.live-archive'))
      .toBeUndefined();
  });

  it('没归档就删，后端会拒——而且是拒得看得见的那种', async () => {
    // 删不可撤销，所以它前面站着一道门。拒的理由要说清"先归档"
    await actual.upsertAgent({
      id: 'live-refuse', label: '联调拒删', description: '',
      base: 'weather.collect', modelRef: 'deepseek:deepseek-flash',
      system_prompt: 'x', packages: ['weather'], tighten: [], creating: true,
    });
    const created = await actual.sendGatewayCommand('create_task', '', {
      summary: '联调：没归档就删', task_ref: 'inputs/weather-daily.md',
      executor_ref: 'live-refuse',
    });
    const taskId = String(created.command_result?.task_id ?? '');
    await actual.sendGatewayCommand('cancel', '', { task_id: taskId });

    await expect(actual.sendGatewayCommand('forget', '', { task_id: taskId }))
      .rejects.toThrow('先归档');

    // 收拾干净：它归过档之后才删得掉
    await actual.sendGatewayCommand('archive', '', { task_id: taskId });
    await actual.sendGatewayCommand('forget', '', { task_id: taskId });
    await actual.deleteAgent('live-refuse');
  });

  it('新建任务的下拉里有真能跑的执行者，没有跑不了的基座', async () => {
    /*
      「不带模型的执行者」在新树里是**基座**（`langgraph.agent` 那种），它 `needs_llm`
      却没有模型——模型是配置的事。它出现在这个下拉里，用户选了建 Task 会被后端
      当场拒（"要用模型，但没有人给它配一个"）。**一个下拉里列出选不得的东西，
      比少列一条更糟。**
    */
    const snapshot = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
    const options = taskExecutorChoices(snapshot).flatMap((group) =>
      group.options.map((option) => option.value));

    expect(options.length).toBeGreaterThan(0);
    expect(options).toContain('weather.collect');
    expect(options).not.toContain('langgraph.agent');
  });

  it('命令面收得下：建一个 Task，再读回来', async () => {
    const created = await actual.sendGatewayCommand('create_task', '', {
      summary: '联调：跑一次天气', task_ref: 'inputs/weather-daily.md',
      executor_ref: 'weather.collect',
    });
    expect(created.accepted).toBe(true);
    const taskId = String(created.command_result?.task_id ?? '');
    expect(taskId).not.toBe('');

    const read = await fetch(`${LIVE}/api/tasks/${taskId}`);
    expect(read.status).toBe(200);
    expect((await read.json() as { status: string }).status).toBe('running');

    // 建完就收掉。**建 Task 不等于起 worker**（那是「启动 Worker」那一格的事），
    // 所以不收掉的话，它会在真后端里留一条永远 running 的任务——
    // 每跑一次这套联调就多一条，而那是别人机器上的真实数据。
    await actual.sendGatewayCommand('cancel', '', { task_id: taskId });
  });

  it('校验没过是 400，而且带着原因', async () => {
    // 不存在的执行者：**这是网关的判决**，不是服务端炸了
    await expect(actual.sendGatewayCommand('create_task', '', {
      summary: 'x', executor_ref: '没有这个执行者',
    })).rejects.toThrow('没有这个执行者');
  });

  it('引用答三态', async () => {
    const good = await actual.resolveObject('executor:weather.collect');
    expect(good.state).toBe('resolvable');

    const missing = await actual.resolveObject('executor:没有这个');
    expect(missing.state).toBe('unknown');
    expect(missing.reason).not.toBe('');
  });

  it('新建智能体 = 写一份包声明，回来就在列表里', async () => {
    // 它就是配置舱空白处右键那一格的提交路径：**保存 = 写一份声明**
    await actual.upsertAgent({
      id: 'live-agent', label: '联调智能体', description: '由联调建的',
      base: 'weather.collect', modelRef: 'deepseek:deepseek-v4-pro',
      system_prompt: '你是运维执行者', packages: ['weather'],
      tighten: ['weather.current'], creating: true,
    });

    const snapshot = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
    const agent = snapshot.agents?.find((item) => item.agent_ref === 'agent.live-agent');

    expect(agent?.executor_config_ref).toBe('weather.collect');
    expect(agent?.model_ref).toBe('deepseek:deepseek-v4-pro');
    // 声明说不用批、执行者自己收紧了 —— 三列要说得出来
    expect(agent?.tools[0]).toEqual({
      tool_id: 'weather.current', declared: false, effective: true, tightened_by_agent: true,
    });

    // 删掉：它是一份真文件（包目录）
    await actual.deleteAgent('live-agent');
    const after = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
    expect(after.agents?.find((item) => item.agent_ref === 'agent.live-agent')).toBeUndefined();
  });

  it('那个开关：包 / 日程 / 供应商，按下真的改到声明里', async () => {
    /*
      开关不是另一条命令——**关掉一个东西 = 写它那份声明里的一行**。
      三条各自一个容器，验的是"按下去真的改了磁盘上那份文件"，不是"回了 200"。
    */
    for (const [objectRef, key] of [
      ['extension.weather', 'enabled'],
      ['schedule.weather.daily', 'enabled'],
      ['provider.deepseek', 'enabled'],
    ] as const) {
      await actual.setConfigEnabled(objectRef, false);
      const off = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
      expect([objectRef, off.objects?.find((row) => row.object_ref === objectRef)?.activation])
        .toEqual([objectRef, 'disabled']);

      await actual.setConfigEnabled(objectRef, true);
      const on = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
      expect([objectRef, on.objects?.find((row) => row.object_ref === objectRef)?.activation])
        .toEqual([objectRef, 'enabled']);
      expect(key).toBe('enabled');
    }
  });

  it('改一条列表里的条目：整列交回去，一个字都不丢', async () => {
    /*
      工具与执行者住在包清单的**列表**里，而声明只有顶层字段可改——
      所以改一条就是整列重写。而重写必须**无损**：`entrypoint` 丢了的话，
      写回去就是一份坏声明（写前校验会拦，但那是"没改成"而不是"改坏了"，
      两者对用户是不同的事）。
    */
    const before = await (await fetch(`${LIVE}/api/state`)).json();
    const weather = before.declarations.find((item: {id: string}) => item.id === 'weather');
    const entrypoint = weather.tools[0].entrypoint;

    await actual.setToolField({
      extensionId: 'weather', toolId: 'weather.current', field: 'approval_required', value: true,
    }, before.declarations);

    const after = await (await fetch(`${LIVE}/api/state`)).json();
    const supply = after.registry.capabilities.find((item: {name: string}) => item.name === 'weather');
    expect(supply.approval_required).toBe(true);
    expect(after.declarations.find((item: {id: string}) => item.id === 'weather')
      .tools[0].entrypoint).toBe(entrypoint);

    // 改回来，别把 demo 树留脏
    await actual.setToolField({
      extensionId: 'weather', toolId: 'weather.current', field: 'approval_required', value: false,
    }, after.declarations);
  });

  it('日程：立即触发、新建、**改**、删掉', async () => {
    await actual.triggerSchedule('weather.daily');
    const state = await (await fetch(`${LIVE}/api/state`)).json();
    // 派发真的发生了：多了一条 Task，而且派发记录里看得见
    expect(state.tasks.some((task: {executor_ref: string}) => task.executor_ref === 'weather.collect'))
      .toBe(true);

    await actual.upsertSchedule({ scheduleId: 'live-daily', cron: '0 9 * * *',
      timezone: 'Asia/Shanghai', taskRef: 'inputs/weather-daily.md',
      executorRef: 'weather.collect', creating: true });
    const created = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
    expect(created.schedules?.map((item) => item.schedule_id)).toContain('live-daily');

    /*
      **改一条已有的**：四栏各是一条 `manifest.write`（后端一次只改一栏），
      然后重读快照——改完的样子只能从快照看，回执只说"写进去了"。
    */
    await actual.upsertSchedule({ scheduleId: 'live-daily', cron: '30 6 * * *',
      timezone: 'Asia/Shanghai', taskRef: 'inputs/renamed.md',
      executorRef: 'weather.collect', creating: false });
    const edited = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
    const schedule = edited.schedules?.find((item) => item.schedule_id === 'live-daily');
    expect(schedule?.cron).toBe('30 6 * * *');
    expect(schedule?.task_ref).toBe('inputs/renamed.md');

    await actual.deleteSchedule('live-daily');
    const gone = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
    expect(gone.schedules?.map((item) => item.schedule_id)).not.toContain('live-daily');
  });

  it('坏声明写不进去，而且说清哪里坏', async () => {
    // 前端的新建表单走的就是这条路：写前校验挡住了它，用户看到的是**哪一栏**坏了
    await expect(actual.upsertSchedule({
      scheduleId: 'bad-daily', cron: '每天九点', timezone: 'Asia/Shanghai',
      taskRef: 'x.md', executorRef: 'weather.collect', creating: true,
    })).rejects.toThrow('cron');

    /*
      **输入引用可以留空**（和新建任务那一格同一条规矩）：没有正文是合法的，
      `inputs.py::read` 第一行就是 `if not task_ref: return ""`。留空的那些
      不写 `task_ref` 那一栏——一份干净的声明里不该出现一个空转的键。
    */
    await actual.upsertSchedule({
      scheduleId: 'no-input', cron: '0 9 * * *', timezone: 'Asia/Shanghai',
      taskRef: '', executorRef: 'weather.collect', creating: true,
    });
    const created = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());
    const bare = created.schedules?.find((item) => item.schedule_id === 'no-input');
    expect(bare?.cron).toBe('0 9 * * *');
    expect(bare?.task_ref ?? '').toBe('');
    await actual.deleteSchedule('no-input');
  });

  it('日程列表带着它的执行者引用', async () => {
    const snapshot = actual.mapLiveState(await (await fetch(`${LIVE}/api/state`)).json());

    const schedule = snapshot.schedules?.find((item) => item.schedule_id === 'weather.daily');
    expect(schedule?.cron).toBe('0 8 * * *');
    expect(schedule?.executor_config_ref).toBe('weather.collect');
  });

  it('空闲的流会自己说话，而且赶在前端那条看门狗前面', async () => {
    /*
      这条钉的是**两份常量配成一对**：后端 `HEARTBEAT_SECONDS` 必须明显短于
      前端 `HEARTBEAT_TIMEOUT_MS`，而且那一帧必须是 `data:` 帧。

      两个都栽过：后端发的是 SSE 注释行 `: 心跳`（**浏览器不交给 JS**），
      周期又是 15 秒（比前端的 6 秒容忍还长）。两条叠起来的效果是——
      **后端好好的，前端却每隔 6 秒判它断一次线**，界面上那条"实时"永远在重连。
      桩测试测不出这个：它两边各自都是"对的"。
    */
    const controller = new AbortController();
    try {
      const response = await fetch(`${LIVE}/api/events`, { signal: controller.signal });
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 6000;      // = 前端那条看门狗的容忍时间
      let seen = '';

      while (Date.now() < deadline && !seen.includes('"heartbeat": true')) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }

      expect(seen).toContain('"heartbeat": true');
      expect(seen).not.toContain(': 心跳');     // 注释行在这儿出现就是又退回去了
    } finally {
      controller.abort();
    }
  });
});
