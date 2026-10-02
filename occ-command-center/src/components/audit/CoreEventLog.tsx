/**
 * CoreEventLog
 *
 * Core Event Log 是内核控制事实的时间序列，不是空间图节点。
 *
 * 规则：
 * - 按 Core 追加顺序展示 event_type、追加时间、tool_id / external_ref
 *   （字段存在时）和诊断状态；
 * - 事件可以先进入日志形成即时反馈，但不能直接改变 Task 当前状态；
 * - Worker 消息、模型消息和 checkpoint 内容不能混入 Core Event Log。
 *
 * 字段形状以后端 `core.models.ControlEvent` 为准：这里显示的每一条都来自
 * Core 的命令结果，因此不再单挂「Core confirmed」标记——整个日志就是
 * Core 已确认事实，标记反而会让人以为还有别的来源混在里面。
 *
 * 序号显示的是**追加序位**，不是事件链游标：后端还没有公开 `event_seq`
 * （backend-contract.md 第 7 节的待冻结契约），拿数组下标冒充游标等于
 * 伪造一个不存在的事实。
 */

import { AlertTriangle, Database, Clock } from 'lucide-react';
import type { ControlEvent, ControlEventType } from '../../api/gateway';

export interface CoreEventLogProps {
  events: ControlEvent[];
  /** 事件链完整性诊断（字段就绪时传入；没有来源时不显示结论） */
  chainIssue?: string;
}

/** 事件名 → 中文标签。键必须覆盖后端 `EVENT_TYPES` 全集 */
const EVENT_LABEL: Record<ControlEventType, string> = {
  TASK_CREATED: '任务创建',
  FUNCTION_APPROVAL_REQUESTED: '等待能力审批',
  INTERRUPTED: '已中断',
  APPROVED: '已批准',
  DENIED: '已拒绝',
  RESUMED: '已恢复',
  FUNCTION_CALLED: '能力调用',
  COMPLETED: '已完成',
  FAILED: '已失败',
  CANCELLED: '已取消',
  TASK_ARCHIVED: '已归档',
};

/**
 * 追加时间
 *
 * 后端给的是 ISO 8601；解析不出来就显示原文，
 * 不复用当前时间、也不留空让人以为事件没有时间。
 */
function formatOccurredAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value || '时间未知';
  return parsed.toLocaleTimeString();
}

/** payload 里可以直接显示的一行说明（存在时） */
function payloadLine(payload: ControlEvent['payload']): { text: string; tone: 'muted' | 'critical' } | null {
  if (!payload) return null;
  if (typeof payload.error === 'string' && payload.error) {
    return { text: payload.error, tone: 'critical' };
  }
  if (typeof payload.message === 'string' && payload.message) {
    return { text: payload.message, tone: 'muted' };
  }
  return null;
}

export function CoreEventLog({ events, chainIssue }: CoreEventLogProps) {
  if (events.length === 0) {
    return (
      <div className="text-xs text-gray-500 py-4 text-center">
        当前没有可展示的内核控制事实
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
        <span>内核控制事实 · 按追加顺序</span>
        {chainIssue ? (
          <span className="flex items-center gap-1 text-occ-warn-light">
            <AlertTriangle className="w-3 h-3" /> {chainIssue}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-occ-accent">
            <Database className="w-3 h-3" /> 来源：Core
          </span>
        )}
      </div>

      {events.map((event, index) => {
        const line = payloadLine(event.payload);
        return (
          <div
            key={event.event_id}
            className="flex items-start gap-2 px-2 py-1.5 rounded bg-white/[0.03] border border-white/5"
          >
            <span className="num text-xs text-gray-500 shrink-0 w-8">{index + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-200">
                  {EVENT_LABEL[event.event_type] ?? event.event_type}
                </span>
                {event.tool_id && (
                  <span className="text-[10px] px-1 rounded border border-white/15 text-slate-400">
                    {event.tool_id}
                  </span>
                )}
              </div>
              {event.external_ref && (
                <div className="text-[10px] text-gray-500 mt-0.5 truncate">
                  外部引用 {event.external_ref}
                </div>
              )}
              {line && (
                <div
                  className={`text-xs mt-0.5 truncate ${
                    line.tone === 'critical' ? 'text-occ-crit-light' : 'text-gray-400'
                  }`}
                >
                  {line.text}
                </div>
              )}
            </div>
            <span className="num text-[10px] text-gray-500 shrink-0 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatOccurredAt(event.occurred_at)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
