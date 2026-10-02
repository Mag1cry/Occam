/**
 * FloatingHud
 *
 * World 上方的屏幕 Overlay：顶部中央的水平“灵动岛式”胶囊。
 *
 * - 横向、紧凑、低高度，文字清晰可读；
 * - 默认显示时间、连接状态、待拍板数量、亮灯数量和当前焦点；
 * - 不滚动完整事件、不承载所有导航；
 * - 不随 World 缩放或平移（fixed 屏幕坐标）；
 * - 可拖动、折叠、顶部安全区吸附；
 * - Pad 上不遮挡命令甲板和确认按钮（安全区内收）。
 *
 * HUD 只接受统一的注意力投影，不直接读取某一种业务对象。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, ChevronDown, ChevronUp, Clock, Crosshair, TriangleAlert } from 'lucide-react';
import { useSceneStore } from '../../store/sceneStore';
import { projectWorldScene } from '../../core/projection/WorldProjection';
import { useGatewayStore, isSnapshotLive } from '../../store/gatewayStore';

/**
 * 连接状态：HUD 上唯一一处显示「现在数据可不可信」的地方
 *
 * 「实时」必须**两个条件同时成立**：最近一次读快照成功 **且** 事件流还开着。
 * 只看前者的话，后端挂掉之后数据已经冻住了，HUD 还会绿灯脉冲说实时——
 * 那是这一屏最容易说假话的地方。
 *
 * `pulse` 动画本身就是一句「还在跳动」的断言，所以只在真的活着时给。
 */
const LIVE = { label: '实时', className: 'text-occ-accent', dot: 'bg-occ-accent pulse' };
const OFFLINE = { label: '已断开', className: 'text-occ-crit', dot: 'bg-occ-crit' };
const CONNECTING = { label: '连接中', className: 'text-slate-400', dot: 'bg-slate-400' };

/** 断开时把「数据截至几点」说清楚：只说断开、不说多旧，等于没说 */
function offlineLabel(lastReadyAt: string | null): string {
  if (!lastReadyAt) return OFFLINE.label;
  const at = new Date(lastReadyAt);
  if (Number.isNaN(at.getTime())) return OFFLINE.label;
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${OFFLINE.label} · 数据截至 ${hh}:${mm}`;
}

/** 顶部安全区 */
const SAFE_TOP = 20;
const DEFAULT_TOP = 20;
const COLLAPSED_HEIGHT = 38;

const SCENE_LABEL: Record<string, string> = {
  world: '全局',
  task: '任务',
  schedule: '编排台',
  archive: '档案馆',
  configuration: '配置舱',
};

export function FloatingHud() {
  const { currentScene, stack } = useSceneStore();
  const snapshot = useGatewayStore((state) => state.snapshot);
  const status = useGatewayStore((state) => state.status);
  const stream = useGatewayStore((state) => state.stream);
  const lastReadyAt = useGatewayStore((state) => state.lastReadyAt);
  const live = isSnapshotLive(status, stream);
  const connection = live
    ? LIVE
    : status === 'unauthorized'
      // 后端是好的，它在等你证明自己有权访问——这叫「需要认证」，不叫「已断开」
      ? { label: '需要认证', className: 'text-occ-warn', dot: 'bg-occ-warn' }
      : status === 'loading' || (stream === 'connecting' && !snapshot)
        ? CONNECTING
        : { ...OFFLINE, label: offlineLabel(lastReadyAt) };

  const [collapsed, setCollapsed] = useState(false);
  const [top, setTop] = useState(DEFAULT_TOP);
  const [now, setNow] = useState(() => new Date());

  const dragRef = useRef<{ startY: number; startTop: number } | null>(null);

  // 时间：HUD 的第一层信息
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 注意力汇总：来自统一投影，不直接读某一种业务对象。
  // 没有快照时不给数字——0 和一个真实的 0 长得一样，会让人以为后端是空的。
  const summary = useMemo(() => {
    if (!snapshot) return null;
    return projectWorldScene({
      tasks: snapshot.tasks,
      schedules: snapshot.schedules ?? [],
      dispatches: snapshot.dispatches ?? [],
    }).attentionSummary ?? null;
  }, [snapshot]);

  const frame = stack[stack.length - 1];
  const sceneLabel = SCENE_LABEL[currentScene] ?? currentScene;
  const objectLabel = frame?.focusLabel ?? frame?.focusId ?? '';
  // 入口节点常常和场景同名（档案馆入口就叫「档案馆」），不重复显示两遍
  const focusLabel =
    currentScene === 'world'
      ? null
      : objectLabel && objectLabel !== sceneLabel
        ? `${sceneLabel} · ${objectLabel}`
        : sceneLabel;

  // 拖动：只允许垂直移动并吸附顶部安全区
  const onPointerDown = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest('button')) return;
    dragRef.current = { startY: event.clientY, startTop: top };

    const handleMove = (moveEvent: PointerEvent) => {
      if (!dragRef.current) return;
      const delta = moveEvent.clientY - dragRef.current.startY;
      const next = Math.max(SAFE_TOP, dragRef.current.startTop + delta);
      setTop(Math.min(next, window.innerHeight * 0.4));
    };

    const handleUp = () => {
      dragRef.current = null;
      // 安全区吸附
      setTop((current) => (current < SAFE_TOP + 24 ? SAFE_TOP : current));
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-50"
      style={{ top }}
      onPointerDown={onPointerDown}
    >
      <div
        className="topline flex items-center gap-3 pl-3 pr-2 rounded-xl border border-white/10 bg-black/45 backdrop-blur-xl cursor-grab active:cursor-grabbing"
        style={{ height: collapsed ? COLLAPSED_HEIGHT : 42 }}
      >
        {/* 身份印记：occ-web 顶栏同一读法 */}
        <span className="w-6 h-6 rounded-lg bg-occ-accent/[0.12] border border-occ-accent/30 flex items-center justify-center shrink-0">
          <Crosshair size={12} className="text-occ-accent" />
        </span>

        {/* 时间与连接状态 */}
        <span className="num text-[11px] text-slate-400 flex items-center gap-1.5">
          <Clock className="w-3 h-3 text-slate-500" />
          {now.toLocaleTimeString()}
        </span>

        {/* 连接状态：读真实快照状态，不写死「在线」 */}
        <span className={`flex items-center gap-1.5 text-[11px] ${connection.className}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${connection.dot}`} />
          {connection.label}
        </span>

        {!collapsed && (
          /*
            断开时把计数压暗：它们来自冻结的快照，一个冻住的「3 件等你拍板」
            和冻住的「实时」是同一种假话——数字看着是新的，其实停在断开那一刻。
          */
          <div className={`contents ${live ? '' : 'opacity-40'}`}>
            <div className="w-px h-4 bg-white/10" />

            {/* 待拍板：需要你响应 → 琥珀色胶囊 */}
            <span
              className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg border ${
                (summary?.needsDecisionCount ?? 0) > 0
                  ? 'border-occ-warn/40 bg-occ-warn/10 text-occ-warn'
                  : 'border-white/10 bg-white/[0.03] text-slate-400'
              }`}
            >
              <Bell size={11} />
              待拍板
              <span
                className={`num min-w-[16px] h-4 px-1 rounded-full text-[10px] flex items-center justify-center ${
                  (summary?.needsDecisionCount ?? 0) > 0
                    ? 'bg-occ-warn text-black font-bold'
                    : 'bg-white/[0.06] text-slate-500'
                }`}
              >
                {summary?.needsDecisionCount ?? 0}
              </span>
            </span>

            {/* 亮灯：需要你注意 → 品红胶囊 */}
            <span
              className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg border ${
                (summary?.attentionCount ?? 0) > 0
                  ? 'border-occ-crit/40 bg-occ-crit/10 text-occ-crit'
                  : 'border-white/10 bg-white/[0.03] text-slate-400'
              }`}
            >
              <TriangleAlert size={11} />
              亮灯
              <span
                className={`num min-w-[16px] h-4 px-1 rounded-full text-[10px] flex items-center justify-center ${
                  (summary?.attentionCount ?? 0) > 0
                    ? 'bg-occ-crit text-black font-bold'
                    : 'bg-white/[0.06] text-slate-500'
                }`}
              >
                {summary?.attentionCount ?? 0}
              </span>
            </span>
          </div>
        )}

        {!collapsed && (
          <>
            {/* 当前焦点：来自场景栈，是本地 UI 事实不是快照，所以不跟着压暗 */}
            {focusLabel && (
              <>
                <div className="w-px h-4 bg-white/10" />
                <span className="text-[11px] text-slate-300 max-w-[220px] truncate">
                  {focusLabel}
                </span>
              </>
            )}
          </>
        )}

        {/* 折叠 */}
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          className="text-slate-400 hover:text-white transition-smooth shrink-0"
          aria-label={collapsed ? '展开 HUD' : '折叠 HUD'}
        >
          {collapsed ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronUp className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
