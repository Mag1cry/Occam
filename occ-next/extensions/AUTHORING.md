# 写一个扩展包

这份是给**写包的人**看的：一个包要长什么样、哪些话必须照着说、清单里每一栏是什么意思。
（想先看系统怎么加载它们，读 [`src/extensions/README.md`](../src/extensions/README.md)；
想先看目录长什么样，读同目录的 [`README.md`](README.md)。）

照着这儿写，一个包**不需要改宿主的任何一行代码**就能被登记、被界面看见、被 Task 跑起来。

---

## 一、一个包是什么

`extensions/` 下的**一个目录**就是一个包，目录里**必须有 `manifest.yaml`**：

```text
extensions/
├─ weather/            ← 一个包
│  ├─ manifest.yaml    ← 清单（只能叫这个名字，`.yml` 直接拒）
│  ├─ config.yaml      ← 包自己的配置，包自己读（宿主不参与）
│  ├─ provider.py      ← 工具的实现
│  └─ worker.py        ← 执行者的实现
└─ _schedules/         ← 下划线开头 = **不是包**，是独立声明的存放处
```

三条硬规矩：

1. **清单只能叫 `manifest.yaml`**——`.yml` 会被拒（两处判断不一致过一次，现在只有一处）。
2. **下划线开头的目录不是包**，扫描器不看它（那是给 `_providers/`、`_schedules/` 留的）。
3. **包没有"类型"**。包里有四类条目，随便怎么混（天气包既有工具又有执行者）：

| 条目 | 它是什么 | 谁用它 |
| --- | --- | --- |
| `tools` | 一台**供给**：一组工具（包内单例，或一台外部 MCP 服务器） | 执行者调它 |
| `executors` | 一段**能跑的东西**（worker），或基于别人那段代码的**配置** | Task 引用它 |
| `schedules` | 定时派发（通常放 `_schedules/` 独立成文件，见第七节） | 调度器 |
| `providers` | 一家模型供应商：怎么连 + 它有哪些模型（放 `_providers/`） | 配置界面 |

---

## 二、最小可用：一个工具包

`manifest.yaml`：

```yaml
id: echo
name: 回声
tools:
  - name: echo                  # ← 供给名。工具的全名会是 `echo.say`
    approval_required: false    # ← 调之前要不要人点头（必填，见第五节）
    entrypoint: provider.py:Echo
enabled: true
```

`provider.py`：

```python
class Echo:
    """回声。"""                       # ← 类的说明给人看

    def __init__(self) -> None:
        # 只跑一次（宿主注册时实例化一次，之后每次调用都是同一个对象）。
        # 要读配置就读旁边那份 config.yaml——包自己的配置由包自己读。

    def say(self, text: str) -> dict:
        """把这句话回一遍。"""          # ← docstring 第一行 = 工具描述，**模型靠它选工具**
        return {"text": text, "length": len(text)}
```

这么写完之后：`echo` 这台供给会被登记，它有一个工具 **`echo.say`**，参数 `text`（必填，
字符串）。执行者在清单里写 `tools_from: [echo]` 就能调它。

### 工具是怎么从你的类里"发现"出来的

- **公开方法就是工具**：名字是工具名（`say` → `echo.say`，`echo` 是清单里那一栏的 `name`）。
- **`_` 开头的、`@property`、dunder 都不算工具。**
- **参数 schema 从签名读**（`src/extensions/tools.py::schema_from_signature`），
  **清单里没有 `input_schema` 这一栏**——写两遍就会漂移，所以只留一处真相。
  - 认得的类型：`str`/`int`/`float`/`bool`/`list`/`dict`，以及 `X | None`（取里面那个）；
    认不出的**留空**，不猜一个 `string` 出来。
  - 没有默认值的参数 = 必填；有默认值的写进 `default`。
  - **函数说明取 docstring 的第一行**，所以第一行要写"这个工具干什么"，别写"TODO"。
- **失败就抛，不要吞。** 你抛什么，宿主的调用管线把它翻成一次失败的调用结果交给模型；
  返回一个 `{"ok": false}` 只是让模型收到一份长得像数据的错误。

### 单例的代价：会被并发调用

同一个 Task 的监听是一个线程，多个 Task 同时跑就会**同时**进到你的方法里。所以
别在方法里存"这次调用的状态"（存进去的下一句就可能被另一个 Task 读到）。
要状态就用局部变量，或者自己加锁。

---

## 三、执行者：契约一到四

一个执行者就是**一段跑在子进程里的 Python**。它跟宿主只有一条管道说话——这不是靠纪律，
是结构：它在另一个进程里，手里除了那条管道什么都没有。

### 契约一：入口长这样

```python
def worker_entry(connection, task_data, config_data, input_text,
                 database_path, resume_value=None) -> None:
    from src.tasks.channel import WorkerChannel
    channel = WorkerChannel(connection, str(task_data["task_id"]))
    ...
```

清单里写它：`worker: {entrypoint: "worker.py:worker_entry"}`。

- 六个位置参数，一个都不能少、不能改名。
- `resume_value` 是**上次停下来时留下的那个东西**（审批恢复时是 checkpoint 引用）；
  第一次跑是 `None`。
- `database_path` 是**你自己的数据**（checkpoint、结果），**不是控制库**——Worker 从不
  打开控制库：它不认识 Task 表，也不该认识。

### 契约二：能说的收尾只有三种

```python
channel.report(COMPLETED,   {"checkpoint_ref": ..., "result_ref": ...})
channel.report(INTERRUPTED, {"checkpoint_ref": ...})     # ← 我停下来等审批
channel.report(FAILED,      {"reason": ...})
```

| 它说什么 | 那是什么意思 | Task 落到哪 |
| --- | --- | --- |
| `COMPLETED` | 正常退出，结果取**最后一次的输出** | `succeeded` |
| `INTERRUPTED` | **停下来等审批**（必须指名是哪个工具） | `paused` |
| `FAILED` | 其他任何异常 | `failed` |

**左边是"你怎么说"，右边是"那意味着什么"——两套词，别混。** 你不对错误分类：
"这是网络问题还是参数问题"不是你要回答的，你只说"我是怎么结束的"。
所以这里只有三个词，没有第四个——多一个立刻要回答"那它落到哪个状态"。

### 契约三：要工具只有一条路

```python
result = channel.request_tool("weather.current", {"city": "上海"})
if not result.ok:
    ...   # result.error 是为什么（可能还没批：result.decision == 'needs_approval'）
```

- **这是唯一的办法**：不是靠纪律，是靠它手里没有别的东西。
- **不用送参数指纹**：指纹由宿主从 `params` 现算——你算的那个它不会信，送了也是白送。
- **这条管道不做去重**：同一个调用发两次就是**两次调用**。所以别在超时之后盲目重试——
  你超时了，但你不知道对面做没做。**"重试安不安全"由工具自己的 `idempotency` 声明回答**，
  不由管道替你猜。
- 答复有三种：`ok`（跑了，`result` 里是返回值）、`needs_approval`（停在这儿等人批）、
  `deny`（不许，`error` 里是为什么）。

### 契约四：给模型的是 schema，不是句柄

写 LLM 循环时，**绑字典，不要绑转发用的 stub**：

```python
model.bind_tools([{"name": t.name, "description": t.description,
                   "parameters": t.input_schema} for t in tool_specs])
for call in response.tool_calls:            # 模型只会吐名字 + 参数
    result = channel.request_tool(call["name"], call["args"])
```

绑字典的话，**框架手里根本没有能跑的东西**（`ToolNode` 要的是 callable，字典它执行不了）——
所以你的循环必须自己补上 `ToolNode` 平时替你做的四件事：

1. 工具异常**捕成 `ToolMessage`**（不然一个工具错误炸掉整个图）；
2. `tool_call_id` 必填；
3. `max_iterations`（不然模型可以无限调下去）；
4. 异步那一份要自己写。

`extensions/langgraph-agent/graph.py` 是照这条写的完整例子。

---

## 四、带模型的执行者（基座）与"配置后的执行者"

**一段代码可以被好几个配置用。** 这在清单里是两条**不同的**条目：

```yaml
executors:
  # 基座：自己带代码。它**不挑模型**——模型是配置给的。
  - name: langgraph.agent
    worker: {entrypoint: "worker.py:worker_entry"}
    needs_llm: true
    parameters:
      temperature: {type: number, default: 0.2, min: 0, max: 2, label: 温度}

  # 配置：基于上面那段代码，给它模型、提示词、能用哪些工具
  - name: ops-readonly
    executor: langgraph.agent                      # ← 基于哪段代码
    model: {provider: deepseek, name: deepseek-v4-pro}
    prompt: {system: "你是 OCC 的运维执行者……"}
    tools_from: [weather]                          # ← 允许用哪几台供给
    tighten: [weather.current]                     # ← 可选：把某几条收紧成必须审批
```

几条规则：

- `worker` 和 `executor` **恰好写一个**（都写或都不写都会在扫描期被拒）。
- **基座必须存在**，而且**不能基于一个"配置"**（基座只能是自己带代码的那种）——
  链式继承要处理环、顺序、改一层动一串，而这里要解决的问题一步就够。
  基座找不到时：这条**照样登记**（写在清单里的事实不能消失），但标成起不来。
- `needs_llm: true` 的那条**必须**由配置给出 `model`——不给，登记那一步就拒
  （"跑到一半才发现"是最糟的发现方式）。
- **`tools_from` 是白名单**：名单为空 = **一个工具都不许**（默认拒绝，不是默认允许）。
  名字写的是 `tools` 那条的 `name`（供给名），不是包名。
- **`tighten` 只能收紧**：工具要不要审批由**声明它的那台供给**（`approval_required`）定地板，
  配置只能把不要审批的收紧成要审批，不能反过来放宽。

### `parameters`：两条写法，一个含义

```yaml
# 基座里：说清这个旋钮是什么
parameters:
  temperature: {type: number, default: 0.2, min: 0, max: 2, label: 温度}

# 配置里：只改默认值
parameters:
  temperature: 0.6          # ← 标量 = 改默认值，范围和标签还是基座说的
```

**值是对象 → 它是一份声明；值是标量 → 它是在改默认值。** 两条规则各一种写法，
读的人不需要上下文。合并发生在装配期，**worker 收到的是终值**——它不知道"有默认值这回事"。

包层还有 `defaults:`，会把同一份默认值发给这个包里每条执行者（少写几遍）。

---

## 五、交付结果与审计：adapter（可选）

结果**归执行者的包**——内核只存一个 `result_ref`。要让人查得到，包在 `worker.py` 旁边放一个
`adapter.py`，约定一个 `get_adapter(config, database_path)`：

```python
def get_adapter(config, database_path) -> Adapter: ...   # 存在就自动认

class Adapter(Protocol):
    def checkpoint_exists(self, task, checkpoint_ref, database_path) -> bool: ...  # 必须有
    def read_result(self, task, database_path) -> dict: ...                        # 必须有
    def read_audit(self, task, database_path) -> dict: ...                         # 可选
```

- **它不参与启动，纯读。**
- 缺 `checkpoint_exists` / `read_result` 里的任何一个，**加载时就拒**（不是等到调用现场才炸）；
  `read_audit` 确实可选。
- **不提供 adapter 也行**：那结果就是短命的——跑完在宿主内存里，重启就没了。
  **那是你的选择**：内核凭什么替一个它不认识的执行者决定结果存哪、存多久。

---

## 六、包自己的配置：`config.yaml`

清单说的是"**它在哪、我们允不允许用**"；服务器地址、城市表、超时这些说"**它怎么干活**"。

**后者归包自己**：在包目录里放一份 `config.yaml`，在 `__init__` 里自己读。
这样改配置不用碰声明，改审批要求不用碰配置。宿主全程不参与，也不认识那个文件。

（`weather/provider.py` 就是这么干的；顺带一提，`config.yaml` **不是**清单的一部分，
里面的键不受清单契约表约束。）

---

## 七、独立声明：`_providers/` 与 `_schedules/`

日程和供应商**一条一个文件**，不塞进包的清单：

```text
extensions/_schedules/weather-daily.yaml
extensions/_providers/deepseek.yaml
```

```yaml
# _schedules 里的一条
name: weather.daily          # ← 它的名字是这一栏，**不是文件名**
cron: "0 8 * * *"            # 5 段：分 时 日 月 星期
timezone: Asia/Shanghai
task_ref: inputs/weather-daily.md    # 工作区里那份正文；读不到就是「任务输入不存在」
executor_ref: weather.collect        # 跑哪条执行者（写全名）

# _providers 里的一条
name: deepseek
base_url: https://api.deepseek.com/v1
api_key_env: DEEPSEEK_API_KEY        # ← 密钥只写**变量名**，值由 worker 自己从环境读
models:
  - name: deepseek-flash
```

为什么独立：**嵌在包里的话，一个缩进写错就毁掉整个包**；独立之后"加一条日程"就是加一个文件。

---

## 八、加载、生效与排错

- **两趟加载**：先"自己带代码的"，再"基于别人的"——因为基座可能在**后一个包里**被读到。
- **一个坏包不拖垮别的**：谁也不认识的那个键、读不出来的 YAML，都只毁掉**那一个**包，
  其余的照常登记。坏包会留下一条**诊断**（哪个包、哪一步、为什么）。
  - 注意：诊断**只活在内存里**，`/api/state` 目前没有它的出口（已知欠账，
    重启之后"上次为什么没起来"就没了）。所以排查时先看启动日志/直接问加载器。
- **改清单 = 立刻生效**（重扫一遍）；**改 `.py` 源码要重启宿主**——已经 import 过的模块
  改不了，这是取舍，不是缺陷。
- `enabled: false` **不等于不存在**：关着的包照样登记（界面看得见、点不动），只是不加载它的代码。
- **`approval_required` 是地板**：写了 `true` 就是"每次调用都要人点头"，配置只能更严。

---

## 九、会被拒的常见写法（自查表）

| 写法 | 为什么被拒 |
| --- | --- |
| 清单里出现契约表没有的键（`approval_require`、`risk_level`…） | **不认识的键 = 拒绝**。放行一次拼写错误，就是放行一次静默失效 |
| 文件叫 `manifest.yml` | 只认 `.yaml` |
| 同时写了 `url:` 和 `entrypoint:`（或都不写） | "恰好一个" |
| `entrypoint` 指到包目录外面（`../shared/util.py:run`） | 入口必须落在包目录里——这是"这个包提供了什么"的边界 |
| `tools` 条目的 `name` 和别的包撞了 | 工具全名 `<供给名>.<方法名>` 必须唯一 |
| `executor:` 指向的那条基座不存在 | 登记但标成起不来（改完清单重启/重扫即可） |
| `cron` 不是 5 段 | 写坏的 cron 不是一份合法声明——"哪天早上它没跑"那时才发现就晚了 |
| 把密钥写进清单 | 只写**变量名**（`api_key_env`）。密钥不进声明、不进事件、不进界面 |

---

## 十、写的时候怎么验

1. **放到 `extensions/` 下，起服务看一眼**：

   ```powershell
   uv run python -m src.serve
   # 另一个终端
   curl http://127.0.0.1:8765/api/state
   ```

   `registry` 里有你的包/工具/执行者，`console` 里有它在文件树上的位置，就是登记上了。
2. **要跑一遍**：界面里建一条 Task 选你的执行者；或者建一条日程指向它。
3. **要写测试**：`tests/support/newtree.py` 是一份"最小可跑的例子"（一个包 + 一条日程 +
   一家供应商 + 几种 worker），照它搭一个临时树就能断言"加载成什么样、跑完落到哪个状态"。
   `tests/test_extension_loading.py` 是加载期的边界用例。

## 参考实现

| 想看什么 | 看哪儿 |
| --- | --- |
| 工具 + 执行者 + 自己的 `config.yaml`，一个包里全有 | [`weather/`](weather/) |
| 新契约的 LLM 循环（契约一~四都照做） | [`langgraph-agent/`](langgraph-agent/) |
| 一家供应商的模型目录 | [`_providers/deepseek.yaml`](_providers/deepseek.yaml) |
| 一条日程 | [`_schedules/weather-daily.yaml`](_schedules/weather-daily.yaml) |
