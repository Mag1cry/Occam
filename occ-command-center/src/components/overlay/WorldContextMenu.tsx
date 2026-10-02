/**
 * WorldContextMenu
 *
 * 空白处长按（Pad）或右键（桌面）打开。
 * 菜单里有哪几格由调用方给（世界场景是"新建任务/新建日程"，配置舱是
 * "新建智能体配置"）——**它只是一张画在空白处的菜单**，不认识任何一个命令。
 * 只有真实命令提交之后，节点才会由重读的快照产生。
 *
 * 菜单位置可以作为新 Task 的初始 World 坐标，
 * 但不写入 Task 领域字段。
 */

import { useEffect, useRef } from 'react';
import { GlassPanel } from '../ui/GlassPanel';
import { Bot, CalendarClock, Plus, Crosshair, Layers } from 'lucide-react';

export interface WorldContextMenuProps {
  position: { x: number; y: number };
  onClose: () => void;
  onNewTask?: () => void;
  onNewSchedule?: () => void;
  /** 配置舱里那一格：**新建智能体 = 建一个新包** */
  onNewAgent?: () => void;
  onFitView?: () => void;
  onResetLayout?: () => void;
}

export function WorldContextMenu({
  position,
  onClose,
  onNewTask,
  onNewSchedule,
  onNewAgent,
  onFitView,
  onResetLayout,
}: WorldContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // 点击外部或 Esc 关闭
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as globalThis.Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const items = [
    ...(onNewTask ? [{ icon: Plus, label: '新建任务', onClick: onNewTask }] : []),
    ...(onNewSchedule ? [{ icon: CalendarClock, label: '新建日程', onClick: onNewSchedule }] : []),
    ...(onNewAgent ? [{ icon: Bot, label: '新建智能体配置', onClick: onNewAgent }] : []),
    ...(onFitView ? [{ icon: Crosshair, label: '适配视图', onClick: onFitView }] : []),
    ...(onResetLayout
      ? [{ icon: Layers, label: '重置布局', onClick: onResetLayout }]
      : []),
  ];

  return (
    <div
      className="fixed inset-0 z-[65]"
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        ref={ref}
        className="absolute"
        style={{ left: position.x, top: position.y }}
      >
        <GlassPanel variant="strong" className="py-1.5 min-w-[160px]">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                item.onClick();
                onClose();
              }}
              className="w-full px-3 py-2 flex items-center gap-2 text-sm text-gray-200 hover:bg-white/10 transition-smooth text-left"
            >
              <item.icon className="w-3.5 h-3.5 text-gray-400" />
              {item.label}
            </button>
          ))}
        </GlassPanel>
      </div>
    </div>
  );
}
