"""**唯一能写声明的地方**：包清单和日程文件，都是它写。

写是**破坏性**的：没有撤销、没有版本、没有 diff 门槛（ADR-033）。

## 三个容器，同一套动作

| 写什么 | 谁能发起 |
| --- | --- |
| `extensions/<id>/manifest.yaml` | 改开关、改字段、建包、删包 |
| `extensions/_schedules/<name>.yaml` | 改开关、改字段、建日程、删日程 |
| `extensions/_providers/<name>.yaml` | 改开关、改字段、建供应商、删供应商 |

动作完全一样，所以在一处：**读 → 改 → 校验 → 原子替换**。

（**加一家供应商也是写文件**，不是什么新机制——它只是第三个容器。）

## 三样东西，各有一个理由

| 做法 | 为什么 |
| --- | --- |
| **往返模式（RoundTrip）YAML** | 保留注释和缩进——写回去的文件**还能被人读**。清单是人天天要看的东西 |
| **写前校验** | 把**将要写出去的文本**当作真清单过一遍 `manifest.py` 那张表。不然你能写进去一个自己起不来的包，**要到下次重启才发现** |
| **原子替换** | 不会留下半个文件。留半个，下次扫描读到的就是它 |

## 只改已存在的字段——**`enabled` 是唯一的例外**

`set_field` 不支持新增。手滑加一栏会被拒——因为**新增字段等于改声明，那是另一件事**，
该走"建包"（`manifest.create`）。这条界限看着严，但它是唯一能挡住
"我以为我改了个值，其实我改了这个东西是什么"的办法。

**`enabled` 例外，因为它两边都不算。** 它不回答"这个东西长什么样"，只回答
"这台机器上要不要用它"——而"关掉一个东西"**恰恰就是写这一行**。一份干净的清单里
本来就没有它（它是可选栏）。

**没有这个例外，配置舱的开关按钮是死的**：最常用的那个动作，会被规则自己拒掉。

四个地方一样：包一行、条目一行、日程一行、供应商一行。

## 为什么只有它能写

清单是**唯一事实**。多一个写者，就多一处能漂移。

今天那个"**暂停的日程，重启之后自己又开了**"就是第二个写者造出来的：`app/build.py`
每次启动把清单写回配置库。删掉那个写者之后，这条 bug 没有存在的余地。

**加载器只读，不写。** 它读的是别人写下的东西。

## 公开面：四个函数 + 一个类

| 函数 | 干什么 |
| --- | --- |
| `read_document` | 把一份声明读成**可往返的对象**（ruamel RoundTrip）——注释、缩进、键序都在里面 |
| `set_field` | 改**顶层**的一个字段。只改已存在的字段，`enabled` 例外 |
| `create_document` | 新建一份声明（建包 / 建日程 / 建供应商）。父目录自动创建 |
| `delete_document` | 删掉一份声明。**不可撤销**（ADR-033），所以引用检查归调用方 |

上面四个说的是"**怎么把一段文本安全地落盘**"。`Declarations` 说"**落在哪、做哪个动作**"：
三个容器 × 四个动作（`set_enabled` / `set_field` / `create` / `delete`），
**路径怎么拼只有那一处**（`TARGETS`）。

三个容器走同一条路，因为它们本来就是同一种东西：一份 yaml 声明。包清单和另外两个的
差别在**加载器**那边（谁扫它、它有哪些栏），不在这里。

## 校验是**注入**的

`validate` 是一个回调——通常是 `manifest.py` 的校验函数，由调用方传进来。它收到的是
**将要写出去的那段文本**：不是磁盘上的旧文本、也不是内存里的那个对象。所以校验能连
ruamel 的序列化怪癖一起验到（缩进、引号、折行都会体现在那段文本里）。

**本文件不 import `manifest.py`**：形状的契约只有一份，但那份契约不该由写手来拥有——
写手只管"怎么把一段文本安全地落盘"，"一段声明合法不合法"是别人的事。

校验失败**不落盘**，也不留下临时文件。

## 写盘的两条硬规矩

- **LF**（`newline="\n"`）。声明进版本库，平台默认的 CRLF 会让一次编辑变成整份 diff。
- **原子替换**：同目录的 `.tmp`，写完 `os.replace`。进程在中间死掉也不会留下半个
  文件——半个文件对「唯一事实」是永久损失。失败时临时文件删掉（扫描扫到它，读到的
  就是它）。

← 来自 extensions/writer.py
"""
from __future__ import annotations

import io
import os
import shutil
from pathlib import Path
from typing import Any, Callable, Mapping

from ruamel.yaml import YAML, YAMLError

#: `set_field` 唯一允许**凭空写进去**的那一栏。理由见上面「只改已存在的字段」。
ENABLED = "enabled"

#: 三个容器各自住在哪。**路径怎么拼只有这一处**——多一处就会漂。
#: 包是一个目录（清单在它里面），另外两个各自一个文件。
TARGETS: dict[str, str] = {
    "package": "{name}/manifest.yaml",
    "schedule": "_schedules/{name}.yaml",
    "provider": "_providers/{name}.yaml",
}


def _yaml() -> YAML:
    """往返模式（RoundTrip），并配上**本仓库手写声明的缩进风格**。

    缩进设置不是可选项，也**不许改**：它是声明正文的一部分。ruamel 默认把序列写成
    `tools:\\n- name:`（不缩进），而本仓库的手写清单是 `tools:\\n  - name:`——不配的话，
    一次编辑就会重排整份文件的缩进，而"只改被编辑的那一行"正是这个模块存在的理由。

    实测（旧实现那边有一条测试钉住它）：`weather` / `workspace-file-info` /
    `workspace-processing` / `langchain-agent` 四份手写 manifest 往返**字节一致**。
    """
    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.width = 4096      # 不要替我折行：折行会让 diff 变成一整段
    yaml.indent(mapping=2, sequence=4, offset=2)
    return yaml


def read_document(path: Path) -> Any:
    """把一份声明读成可往返的对象（ruamel RoundTrip）。

    返回的是 ruamel 的文档对象，不是普通 dict：注释、缩进、引号风格、键序都挂在它上面，
    原样 dump 回去就是原样的文件。**只读，不碰盘上的东西。**
    """
    if not path.is_file():
        raise ValueError(f"找不到这份声明: {path}")
    try:
        with path.open("r", encoding="utf-8") as handle:
            return _yaml().load(handle)
    except YAMLError as exc:
        # ruamel 自己的消息是英文的，而读它的人（也可能是界面上的用户）要能看懂
        raise ValueError(f"这份声明读不出来（YAML 有问题）: {path}: {exc}") from exc


def set_field(path: Path, field: str, value: Any, *,
              validate: Callable[[str], None] | None = None,
              allow_new: tuple[str, ...] = (ENABLED,)) -> None:
    """改**顶层**的一个字段：读 → 改 → 校验 → 原子替换。

    **只支持已经存在的字段**，例外写在 `allow_new` 里（缺省只有 `enabled`，
    理由见上面那一节）。不合法就抛 `ValueError`，消息是给人看的中文——调用方
    可以直接显示出去。
    """
    document = read_document(path)
    if not isinstance(document, dict):
        raise ValueError(f"这份声明的顶层必须是一个对象，改不了字段: {path}")

    if field not in document and field not in allow_new:
        # 只改已存在的字段：凭空添一栏等于**改声明**（一条原本继承 `defaults` 的条目，
        # 加上一栏就从"继承"变成了"显式覆盖"），那是另一件事，该走 create_document。
        #
        # `enabled` 例外，因为它两边都不算：它不回答"这个东西长什么样"，只回答
        # "这台机器上要不要用它"——而"关掉一个东西"**恰恰就是写这一行**，一份干净的
        # 清单里本来就没有它。没有这个例外，配置舱那个开关按钮会被这条规则自己拒掉。
        #
        # 包层的 `name` / `description` 同理（`Declarations.set_field` 把它们加进
        # `allow_new`）：它们没有继承语义，而"给这个包起个名字"本来就该是一次编辑
        # 做得到的事。**条目那一层的字段不在此列**——那里加一格真的是改声明。
        raise ValueError(
            f"这份声明里没有 {field}，不能凭空加上去——只有 {' / '.join(allow_new)} 可以"
            f"（它们回答的是「这台机器上要不要用它」和「它叫什么」，"
            f"不是「这个东西长什么样」）。要加别的栏就编辑文件")

    document[field] = value

    # 校验与落盘用的是**同一段文本**：先把候选 dump 出来，校验它，再原样写它。
    # 分两次 dump 也能到同一个结果，但那要靠"dump 是纯函数"这个假设，不如只 dump 一次。
    text = _dump(document)
    if validate is not None:
        # 校验的东西不碰真实文件：文件是唯一事实，写坏了没有第二份可以退回去。
        # 这里**不接它的异常**——校验失败的原因该原样传给调用方，包一层只会把话说糊。
        validate(text)

    _write_atomically(path, text)


def create_document(path: Path, data: dict, *,
                    validate: Callable[[str], None] | None = None) -> None:
    """新建一份声明（建包 / 建日程 / 建供应商）。父目录自动创建。

    `data` 是普通的 dict/list，键序就是写进文件里的顺序。
    """
    if not isinstance(data, dict):
        raise ValueError(f"一份声明必须是一个对象，给的是 {type(data).__name__}: {path}")
    if path.exists():
        # 不覆盖：覆盖一份手写声明会把它的注释和排布一起抹掉，那是这个模块存在的理由
        # 的反面。已经存在的东西要改，走 set_field。
        raise ValueError(
            f"{path} 已经存在了——建一份新声明不会盖掉已有的那份"
            f"（盖掉会把它的注释和排布一起抹掉）。要改它走 set_field")

    # 新建的东西没有注释可保，普通的 dict / list 直接交给往返模式的 representer
    # 就够了——它会按同一套缩进写出去，和 `set_field` 出来的文件是同一种形状。
    text = _dump(data)
    if validate is not None:
        validate(text)

    path.parent.mkdir(parents=True, exist_ok=True)
    _write_atomically(path, text)


def delete_document(path: Path, *, package_dir: bool = False) -> None:
    """删掉一份声明。**不可撤销**（ADR-033），所以调用方要先自己检查引用。

    包是一整个目录（清单和它的代码在一起），另外两个是一个文件。
    不存在就当删过了——**删除是幂等的**，重复一次不该变成一条错误。
    """
    if package_dir:
        shutil.rmtree(path.parent, ignore_errors=True)
    else:
        path.unlink(missing_ok=True)


class Declarations:
    """三个容器 × 四个动作。**路径怎么拼只有这一处。**

    上面那三个函数管"怎么把一段文本安全地落盘"，这里管"落在哪、写成什么形状"。
    校验依旧是**注入**的（`manifest.py` 的校验函数，装配期接上）——本文件仍然不 import 它。
    """

    def __init__(self, root: Path,
                 validators: Mapping[str, Callable[[str, str], None]] | None = None) -> None:
        self.root = Path(root)
        self.validators = dict(validators or {})

    def path_of(self, target: str, name: str) -> Path:
        """这个名字的那份声明在哪。

        **文件名和声明里的名字可以不同**：`_schedules/weather-daily.yaml` 里写的
        是 `name: weather.daily`（日程的示例就是这么写的）。所以先按文件名找，
        找不到再按**声明里的 `name:`** 找一遍——用户嘴里的"那条日程"是它的名字，
        不是文件叫什么。
        """
        direct = self._direct_path(target, name)
        if target == "package" or direct.is_file():
            return direct
        return self._by_declared_name(target, name) or direct

    def _direct_path(self, target: str, name: str) -> Path:
        template = TARGETS.get(target)
        if template is None:
            raise ValueError(f"不认识这类声明: {target}（只能是 {' / '.join(TARGETS)}）")
        if not name or "/" in name or "\\" in name or name.startswith("."):
            raise ValueError(f"名字不合法: {name!r}")
        return self.root / template.format(name=name)

    def _by_declared_name(self, target: str, name: str) -> Path | None:
        directory = (self.root / TARGETS[target].format(name="x")).parent
        if not directory.is_dir():
            return None
        for path in sorted(directory.glob("*.yaml")):
            try:
                declared = read_document(path)
            except ValueError:
                continue
            if isinstance(declared, dict) and str(declared.get("name") or "") == name:
                return path
        return None

    def set_enabled(self, target: str, name: str, enabled: bool) -> None:
        self.set_field(target, name, ENABLED, bool(enabled))

    #: 包层允许**凭空写进去**的另外两栏（`enabled` 那一栏是通用的，见 `set_field`）。
    #: 它们是这个包的**名字和说明**——没有继承语义，而智能体就是一个包，
    #: "给它改个名字"必须是一次编辑做得到的事。
    PACKAGE_NEW_FIELDS = ("name", "description")

    def set_field(self, target: str, name: str, field: str, value: Any) -> None:
        allow_new = (ENABLED, *self.PACKAGE_NEW_FIELDS) if target == "package" else (ENABLED,)
        set_field(self.path_of(target, name), field, value,
                  validate=self._validate(target, name), allow_new=allow_new)

    def create(self, target: str, name: str, data: dict) -> None:
        create_document(self.path_of(target, name), data,
                        validate=self._validate(target, name))

    def delete(self, target: str, name: str) -> None:
        delete_document(self.path_of(target, name), package_dir=target == "package")

    def _validate(self, target: str, name: str) -> Callable[[str], None] | None:
        validator = self.validators.get(target)
        if validator is None:
            return None
        return lambda text: validator(text, name)


def _dump(document: Any) -> str:
    """把文档 dump 成**将要落盘的那段文本**。"""
    buffer = io.StringIO()
    _yaml().dump(document, buffer)
    return buffer.getvalue()


def _write_atomically(path: Path, text: str) -> None:
    """先写临时文件，再 `os.replace`——不留半个文件。

    临时文件与目标**同目录**：`os.replace` 只有在同一个文件系统上才是原子的，跨盘会
    退化成"复制 + 删"，那就等于没有原子性。失败时把临时文件删掉——下次扫描若读到它，
    读到的就是那份半成品。
    """
    target = path.with_name(path.name + ".tmp")
    try:
        # newline="\n"：写出去的必须是 LF。声明进版本库，平台默认的 CRLF 会让一次
        # 编辑变成整份 diff。
        with target.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(target, path)
    except Exception:
        target.unlink(missing_ok=True)
        raise
