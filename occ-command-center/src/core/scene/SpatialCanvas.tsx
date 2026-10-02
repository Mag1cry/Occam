/**
 * SpatialCanvas
 *
 * 全屏空间画布容器。WorldScene 与所有 ChildScene 共用同一套容器机制，
 * 共享 pan / zoom / node drag / selection / 真实关系边 / 空白菜单 / 手势意图，
 * 但不共享业务状态模型、事件来源和命令集合。
 *
 * 画布独占全屏：本组件不渲染任何与画布并列的面板，
 * HUD 和操作界面一律以 Overlay 形式悬浮在画布之上。
 *
 * 布局（sceneId + objectId → x/y）由本组件统一读写，场景只提供投影结果。
 *
 * 选中态由外部 store 单向驱动（selectedNodeId），画布不持有第二份选中事实。
 * 原因：每次重算节点数组都会整体替换 React Flow 的节点对象，如果选中态挂在
 * 那些对象上，平移、缩放或布局变化会把它一起冲掉。
 *
 * 轻点手势自己实现，不依赖 React Flow 的 click：后者的位移阈值是 1px，
 * 触控的指尖抖动会被判成拖拽，导致「长按能选中、轻点选不中」。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ComponentType } from 'react';
import ReactFlow, {
  ConnectionMode,
  useNodesState,
  useEdgesState,
  type NodeMouseHandler,
  type OnMove,
  type Node as FlowNode,
  type Edge,
} from 'reactflow';
import 'reactflow/dist/style.css';

import type { Node as DomainNode, Relation } from '../types/node';
import type { SceneId } from '../types/scene';
import { calculateLOD } from '../../lib/lod';
import { relationEdgeStyle, relationLabelStyle } from '../../lib/relationVisual';
import { useLayoutStore } from '../../store/layoutStore';

/** 长按判定时长（触控）：滑动永远只承担导航，长按打开操作牌/菜单 */
const LONG_PRESS_MS = 480;

/**
 * 轻点允许的最大位移
 *
 * 比 React Flow 的 1px 阈值宽松得多：触控轻点必然带几像素抖动，
 * 太严会把轻点误判成拖拽。超过这个距离视为导航/移动手势，不再选中。
 */
const TAP_MAX_MOVE = 10;

/**
 * 双击窗口
 *
 * 同一次双击的两次轻点落在这个时间内，第二次就不再当作独立轻点，
 * 而是「回到双击前的选中」＋「进入局部场景」。
 *
 * 进入场景**由这里判定**，不等浏览器原生的 dblclick：
 * 后者的阈值来自操作系统设置（Windows 默认 500ms），而且要求两次点击
 * 落在同一个元素上——第一次点击会选中节点，节点随即从 mid 密度变成 near
 * 密度（内容变多、DOM 变化），第二次点击命中的元素常常已经不是同一个，
 * 浏览器于是根本不派发 dblclick。点得越快越容易撞上这个。
 *
 * 原生 dblclick 仍然保留，作为慢速双击（超过这个窗口但在系统阈值内）的兜底，
 * 重复触发由 lastEnterRef 抑制。
 */
const DOUBLE_TAP_MS = 300;

/** 抑制原生 dblclick 重复进入的窗口：略大于双击窗口 */
const ENTER_DEDUPE_MS = 600;

export interface SpatialCanvasProps {
  /** 当前场景：用于布局键和视口记忆 */
  sceneId: SceneId;
  /** 领域节点 */
  nodes: DomainNode[];
  /** 真实关系（只有真实关系才画线） */
  relations: Relation[];
  /** 画布节点类型名 → 组件 */
  nodeTypes: Record<string, ComponentType<any>>;
  /** 当前选中的节点；选中态的唯一事实来源 */
  selectedNodeId?: string | null;
  /** 是否接收输入；转场期间必须为 false，外层不能平移、缩放或拖动 */
  interactive?: boolean;
  fitView?: boolean;
  /** 轻点节点（开关选中）。拖动、双击、长按都不会触发它 */
  onNodeClick?: (nodeId: string) => void;
  /**
   * 双击的第二次轻点：把选中恢复到双击之前
   *
   * 双击由两次轻点组成，但两次开关并不抵消——被点的节点原本没选中时，
   * 第一次抢走选中、第二次把它清空，结果是「双击一下，原来的选中没了」。
   * 双击进入场景属于导航，不该改变选中态，所以这里显式恢复。
   */
  onSelectionRestore?: (nodeId: string | null) => void;
  onNodeDoubleClick?: (nodeId: string) => void;
  /** 轻点空白（取消选中） */
  onPaneClick?: () => void;
  /** 空白处右键（桌面）或长按（Pad） */
  onPaneContextMenu?: (screenPosition: { x: number; y: number }) => void;
  /** 节点长按（Pad）：打开操作牌。缺省时退化为选中 */
  onNodeLongPress?: (nodeId: string) => void;
  /**
   * 这个场景里**存在**哪些对象（画着的 + 收起来的）
   *
   * 布局表只留这些：不在里面的，说明对象真的没了，那一格该跟着走。
   * 缺省就按"画出来的那些"算——**会收东西的场景必须自己给全**，否则收起来
   * 再展开时那个位置已经被清掉了，节点会跳回投影算出来的地方。
   */
  known?: ReadonlySet<string>;
  className?: string;
}

export function SpatialCanvas({
  sceneId,
  nodes,
  relations,
  nodeTypes,
  selectedNodeId = null,
  interactive = true,
  fitView = true,
  onNodeClick,
  onSelectionRestore,
  onNodeDoubleClick,
  onPaneClick,
  onPaneContextMenu,
  onNodeLongPress,
  known,
  className = '',
}: SpatialCanvasProps) {
  const entries = useLayoutStore((state) => state.entries);
  const setPosition = useLayoutStore((state) => state.setPosition);
  const forget = useLayoutStore((state) => state.forget);
  const setViewport = useLayoutStore((state) => state.setViewport);
  const storedViewport = useLayoutStore((state) => state.viewports[sceneId]);

  /**
   * LOD 的输入就是视口本身，不另存一份
   *
   * 这里只取缩放值（原始值比较，平移时不会重渲染）。早先画布自己
   * `useState(1)` 存一份 zoom、只靠 onMove 更新：而返回场景时视口是通过
   * `defaultViewport` 直接套用记忆值，不会再触发一次 onMove——
   * 于是密度按初始值 1 算，整层节点全被撑开（near），看起来像「全部展开了」。
   *
   * 与选中态同样的道理：画布不持有第二份事实（见文件头）。
   */
  const zoom = useLayoutStore((state) => state.viewports[sceneId]?.zoom) ?? 1;
  const lod = calculateLOD(zoom);

  const flowNodes: FlowNode[] = useMemo(
    () =>
      nodes.map((node) => {
        // 布局覆盖投影坐标；增量刷新不覆盖用户布局
        const saved = entries[`${sceneId}:${node.id}`];
        return {
          id: node.id,
          type: node.type,
          position: saved ? { x: saved.x, y: saved.y } : { x: node.x, y: node.y },
          data: { ...node, zoom, lod },
          // 选中态跟着 store 走，不留在被整体替换的节点对象里
          selected: node.id === selectedNodeId,
          draggable: interactive,
          selectable: interactive,
        };
      }),
    [nodes, entries, sceneId, zoom, lod, interactive, selectedNodeId]
  );

  /**
   * 布局表的两件事：**新来的记下位置，走了的把位置清掉**
   *
   * **记下**：投影给的那个坐标是"摆哪儿合适"，而它是**按下标算的**——下标会因为
   * 别处发生变化（归档一条、删掉一条），于是用户没动过的东西也整块往前挪。
   * 所以一见到就固定下来：从此它的位置只归这张表管。撞位就往下找一个空格——
   * 那正是原来那套网格在做的事，只是现在做一次就记住。
   *
   * **清掉**：对象没了，它那一格就该跟着走。不清的话这张表只增不减（还写进
   * localStorage），而那个 id 永远不会再出现。
   *
   * 判据是 `known` 而不是"这一屏画了什么"：**收起来的东西还活着**，它们的格子
   * 得留着（配置舱收起一个包、编排台折叠历史、档案馆切筛选——都不是"没了"）。
   * 默认就按画出来的算，会收东西的场景自己把"存在哪些"给全。
   */
  useLayoutEffect(() => {
    const mine = Object.keys(entries)
      .filter((key) => key.startsWith(`${sceneId}:`))
      .map((key) => key.slice(sceneId.length + 1));
    const living = known ?? new Set(nodes.map((node) => node.id));

    const gone = mine.filter((id) => !living.has(id));
    if (gone.length > 0) forget(sceneId, gone);

    const taken = new Set(
      Object.entries(entries)
        .filter(([key]) => key.startsWith(`${sceneId}:`))
        .map(([, spot]) => `${spot.x},${spot.y}`),
    );
    for (const node of nodes) {
      // 已经有位置的**一个字都不动**——那正是这条效果存在的理由
      if (entries[`${sceneId}:${node.id}`]) continue;
      let spot = { x: node.x, y: node.y };
      while (taken.has(`${spot.x},${spot.y}`)) spot = { x: spot.x, y: spot.y + 200 };
      taken.add(`${spot.x},${spot.y}`);
      setPosition(sceneId, node.id, spot);
    }
  }, [nodes, entries, known, sceneId, setPosition, forget]);

  const flowEdges: Edge[] = useMemo(
    () =>
      relations.map((rel) => ({
        id: rel.id,
        source: rel.source,
        target: rel.target,
        type: 'default',
        // 连线动画只表示已确认的事件反馈，不表示猜测中的执行进度
        animated: false,
        label: rel.label,
        style: relationEdgeStyle(rel, selectedNodeId),
        labelStyle: relationLabelStyle(rel, selectedNodeId),
      })),
    [relations, selectedNodeId]
  );

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(flowNodes);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(flowEdges);

  useEffect(() => {
    setRfNodes(flowNodes);
  }, [flowNodes, setRfNodes]);

  useEffect(() => {
    setRfEdges(flowEdges);
  }, [flowEdges, setRfEdges]);

  const handleNodeDragStop: NodeMouseHandler = useCallback(
    (_event, node) => {
      // 拖动只改变布局元数据，不改业务对象；也不改变选中态
      setPosition(sceneId, node.id, { x: node.position.x, y: node.position.y });
    },
    [sceneId, setPosition]
  );

  /** 最近一次由手势判定触发的进入，用于抑制原生 dblclick 的重复触发 */
  const lastEnterRef = useRef<{ nodeId: string; at: number } | null>(null);

  const handleNodeDoubleClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const recent = lastEnterRef.current;
      if (recent && recent.nodeId === node.id && Date.now() - recent.at <= ENTER_DEDUPE_MS) {
        return;
      }
      lastEnterRef.current = { nodeId: node.id, at: Date.now() };
      onNodeDoubleClick?.(node.id);
    },
    [onNodeDoubleClick]
  );

  const handleMove: OnMove = useCallback(
    (_event, viewport) => {
      // 视口只属于 UI Scene State；LOD 直接跟着它走，不再另存一份缩放值
      setViewport(sceneId, {
        zoom: viewport.zoom,
        pan: { x: viewport.x, y: viewport.y },
      });
    },
    [sceneId, setViewport]
  );

  /**
   * 手势跟踪
   *
   * 一次指针按下到抬起之间只判定一件事：轻点、拖动，还是长按。
   * - 轻点（位移 ≤ TAP_MAX_MOVE）：节点 → 选中；空白 → 取消选中
   * - 拖动（位移 > TAP_MAX_MOVE）：交给画布移动节点或平移，不改变选中态
   * - 长按（触控，480ms 未移动）：节点 → 操作牌；空白 → 菜单
   */
  const gestureRef = useRef<{
    x: number;
    y: number;
    nodeId: string | null;
    pointerType: string;
    moved: boolean;
    longPressTimer: number | null;
  } | null>(null);

  /** 上一次节点轻点，用于识别同一次双击的第二次轻点 */
  const lastTapRef = useRef<{
    nodeId: string;
    at: number;
    selectionBefore: string | null;
  } | null>(null);

  const endGesture = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;

    gestureRef.current = null;
    if (gesture.longPressTimer !== null) {
      window.clearTimeout(gesture.longPressTimer);
    }

    // 移动过就不是轻点；长按已在定时器里处理过
    if (gesture.moved) return;

    if (!gesture.nodeId) {
      lastTapRef.current = null;
      onPaneClick?.();
      return;
    }

    const now = Date.now();
    const last = lastTapRef.current;

    if (last && last.nodeId === gesture.nodeId && now - last.at <= DOUBLE_TAP_MS) {
      // 同一次双击：撤销第一次轻点的开关，选中回到双击之前
      lastTapRef.current = null;
      onSelectionRestore?.(last.selectionBefore);

      // 进入局部场景也在这里判定：双击是导航手势，不能交给浏览器
      // 原生的 dblclick（见 DOUBLE_TAP_MS 的说明）
      lastEnterRef.current = { nodeId: gesture.nodeId, at: now };
      onNodeDoubleClick?.(gesture.nodeId);
      return;
    }

    lastTapRef.current = {
      nodeId: gesture.nodeId,
      at: now,
      selectionBefore: selectedNodeId,
    };
    onNodeClick?.(gesture.nodeId);
  }, [onNodeClick, onNodeDoubleClick, onSelectionRestore, onPaneClick, selectedNodeId]);

  const handlePointerDownCapture = useCallback(
    (event: React.PointerEvent) => {
      if (!interactive) return;

      // 右键留给上下文菜单
      if (event.button !== 0 && event.pointerType === 'mouse') return;

      const target = event.target as HTMLElement;
      const nodeId =
        target.closest<HTMLElement>('.react-flow__node')?.getAttribute('data-id') ?? null;

      const x = event.clientX;
      const y = event.clientY;

      const previous = gestureRef.current;
      if (previous?.longPressTimer != null) {
        window.clearTimeout(previous.longPressTimer);
      }

      const gesture = {
        x,
        y,
        nodeId,
        pointerType: event.pointerType,
        moved: false,
        longPressTimer: null as number | null,
      };

      // 长按只对触控生效：鼠标按住不动仍然是普通点击
      if (event.pointerType === 'touch') {
        gesture.longPressTimer = window.setTimeout(() => {
          const current = gestureRef.current;
          if (!current || current.moved) return;
          gestureRef.current = null;

          if (current.nodeId) {
            if (onNodeLongPress) onNodeLongPress(current.nodeId);
            else onNodeClick?.(current.nodeId);
          } else {
            onPaneContextMenu?.({ x: current.x, y: current.y });
          }
        }, LONG_PRESS_MS);
      }

      gestureRef.current = gesture;
    },
    [interactive, onNodeClick, onNodeLongPress, onPaneContextMenu]
  );

  // 抬起和移动挂在 window 上：指针移出画布容器时也能正确收尾
  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.moved) return;

      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > TAP_MAX_MOVE) {
        gesture.moved = true;
        if (gesture.longPressTimer !== null) {
          window.clearTimeout(gesture.longPressTimer);
          gesture.longPressTimer = null;
        }
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', endGesture);
    window.addEventListener('pointercancel', endGesture);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', endGesture);
      window.removeEventListener('pointercancel', endGesture);
    };
  }, [endGesture]);

  return (
    <div
      className={`w-full h-full ${className}`}
      onPointerDownCapture={handlePointerDownCapture}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={handleNodeDragStop}
        onNodeDoubleClick={handleNodeDoubleClick}
        onMove={handleMove}
        onPaneContextMenu={(event) => {
          event.preventDefault();
          onPaneContextMenu?.({ x: event.clientX, y: event.clientY });
        }}
        nodeTypes={nodeTypes}
        connectionMode={ConnectionMode.Loose}
        nodesDraggable={interactive}
        nodesConnectable={false}
        elementsSelectable={interactive}
        panOnDrag={interactive}
        zoomOnScroll={interactive}
        zoomOnPinch={interactive}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
        // 有视口记忆时不再 fitView：返回场景要回到离开前的取景，
        // 否则「返回后恢复外层 viewport」只在 store 里成立，屏幕上是重新取景
        fitView={fitView && !storedViewport}
        // minZoom 是「适应全屏」的下限，不是用户的缩放范围（那是下面的 minZoom）。
        // 资料多到一屏塞不下时（配置舱可能有几百个 Executor Configuration），
        // 无下限的 fit 会把整块场景缩成一片点——宁可只装下一部分，
        // 让用户自己平移缩放，也不要给一个「什么都看不见」的初始取景。
        fitViewOptions={{ padding: 0.3, minZoom: 0.5, maxZoom: 1 }}
        minZoom={0.15}
        maxZoom={2}
        defaultViewport={
          storedViewport
            ? {
                zoom: storedViewport.zoom,
                x: storedViewport.pan.x,
                y: storedViewport.pan.y,
              }
            : undefined
        }
      >
      </ReactFlow>
    </div>
  );
}
