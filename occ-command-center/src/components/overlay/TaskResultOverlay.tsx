/**
 * TaskResultOverlay
 *
 * 「查看结果」打开的那份浮窗：**按需**读这个 Task 的执行结果，按 Markdown 画出来。
 *
 * ## 为什么它要收成一处
 *
 * 「查看结果」这条命令**四个场景都有**——世界、任务详情、编排台、档案馆
 * （它们用的是同一个 `buildNodeCommands`，所以一条 Task 节点在哪儿都带这个按钮）。
 * 各写一遍就会各错一次，而它已经错过一次了：`type: 'view'` 的命令**没有后端命令**，
 * 落到 `onExecute` → `resolveTaskCommand` 只会得到 null 然后静默返回——
 * 于是四个场景里的「查看结果」按下去**全都什么都不发生**。
 *
 * ## 每次打开都重新读一次
 *
 * 不做"调用方传进来"那条路：它只在点按的那一刻开，多打一次 `GET /api/tasks/{id}`
 * 是免费的，而换来的是**你点开时看到的是此刻的结果**——传进来那份可能是几分钟前
 * 读的，还得判断它是不是过期了。（常驻那条小条子仍旧由各场景自己读。）
 */

import { useEffect, useState } from 'react';
import { getTaskResult, type TaskResult } from '../../api/gateway';
import { MarkdownOverlay } from './MarkdownOverlay';

export interface TaskResultOverlayProps {
  taskId: string;
  /** 副标题，通常给"这是哪个对象的"——缺省就只有 taskId */
  subtitle?: string;
  onClose: () => void;
}

export function TaskResultOverlay({ taskId, subtitle, onClose }: TaskResultOverlayProps) {
  /*
    读回来的东西连 taskId 一起存：换对象时旧结果自然失效，不必在 effect 里清空
    （`TaskScene` 里那条常驻结果用的是同一条路子）。
  */
  const [loaded, setLoaded] = useState<{ taskId: string; value: TaskResult | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTaskResult(taskId)
      .then((value) => { if (!cancelled) setLoaded({ taskId, value }); })
      .catch(() => { if (!cancelled) setLoaded({ taskId, value: null }); });
    return () => { cancelled = true; };
  }, [taskId]);

  const current = loaded?.taskId === taskId ? loaded.value : undefined;

  return (
    <MarkdownOverlay
      title="执行结果"
      subtitle={subtitle ?? taskId}
      content={current?.text ?? ''}
      /*
        三种"空的"要说成三句话，不能都说"没有读到结果"：
        - 还没读完 → 正在读
        - 读完了但没有 → 后端 `ok:false` 的那些情况（比如"这个执行者不提供结果查询"）
        混成一句，用户会分不清该等一等还是该去找别的地方看。
      */
      emptyLabel={current === undefined
        ? '正在读取结果…'
        : '没有读到结果。可能这个执行者不提供结果查询，或者结果还没落下来。'}
      onClose={onClose}
    />
  );
}
