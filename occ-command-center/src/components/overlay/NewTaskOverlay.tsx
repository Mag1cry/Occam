/**
 * NewTaskOverlay
 *
 * World Context Menu → 新建任务。
 *
 * 硬边界（`world-model.md` 第 5 节）：**只有真实 Core 命令提交后才产生 Task 节点**。
 * 提交走网关的 `create_task`，节点由重新读取的快照产生——前端不预置任何 Task，
 * 也不给新任务编一个本地状态。
 *
 * 菜单位置只作为新 Task 的初始 World 坐标写进布局记忆，不写进 Task 领域字段。
 *
 * 三个字段都是 Core 要求的，缺一不可：
 * - 委托摘要：这件事本身是什么（节点的标题就是它）；
 * - 输入引用：工作区内的委托原文，执行者读到的就是它的内容；
 * - 执行者：谁负责把它推到收敛。**模型不在这一层出现**（ADR-026）——它下沉成
 *   智能体的一个属性，所以这里是单级列表、两组：硬编码执行者 ∪ 智能体。
 *   改造前那是一条按供应商分组的模型目录（uniapi 一家就两百多个 profile），
 *   于是「谁来干这件事」的答案是一个模型名——那不是一个有意义的答案。
 *
 * 提交的仍是执行者引用：硬编码执行者用它自己的 `id`，智能体用 `agent:<id>`
 * （`agent.<id>` 是它在配置状态里的键，两种拼法指同一个对象）。
 */

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { GlassPanel } from '../ui/GlassPanel';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { GroupedSelect } from '../ui/GroupedSelect';
import { FilePickerButton } from '../ui/FilePickerButton';
import { createTask, startTask, type GatewaySnapshot } from '../../api/gateway';
import { taskExecutorChoices } from '../../lib/executorGroups';
import { firstOptionValue } from '../../lib/selectGroups';
import { useLayoutStore } from '../../store/layoutStore';
import { useGatewayStore } from '../../store/gatewayStore';

export interface NewTaskOverlayProps {
  /** 菜单位置：作为新 Task 的初始 World 坐标 */
  initialPosition: { x: number; y: number };
  /**
   * 快照：执行者列表从这里取，不在这里另造一份目录。
   *
   * 给整份快照而不是一个 `executors` 数组：任务层的可选执行者现在由**两处**
   * 决定（硬编码执行者与智能体），只传其中一份会静默丢掉另一半。
   */
  snapshot: GatewaySnapshot;
  onClose: () => void;
}

export function NewTaskOverlay({ initialPosition, snapshot, onClose }: NewTaskOverlayProps) {
  // 分组只在快照变了才重算：敲摘要时不该重排几百条配置
  const groups = useMemo(() => taskExecutorChoices(snapshot), [snapshot]);
  const [summary, setSummary] = useState('');
  const [taskRef, setTaskRef] = useState('');
  // 初值仍是快照里的第一条：分组是保序划分，所以这个值与改造前一致
  const [executorRef, setExecutorRef] = useState(() => firstOptionValue(groups));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setPosition = useLayoutStore((state) => state.setPosition);
  const load = useGatewayStore((state) => state.load);

  /*
    **输入引用可以缺省。** 后端本来就是这样——`tasks/inputs.py::read` 的第一行是
    `if not task_ref: return ""`，docstring 写的是"不是每个执行者都要一份正文"。

    界面以前把它做成必填，**比后端更严**：固定代码的执行者（`weather.collect`
    那种，城市来自配置的旋钮、根本不看正文）也被逼着编一个文件名出来——而
    `inputs.read` 在起进程**之前**就读它，读不到会把这次运行当场收成 `failed`。
    也就是说，编一个不存在的文件名比留空更糟。
  */
  const canSubmit = summary.trim().length > 0 && executorRef.length > 0 && !submitting;

  // 「还差什么」：按钮为什么点不动，必须说出来（R-001）
  const missing = [
    summary.trim().length === 0 && '委托摘要',
    executorRef.length === 0 && '执行者',
  ].filter((item): item is string => Boolean(item));

  const handleSubmit = async (alsoStart: boolean) => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const taskId = await createTask({
        summary: summary.trim(),
        taskRef: taskRef.trim(),
        executorConfigRef: executorRef,
      });
      if (alsoStart) await startTask(taskId);

      // 菜单位置只进布局记忆：节点出现在用户点的地方，但 Task 字段不受影响
      setPosition('world', taskId, {
        x: Math.round(initialPosition.x),
        y: Math.round(initialPosition.y),
      });

      // 节点由重新读取的快照产生：提交成功不等于节点已经在那了
      await load();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50">
      <GlassPanel variant="strong" className="w-[440px] p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-base font-medium text-white">新建任务</div>
            <div className="text-xs text-gray-500 mt-1">
              菜单位置将作为新任务的初始坐标，不写入任务字段
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-smooth"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-gray-400">委托摘要</span>
            <input
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              autoFocus
              className="mt-1 w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-occ-accent/50 transition-smooth"
              placeholder="例如：查一下今天的天气"
            />
          </label>

          <label className="block">
            <span className="text-xs text-gray-400">输入引用（可留空）</span>
            {/*
              两种填法都给：**手打**（路径你清楚，或者文件还没放进去）与
              **选择文件**（系统对话框选一份，它进工作区、落点填回这一格）。
              选择那一步是"写"——所以它只在你按的时候发生，不是这个表单的默认行为。
            */}
            <div className="mt-1 flex items-center gap-2">
              <input
                value={taskRef}
                onChange={(event) => setTaskRef(event.target.value)}
                // `flex-1 min-w-0`：让出按钮那一份宽度（`w-full` 会把按钮挤成两行）
                className="flex-1 min-w-0 px-3 py-2 rounded bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-occ-accent/50 transition-smooth"
                placeholder="工作区内的文件，例如 inputs/weather-now.md"
              />
              <FilePickerButton
                onPicked={setTaskRef}
                onError={setError}
                disabled={submitting}
              />
            </div>
            <span className="block text-[11px] text-gray-500 mt-1">
              执行者读到的就是这份文件的正文，不是上面的摘要。留空 = 没有正文：
              固定代码的执行者不看它；要模型的那种会把"没有正文"当成一条空消息交给模型。
              路径必须落在工作区内，越界的那次运行不会被起起来。
              <br />
              按「选择文件」是从你的电脑上挑一份**放进来**（重名会自动加序号），
              不是挑一个工作区里已有的。
            </span>
          </label>

          <div className="block">
            <span className="text-xs text-gray-400">执行者</span>
            <GroupedSelect
              groups={groups}
              value={executorRef}
              onChange={setExecutorRef}
              ariaLabel="执行者"
              emptyLabel="没有可用的执行者"
              className="mt-1"
            />
            <span className="block text-[11px] text-gray-500 mt-1">
              模型是智能体的属性：要用某个模型，就去配置舱建一个用它做模型的智能体
            </span>
          </div>
        </div>

        {error && (
          <div className="mt-3 text-[11px] text-occ-crit-light break-words">提交失败：{error}</div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <Badge variant="info" size="sm">
            真实 Core 命令
          </Badge>
          <div className="flex items-center gap-2">
            {/* 禁用的按钮不会再弹任何东西，所以原因要一直看得见（R-001） */}
            {missing.length > 0 && (
              <span className="text-[11px] text-occ-warn" role="status">
                还差：{missing.join(' · ')}
              </span>
            )}
            <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleSubmit(false)}
              disabled={!canSubmit}
            >
              仅创建
            </Button>
            <Button size="sm" onClick={() => void handleSubmit(true)} disabled={!canSubmit}>
              {submitting ? '提交中…' : '创建并启动'}
            </Button>
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}
