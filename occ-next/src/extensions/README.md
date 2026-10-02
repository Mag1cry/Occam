# extensions/ — 扩展包机制

**只有一套，而且一切都是从这里来的**：工具、执行者、智能体、日程。

一个包 = `extensions/<id>/manifest.yaml`——**一份注册清单**。清单上每一条写明它的
`type`，而 `type` 决定了它必须有哪几栏。

| 文件 | 装什么 |
| --- | --- |
| `manifest.py` | 契约表（`type → 必填项`）+ 清单的形状与校验 |
| `loader.py` | 两段式加载：先扫描全部清单（不 import），再决定加载谁 |
| `tools.py` | `tools` 条目 → 实例化单例 / 连服务器 → **供给**工具 |
| `executors.py` | `executors` 条目 → 执行者定义（**智能体也走这条**） |
| `mcp_client.py` | MCP 适配层：`fastmcp` 之上的薄薄一层——同步桥、超时、失败翻译 |
| `runtime.py` | 加载包目录里的 Python（执行者的 worker / adapter） |
| `writer.py` | **唯一能写声明的地方**：包清单 + 日程文件 + 供应商文件（写前校验 + 原子替换） |
| `diagnostics.py` | 扫描/加载失败的诊断 |
| `hotload.py` | 把启用/停用变成加载、注册、启停与失败回滚 |

## 边界

- **不拥有列表**。它只产出声明与实现，登记进 `gateway/directory/` 那四个列表
  （能力、执行者、供应商、日程）——**它们全局只有一份**。
- **读和写分开**。`loader.py` 只读（扫描期的一次动作），`writer.py` 只有它写
  （运行期随时发生）。**形状**在 `manifest.py`，读和写都用它——写前校验就是拿它校验的。
- **不拥有工具句柄**。工具在系统里长什么样（名字、审批、谁允许调）归 gateway，见下。
- **不拥有别人的进程**。外面已经在跑的 MCP 服务器（`url`）只连不碰；包内实现不起进程。
- **不按名字分派**。宿主里没有任何一张「包名 / 工具名 / 类型名 → 实现」的表。
- 撞名必须在 import **之前**判掉，否则"禁用"无从谈起：被判失败的包，代码已经进了宿主进程。
- **开关即时生效，源码改动重启。** 改 `enabled` 会重读声明、重建供给、一次替换列表；
  改扩展的 `.py` 源码要重启宿主——**没有"重新识别"那个按钮**，理由见下。

## 一张清单，一张契约表

每一条写明 `type`，`type` 决定**必填项是哪几条**。契约表只有一张，住在 `manifest.py` 里：

| `type` | 必填 | 有安全默认的可选 |
| --- | --- | --- |
| `tools` | `name` · `approval_required` · **（`url` 或 `entrypoint`，恰好一个）** | `idempotency` |
| `executors` | `name` · **（`worker` 或 `executor`，恰好一个）** | `needs_llm` · `model` · `prompt` · `parameters` · `tools_from` · `tighten` |
| `schedules` | `name` · `cron` · `task_ref` | `timezone` · `executor_ref` · `enabled` |
| `providers` | `name` · `base_url` · `api_key_env` | `models` · `enabled` |

**`schedules` 和 `providers` 不住在包里**——它们各有自己的文件（见下），但走的是同一张表。

**判据**：必填 = **缺了它注册器就必须拒绝**，因为它猜不出来；可选 = 缺了能填一个
**安全的**默认值。

今天"哪些栏必须有"从来没有一处说过——它是逐条 `if` 拼出来的（`capability` 包拒绝
`executors`、`executor` 包拒绝 `tools`、`SUPPORTED_TYPES` 挡在门口）。**那些 `if`
就是这张表**，只是散在三个加载器里。

**所有必填项都在扫描期可校验**——它们不需要跑任何代码就能读到。所以"扫描 = 登记"
这条是完整的：**能被登记的，就一定被校验过。**

**两处「恰好一个」是同一条规矩**：同一个东西不能用两种办法声明。

## 供应商独立放，跟日程同级

一家模型服务一个文件，住在 `extensions/_providers/<name>.yaml`：

```yaml
# extensions/_providers/deepseek.yaml
name: deepseek
enabled: true
base_url: https://api.deepseek.com/v1
api_key_env: DEEPSEEK_API_KEY
models:
  - name: deepseek-flash
  - name: deepseek-v4-pro
    context: 128000
    parameters: {temperature: 0, max_tokens: 8192}
```

**它凭什么是独立的一份，而不是一个扩展包**：它的干货就是"**怎么连** + **一张模型目录**"
——这两样都是**数据**。装在包里，它要连带背一个包的结构，而包里那两段（`tools` /
`executors`）它一栏都用不上。

**这也拔掉了 `extends` 的根**：`deepseek` / `uniapi` 那两个包存在的唯一理由就是登记这些
信息——包没了，靠"借 worker"撑起来的那个概念也没了。

**模型的事实（上下文长度那种）跟着 `models[]` 走**——它是**事实**，不是配置，
不该让每个执行者重写一遍。

## 日程独立放，不嵌在包里

一条日程一个文件，住在 `extensions/_schedules/<name>.yaml`：

```yaml
# extensions/_schedules/weather-daily.yaml
name: weather.daily
enabled: true
cron: "0 8 * * *"
timezone: Asia/Shanghai
task_ref: inputs/weather-daily.md
executor_ref: weather.collect
```

**形状和清单里那段一模一样**，走同一张契约表。装一个包**不会**自动带来日程。

### 为什么不嵌在包里

| 理由 | 展开 |
| --- | --- |
| **炸的范围小** | 嵌在包里，日程写错一个缩进就毁掉**整个包**（连它的工具和执行者一起）。一条一个文件，炸的就是那一条 |
| **它是天天要改的东西** | 今天一条天气，明天要加一条别的。分开之后加一条日程 = **加一个文件**，不碰任何包 |
| **不造规则** | 嵌合会自己造出三条要回答的问题：包被禁用了它带的日程算什么、删包要不要删日程、日程的开关和包的开关谁说了算。**独立之后这三条都不存在** |

**为什么不是一个大 `schedules.yaml`**：那样只是把问题缩小——一个语法错误仍然毁掉
**所有**日程。一条一个文件，炸的范围就是那一条。

**代价**：注册器多一个扫描目标（不是一套新逻辑，同一张契约表）。

## 工具：两种供给，但**供给方对句柄没有发言权**

| 工具住在哪 | 怎么写 | 你怎么知道它有什么 |
| --- | --- | --- |
| **外面**（MCP 服务器） | `url: http://127.0.0.1:8931/mcp` | **问它**——`tools/list`。它没有"函数"这个概念，是个协议端点 |
| **包里**（Python） | `entrypoint: provider.py:Weather` | **读它有哪些函数**——它就是个对象 |

### 包里那种：注册时实例化一次，成为一个单例

```python
# provider.py
class Weather:
    def __init__(self):
        self.config = yaml.safe_load((Path(__file__).parent / "config.yaml").read_text())

    def current(self, city: str) -> dict: ...   # ← 一个工具
    def wind(self, city: str) -> dict: ...      # ← 另一个工具
```

**单例的函数就是工具，调用就是直接调那个函数。** 不走 MCP，不起进程，没有握手。
包的配置（城市表、endpoint）由**包自己读**——宿主不参与。

**MCP 那一套只服务外部服务器。** `mcp_client.py` 里没有 `spawn`，也没有壳。
（想过给包内实现套一个通用外壳把它包成 MCP——**那是多余的一层**，砍了。）

**代价要认**：包内实现就住在宿主进程里，所以"工具代码永不进宿主进程"这条
**对包内供给不成立**。禁用会从当前列表移除工具并释放供给持有的实例引用；已导入的 Python 模块
仍留在宿主进程，要到重启才彻底卸载（这就是"改源码重启"那条的代价）。

### 句柄是 gateway 的，不是供给方的

包内单例、MCP 连接，都只是**实现**。工具**在系统里**长什么样——叫什么、要不要人批、
谁允许调——**归 Capability 这一线，gateway 直接管**。

**为什么必须是这样**：句柄如果由供给方递出去，谁拿到句柄谁就能调，**判决就被绕过了**。
句柄从 gateway 出去，"调一次 = 判一次"才是**结构上**成立的，不靠纪律。

所以包作者和 agent 作者看到的永远是"一堆函数"，进程和协议藏在后面。

## 参数分三类，别混

| 类 | 例子 | 谁定 |
| --- | --- | --- |
| **身份** | 供应商 · `base_url` · `api_key_env` | **执行者自带**——猜就是错的 |
| **模型的事实** | 上下文长度 · 支不支持工具调用 | 跟**模型目录**走——这是事实，不是配置 |
| **旋钮** | temperature · max_tokens · timeout | 执行者给默认，使用方可覆盖 |

**使用方只用传两样**：选哪个模型、用哪些工具。供应商是执行者的身份，工具句柄由
gateway 解析出来——都不该由使用方递。

**旋钮写一份声明**，界面和 worker 各取所需：

```yaml
parameters:
  temperature: {type: number, default: 0.2, min: 0, max: 2, label: Temperature}
  max_tokens:  {type: integer, default: 4096, min: 1, max: 16384}
```

界面从这份声明**渲染控件**；worker 收到的是**解析后的值**，它不知道"有默认值这回事"。
今天 `defaults` 写一遍默认值、`allowed_parameters` 再写一遍范围——**同一件事写两遍，
而且写的还不是同一层的东西**，那一大坨删掉。

**合并发生在装配期，worker 收终值。**

## 执行者：一段代码，或者"基于一段代码的配置"

**两种来源，同一个列表。**

| | 怎么写 | 是什么 |
| --- | --- | --- |
| **自己带代码** | `worker: {entrypoint: "worker.py:worker_entry"}` | 一段 worker |
| **基于另一个** | `executor: langgraph.agent` + `model:` / `prompt:` / `tools_from:` | **配置后的执行者** |

**智能体不是另一个范畴——它就是"配置后的执行者"。** 所以 Task 引用的永远是执行者，
它可能是裸的（`weather`），也可能是配置过的（`ops-readonly`）。

**一段代码被多个配置用**：

```yaml
# langgraph-agent：那个 LLM 循环，只有这一份
- name: langgraph.agent
  needs_llm: true
  worker: {entrypoint: "worker.py:worker_entry"}

# ops-readonly：配置后的执行者
- name: ops-readonly
  executor: langgraph.agent
  model: {provider: deepseek, name: deepseek-v4-pro}
  prompt: {system: "你是 OCC 的运维执行者……"}
  tools_from: [workspace]
  tighten: [workspace.search_text]
```

**`needs_llm` 是"要模型"的声明，`model` 是"用哪个模型"。** 前者长在带代码的那个执行者上，
后者长在配置上——**基于一个 `needs_llm` 的执行者，`model` 就是必填**。没有这条，
"缺了模型"是**静默**的：跑到一半才发现。

## 一个包可以有几条执行者

**没有"一包一个"这条规则。** 一个包有 2 个硬编码函数，那就是 2 条执行者：

```yaml
executors:
  - name: weather.collect
    worker: {entrypoint: "worker.py:collect_entry"}
  - name: weather.alert
    worker: {entrypoint: "worker.py:alert_entry"}
```

**条目名写全名，不写短名。** 短名（`collect` / `alert`）重复率高、也看不出是谁的；
全名一眼知道它属于哪个包。一条的时候，全名通常就是包名。

**所以撞名检查有三层，全在扫描期**：

| 判什么 | 范围 |
| --- | --- |
| 包名（`id`） | 全部扫到的包 |
| 条目名（`tools.name` / `executors.name`） | 各自的类里 |
| 工具的**全名** | **不用判**——它是 `供给名.函数名`，而供给名已唯一、一台供给内的函数名天生唯一 |

**没有"一个大命名空间"，每类各管各的**——因为**一个名字的含义由它的词条决定**：
一家叫 `weather` 的供应商和一个叫 `weather` 的包是两回事，前端靠词条就分得开。

**唯一要跨类对上的，是"工具全名"和"执行者名"——而那是故意的**：对上了，就是同一个
函数的两个身份（见上一节）。**它不是撞名，是缝合。**

**那 `deepseek` 当年为什么是错的？** 它也有两条——**但两条的区别是模型名**。错的不是
"一包两条"，是**一个本该是配置的维度被抬成了身份**：于是"换模型"变成"换执行者"，
Task 上的引用跟着变、checkpoint namespace 跟着变。

**模型现在在配置里选**（上一节的 `model:`），所以那个错误不可能再犯。
同步脚本也从"改包的结构"降级成"填供应商的模型目录"（`extensions/_providers/`）。

**入口函数被跑一遍就是执行。** 没有"轻的/重的"两种形态——跑 LLM 的是一次，
采集一次也是一次。（入口函数的契约和终态规则都在 `tasks/channel.py`。）

## 同一个函数可以有两个身份

一个函数可以**同时是工具和执行者**：作为工具，agent 能**调**它（走判决）；
作为执行者，日程能**跑**它（起进程）。

**声明上它是两条**，因为那是两种不同的用法：

```yaml
tools:
  - name: weather
    approval_required: false
    entrypoint: provider.py:Weather        # 单例

executors:
  - name: weather.collect                  # ← 和单例的 collect 同名
    worker: {entrypoint: "provider.py:collect"}
```

**缝起来的是名字**：工具的全名是 `供给名.函数名`（`weather.collect`），执行者的全名是
它自己写的那个。**同名就是同一个函数**——前端把它们显示成一个节点、两个词条。

**所以"写全名"不只是好读**：它还是**把两段声明缝成一个东西**的那根线。这就是
"一条的时候全名通常就是包名"的另一面——名字不是标签，是**身份**。

## 引用的目标要能说清

`executor:` / `tools_from` / `provider` 都是**跨声明容器的引用**。引用的目标
不存在、还是被禁用了，**诊断要分开说**——那是两件不同的事：一个你写错了名字，
一个那东西还在、只是关着。

## 开关即时生效，改源码重启

改 `enabled` 之后这条路径是固定的：**重读所有声明 → 加载当前启用项 → 一次替换四个列表**。
不做逐包增量更新（那要处理"改了一半"的各种中间态），也不卸载旧 Python 模块。

| 改什么 | 怎么生效 |
| --- | --- |
| 声明里的 `enabled` | **当场**——重读声明、重建供给、一次替换列表 |
| 包里的 `.py` 源码 | **重启宿主** |

**"重新识别"那个按钮没有了。** 它当年存在的唯一理由是"改 `.py` 源码之后热替换"，而那需要
维护一整套全目录卸载（清 `sys.modules`、认领合成包、处理命名空间包的惰性 `__path__`）。
**换来的只有那一格，而那一格用重启解决。** `runtime.py` 现在只剩一个对外函数
（`load_entrypoint`），它仍然负责包内相对导入、入口越界检查，以及**本次加载失败时**清掉
新冒出来的半初始化模块——那是为了不留半个状态，不是为了热替换。

（同一秒内、大小不变的文件会被 `.pyc` 判成没过期，读到旧字节码。重启能解。）

**正在跑的 Task 不受影响**：它们手里是 stub，**下次调用时工具不在了就会被拒绝**，
不会崩；已导入的 Python 模块留在进程里，直到重启。

## MCP 客户端：协议交给库

`mcp_client.py` 是 `fastmcp` 之上的一层薄适配，**不自己维护 JSON-RPC、SSE 和会话协议**。
它只剩下三件库不管的事：

| 它管什么 | 为什么在这里 |
| --- | --- |
| 同步/异步的桥 | 调用方是同步的，库是 async 的 |
| **超时** | "它没起"是常态，不能让一台服务器挡住别的包 |
| 把失败翻成人话（`McpError`） | 上层拿它去记一条诊断，不是崩掉 |

`tools.py` 依赖的还是那两个形状：`list_tools` / `call_tool`。**没有 stdio**——
那是"起一个子进程"的传输，而这条路里宿主不起任何进程。

（手写协议那一版有一条测试是钉"通知插在答复前面，管道不能错位"的：那是库的活了，
测试留在 `tests/test_mcp.py` 里当回归线。）

## 供给对象：一个数据对象

`Supply` 就是**工具清单 + 关闭动作**。两种来源的差异只留在构造它的那两段代码里：
外部那种传一个关连接的 `release`，包内那种不传——把清单丢掉，那些调用闭包就没人引用了，
**包内的单例跟着被 GC 收走**（`tests/test_supply.py` 里有一条用 `weakref` 钉着它）。

去掉了：只区分来源的两个子类、没人用的上下文管理接口。

`tools.py` 读字符串注解改用 `typing.get_type_hints()`，不再自己 `eval`。它是**一条绳上的**——
一个名字解析不出来整批注解一起失败——所以失败时退回逐条求值，能解析的仍然算数。

### 两项小修正

- **布尔声明只认真布尔**（或那几种明确写法），不用 `bool(value)`：`"false"` 是个非空字符串，
  `bool("false")` 是**真**——那一格写错一个引号，开关就静默地反了。认不出的写法当场拒。
- **普通异常在单扩展边界转成诊断**，接着加载别的；半建的资源先收掉再往上抛
  （`tools.py` 里先关连接）。**真·进程级中断不接**（`KeyboardInterrupt` / `SystemExit`）——
  那时候"接着加载别的包"不是你想要的事。

## 一句写坏的 cron 不是一份合法声明

`cron` 是 `schedules` 的必填栏，而"这句话解不解得开"**不用跑代码就知道**。所以它在
`manifest.py` 里校验（登记时 + 写入时都过一遍）——不这样的话，你能写进去一条永远不会跑的
日程，而**用户以为它跑过了**。

解析器住在 `manifest.py`（声明的形状），派发那边（`tasks/scheduler.py`）import 它来对时间。

## 登记与加载是两段，禁用的东西也在列表里

**扫描 = 登记，加载 = 可用。**

| 对象的状态 | 进列表？ | 能用？ | 代码进宿主进程？ |
| --- | --- | --- | --- |
| 清单有效 + `enabled: true` + 加载成功 | ✓ | ✓ | ✓ |
| 清单有效 + `enabled: false` | **✓** | ✗ | ✗ |
| 清单有效 + 加载失败（撞名、连不上、import 错） | ✓ | ✗ | 看走到哪一步 |
| **清单读不出来 / 必填项缺失** | ✗ | ✗ | ✗ |

**为什么关着的也要登记：前后端用同一份事实。** 那四个列表**就是前端渲染的依据**——
关着的包不进列表，前端就只能自己另编一套"关着的扩展"的概念，于是同一件事又变成
两处在说，而它们会漂移。关着的它在列表里答"已下线"，前端照常渲染，只是点不动。

**只有连必填项都过不了的包才禁止注册和使用。**

一个不变的后果：禁用的包**代码不进宿主进程**（ADR-029 要的就是这个），所以"启用"是一次
真的加载。禁用后不会再被列表调用；此前导入的代码仍留在进程里，重启之后才彻底卸载。

## 智能体就是一个包

**它就是执行者，只是配置过的那个。** 所以它没有自己的容器、自己的类型、自己的机制——
它是清单上的一个 `executors` 条目，只是写 `executor:` 而不是 `worker:`：

```yaml
id: ops-readonly
enabled: true
executors:
  - name: ops-readonly
    executor: langgraph.agent          # 基于哪段代码
    model: {provider: deepseek, name: deepseek-v4-pro}
    prompt: {system: "你是 OCC 的运维执行者……"}
    tools_from: [workspace]
    tighten: [workspace.search_text]   # 可选：只能更严（ADR-027）
```

界面上"创建一个智能体" = **写一个新包目录 + 清单**，走 `writer.py` 同一条路。

**Task 引用它，跟引用 `weather` 一样**——两者都是执行者，名字进的是同一个列表。
"这是个智能体"不是一种类型，是"它的执行者是基于别人的"这件事读出来的结果。

**改了智能体，历史 Task 就按新的解释**——没有版本，一切按最新的来。这跟"改动是破坏性
的"（ADR-033）是同一条：**清单是唯一事实，它没有历史版本**。
