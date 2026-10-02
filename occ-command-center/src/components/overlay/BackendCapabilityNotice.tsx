/**
 * BackendCapabilityNotice
 *
 * 明确标注目标接口尚未就绪的能力，避免把目标设计显示成当前已有能力。
 *
 * 依据后端网关快照的实际字段：`schedules` / `dispatches` 已经在快照里，
 * 编排台数据不是目标能力；acknowledge 和增量游标（Change Feed）仍缺。
 */

import { useState } from 'react';
import { ChevronDown, ChevronUp, ServerOff } from 'lucide-react';
import { GlassPanel } from '../ui/GlassPanel';
import { BACKEND_CAPABILITIES } from '../../lib/commandMatrix';

const LABELS: Record<keyof typeof BACKEND_CAPABILITIES, string> = {
  acknowledge: 'POST /api/tasks/{id}/acknowledge',
  scheduleControl: '网关 schedule.pause / resume / trigger',
  changeFeed: 'GET /api/changes（增量游标）',
};

export function BackendCapabilityNotice() {
  const [expanded, setExpanded] = useState(false);
  const pending = Object.entries(BACKEND_CAPABILITIES).filter(([, ready]) => !ready);

  if (pending.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-5 z-30">
      <GlassPanel className="px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-200 transition-smooth"
        >
          <ServerOff className="w-3.5 h-3.5" />
          {pending.length} 项目标接口未就绪
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
        </button>

        {expanded && (
          <div className="mt-2 space-y-1">
            {pending.map(([key]) => (
              <div key={key} className="num text-[10px] text-gray-500">
                {LABELS[key as keyof typeof BACKEND_CAPABILITIES]}
              </div>
            ))}
            <div className="text-[10px] text-gray-500 pt-1 border-t border-white/10">
              界面以禁用状态显示这些能力，不用本地状态替代
            </div>
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
