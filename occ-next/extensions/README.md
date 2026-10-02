# extensions/ — 这台机器上装了哪些扩展

**怎么写一个包，看 [`AUTHORING.md`](AUTHORING.md)**——清单每一栏什么意思、worker 要遵守的
四条契约、工具怎么被发现、会被拒的常见写法。这一页只说这个目录**长什么样**。

（想再往深一层，读 [`../src/extensions/README.md`](../src/extensions/README.md)：
那是宿主那一侧的实现说明，契约的出处都在那儿。）

```text
extensions/
├─ _providers/       一家一个文件：怎么连 + 它有哪些模型
│  ├─ deepseek.yaml
│  └─ uniapi.yaml
├─ _schedules/       一条日程一个文件
│  └─ weather-daily.yaml
├─ weather/          一个包：manifest.yaml + 它自己的代码 + 它自己的配置
│  ├─ manifest.yaml
│  ├─ config.yaml    ← 包自己读，宿主不参与
│  ├─ provider.py    ← `tools` 那个入口：公开方法就是工具
│  └─ worker.py      ← `executors` 那个入口：六个参数、只会说话
├─ langgraph-agent/  带代码的基座执行者（一段代码，好几个配置）
├─ heart-rate-watch/ 一份设计笔记，**不是包**（没有 manifest.yaml，扫描器不看它）
└─ _todo/            以后要做的插件（**也不是包**，见它自己的 README）
```

## 三条规矩

- **清单只能用 `manifest.yaml`**，`.yml` 直接拒（两处判断不一致过一次，现在只有一处）。
- **下划线开头的目录不是包**：`_providers` / `_schedules` 是那两类独立声明的容器，
  `_todo` 是一份笔记。扫描器按名字跳过它们，所以放什么进去都不影响运行。
- **不认识的键 = 拒绝**。清单上出现契约表里没有的栏，扫描期就拒——放行一个不认识的键，
  等于放行一次拼写错误（`approval_require` 少一个 `d`，在"忽略未知键"的策略下会**静默**
  变成"没写这一栏"，而它是必填的）。

## 这里的东西是你会改的

所以**执行者的数据不写在这儿**（那是 `../data/` 的事），而改完 `.py` 源码要**重启宿主**
才生效——声明是每次启停都重读的，源码不是。
