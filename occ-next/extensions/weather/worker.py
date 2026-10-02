"""日程跑的那个入口：**它只说话，不调任何东西**。

要工具就走 `channel.request_tool`——判决在网关、执行在网关，它只负责说清楚
"我是怎么结束的"（三种，见 `src/tasks/channel.py` 的契约二）。

**它不 import 那个包**：worker 在另一个进程里，手里除了这条管道什么都没有。
这也正是"要工具只有一条路"成立的原因——不是纪律，是结构。
"""
from __future__ import annotations

import json

from src.tasks.channel import COMPLETED, FAILED, INTERRUPTED, WorkerChannel

#: 没指定城市时查这个。`weather.current` 的默认值也是它，两处写一样是故意的：
#: 一处是"参数没给"，一处是"配置没给"，都不该猜成别的城市。
DEFAULT_CITY = "杭州"


def collect(connection, task_data, config_data, input_text, database_path,
            resume_value=None):
    """查一次天气，把结果报上去。

    `input_text`（那份委托正文）这一版**不参与取值**——城市来自配置的旋钮。
    读它的事情由日程那条路在起进程**之前**做掉了：读不到正文就不起，
    所以"日程看着像跑过了"这件事不会发生。
    """
    channel = WorkerChannel(connection, str(task_data["task_id"]))
    city = str((config_data.get("parameters") or {}).get("city") or DEFAULT_CITY)

    answer = channel.request_tool("weather.current", {"city": city})

    if answer.decision == "needs_approval":
        # **停下来等人批**，不是失败：`checkpoint_ref` 就是我们下次接着说的地方。
        channel.report(INTERRUPTED, {"checkpoint_ref": f"weather:{task_data['task_id']}:{city}"})
        return
    if not answer.ok:
        # `deny` 和"允许了但工具自己失败了"都落到这里——**执行者不给错误分类**。
        channel.report(FAILED, {"reason": answer.error or "天气查询失败"})
        return

    # **把函数返回的那个值原样回传**——不挑字段、不排版。
    #
    # 这里原来有三行把 dict 压成一句话（`city` + `desc` + `temp°`）。那是**硬编码**：
    # "这个任务的结果长什么样"由每个包各写一遍，而且写在 worker 里——另一个进程，
    # 除了这条管道什么都没有。挑哪几个字段、怎么拼，是包作者的偏好，不是契约。
    #
    # 现在只做一件**搬运**的事：`result_ref` 是一格字符串，把结构转成字符串。
    # **转不是解释**——不看内容、不做决定，返回什么就交出去什么。
    channel.report(COMPLETED, {
        "checkpoint_ref": f"weather:{task_data['task_id']}:{city}",
        "result_ref": json.dumps(answer.result, ensure_ascii=False, default=str),
    })
