/**
 * ConfigurationScene
 *
 * 配置舱局部世界：配置资料拓扑，而非 Task 行动拓扑。
 *
 * 硬边界：
 * - 不复用 Task 的 Core Event Log 或 Agent Audit 作为主结构；
 * - 不生成 Configuration → Capability 绑定；
 *   合法关系只有 Extension → Capability、Extension/供应商 → Executor Configuration
 *   和 Task → Executor Configuration；
 * - 不把配置节点当作可执行 Task。
 */

import { useMemo, useState } from 'react';
import { SpatialCanvas } from '../../core/scene/SpatialCanvas';
import { useSelectionStore } from '../../store/selectionStore';
import { useTransitionStore } from '../../store/transitionStore';
import { CommandSurface } from '../../components/overlay/CommandSurface';
import { SceneOverlayStack, SceneFacts } from '../../components/overlay/SceneOverview';
import { buildNodeCommands } from '../../lib/commandMatrix';
import { ResourceNode } from '../../components/nodes/ResourceNode';
import { projectLiveConfiguration } from '../../core/projection/LiveConfigurationProjection';
import type { GatewaySnapshot } from '../../api/gateway';
import { executeConfigCommand } from '../../lib/objectCommands';
import { useGatewayStore } from '../../store/gatewayStore';
import { AgentEditorOverlay } from '../../components/overlay/AgentEditorOverlay';
import { WorldContextMenu } from '../../components/overlay/WorldContextMenu';
import { ToolPermissionOverlay } from '../../components/overlay/ToolPermissionOverlay';
import { ProviderCatalogOverlay } from '../../components/overlay/ProviderCatalogOverlay';
import { configColumns, diagnosticColumn } from '../../lib/nodeVisual';
import type { Command } from '../../core/types/projection';
import type { ResourceNode as ResourceNodeModel } from '../../core/types/node';

/** 配置舱内部全部是资料节点：配置不是可执行单位 */
const nodeTypes = { resource: ResourceNode };

/**
 * 编辑中的对象
 *
 * 编辑页是**覆盖层**，不是可进入的 Scene：`SceneId` 里没有 agent 这一档，
 * 配置舱里的一等对象不进入另一个世界。
 */
type PendingEdit =
  | { kind: 'agent'; agentRef: string }
  /** 新建：还没有定义，编辑页自己问标识 */
  | { kind: 'agent'; agentRef: '' }
  | { kind: 'tool'; extensionId: string; toolId: string };

/**
 * 能力所属包的目录名
 *
 * 后端按**目录**定位 manifest（`extensions_dir / <extension_id> / manifest.yaml`），
 * 而快照里的引用是 `extension.<id>`——前缀是命名约定，不是别的事实，所以只在
 * 这里剥一次。
 */
function extensionIdOf(abilityRef: string): string {
  return abilityRef.startsWith('extension.') ? abilityRef.slice('extension.'.length) : abilityRef;
}

export interface ConfigurationSceneProps {
  configurationId: string;
  /** 后端网关快照：由 SceneRenderer 保证存在，场景自己不兜底 */
  snapshot: GatewaySnapshot;
}

export function ConfigurationScene({ configurationId, snapshot }: ConfigurationSceneProps) {
  const { selectedNodeId, setSelected, toggleSelected } = useSelectionStore();
  // 转场期间冻结画布输入；本场景不发起进入，只读飞行标记
  const isFlying = useTransitionStore((state) => state.flying);
  const load = useGatewayStore((state) => state.load);
  /*
    **没有后端的动作不出现在牌面上**（`lib/commandMatrix.ts` 自己那条规矩）。
    注册 MCP 与设备采样在新模型里没有对应的命令：MCP 现在是一条 `url` 供给、
    设备是一个包——这两件事都是**写声明**，不是两条命令。
  */
  const declarations = snapshot.declarations ?? [];
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  /** 空白处右键/长按的落点。**新建智能体的入口就在那张菜单里** */
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  /**
   * 已展开的一级节点（扩展 / 供应商）
   *
   * 纯视图状态，只在场景内：它回答的是「这一屏想看什么」，不是关于配置的
   * 任何事实，所以不入库、不进快照。key 就是节点 ID，不再从别处反解。
   */
  const [expandedNodes, setExpandedNodes] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * 正打开的那家供应商的模型目录。**纯视图状态**，跟 `expandedNodes` 一样
   * 只回答"这一屏想看什么"——它不写回任何地方。
   */
  const [catalog, setCatalog] = useState<
    (ResourceNodeModel['catalog'] & { referencedBy: number }) | null
  >(null);

  const model = useMemo(
    () => projectLiveConfiguration(snapshot, configurationId, expandedNodes),
    [configurationId, snapshot, expandedNodes]
  );

  /*
    选中的那一格**按"它是资料节点"来挑**，不是先挑再判类型。

    `projection.nodes` 是联合类型（Task / Schedule / Archive / Configuration /
    Resource），而这个场景只画资料节点——所以这里把类型收窄写进判据里：下面那块
    事实卡读的 `path` / `category` / `panel_note` / `config` 都是**资料节点才有**的
    格子，先挑后判的话每一处都得再判一次。
  */
  const selectedNode = model.projection.nodes.find(
    (n): n is ResourceNodeModel => n.type === 'resource' && n.id === selectedNodeId
  ) ?? null;
  /**
   * 左上角下面那块卡说的是**你点中的那一个**；**没点就不显示**
   *
   * 它以前回落到"带引用进来的那一格"，再回落到画布上的第一格——于是那一格看起来
   * 像是被选中了，而用户根本没碰过它。**没选中任何东西的时候，那块卡无论说什么
   * 都是替用户挑了一个**，而那正是它不该做的事。
   *
   * （从外部带着引用进来时，那个引用仍然会被展开、在画布上看得见——那是
   * "它在场上"，不是"它被选中了"。）
   */
  const panelNode = selectedNode;
  const focusedDiagnostic = diagnosticColumn(panelNode?.config);

  /**
   * 配置舱里**存在**哪些节点（画着的 + 收起来的）
   *
   * 收起一个包时它的条目不在画布上，但它们**还在**——布局表得留着那几格，
   * 否则再展开时它们会跳回投影算出来的地方。
   */
  const known = useMemo(() => new Set([
    ...model.projection.nodes.map((node) => node.id),
    ...model.abilities.map((node) => node.id),
    ...model.capabilities.map((node) => node.id),
    ...model.executorConfigurations.map((node) => node.id),
    ...model.agents.map((node) => node.id),
    ...model.providers.map((node) => node.id),
  ]), [model]);

  /*
    编辑中的智能体：定义从快照里取。

    取不到就**不打开**——刚被删掉的定义（或者只剩配置状态那一行的历史对象）
    打开一个空表单，用户会以为自己在编辑一个还在的东西。
  */
  const editingAgent = pendingEdit?.kind === 'agent'
    ? (snapshot.agents ?? []).find((item) => item.agent_ref === pendingEdit.agentRef) ?? null
    : null;

  /**
   * 双击一级节点
   *
   * **扩展**就地展开 / 收起：它之下是它声明的能力，把它们飞到另一个场景反而会
   * 丢掉「这一屏里一共几家」这件事。
   *
   * **供应商**打开的是一个**小窗**，里面是它的模型目录——不铺到画布上。一家聚合商
   * 两百多个模型，铺开就是把整块画布变成一片看不清的点。没有目录的（未标注供应商）
   * 双击不做任何事，也就不该凭空长出一个展开态。
   */
  const toggleExpansion = (nodeId: string) => {
    const node = model.projection.nodes.find((item) => item.id === nodeId);
    if (node?.type !== 'resource') return;

    if (node.resource_kind === 'executor-provider') {
      setCatalog(node.catalog
        ? {
            ...node.catalog,
            // 「被几条执行者引用」是这家的**用处**，不是它目录里的东西——一起说
            referencedBy: (snapshot.executors ?? [])
              .filter((item) => item.provider_id === node.catalog?.name).length,
          }
        : null);
      return;
    }

    if (!node.child_count) return;
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (!next.delete(nodeId)) next.add(nodeId);
      return next;
    });
  };

  /**
   * 操作牌提交
   *
   * 需要参数、或者要打开编辑页的命令改成打开覆盖层：它们没法一键提交，
   * 返回 `submitted: false` 让操作牌不显示回执——回执要等真正提交之后。
   *
   * 开关走哪一条由**对象自己**决定（`node.config` 在不在），不由命令类型猜：
   * 配置状态里没有这一行就不能发 `config.set_enabled`（后端会回「配置对象不存在」），
   * 那时剩下的真实命令是 `ability.start` / `ability.stop`。
   */
  const executeCommand = async (command: Command) => {
    const node = selectedNode?.type === 'resource' ? selectedNode : null;

    if (command.type === 'edit-agent') {
      if (node?.resource_kind === 'agent') setPendingEdit({ kind: 'agent', agentRef: node.id });
      return { submitted: false } as const;
    }

    if (command.type === 'edit-tool') {
      const owner = node?.owner;
      // 所属包解析不到就没有可改的目标：那时牌面上本来也不给这个入口
      if (node && owner?.state === 'resolvable') {
        setPendingEdit({
          kind: 'tool',
          extensionId: extensionIdOf(owner.ref),
          toolId: node.id,
        });
      }
      return { submitted: false } as const;
    }

    if (command.type === 'config-enable' || command.type === 'config-disable') {
      if (!node?.config) return { submitted: false } as const;
      const outcome = await executeConfigCommand(command, node.config, declarations);
      // 提交成功只表示 Core 已接收：真实状态以重读的对象为准
      if (outcome.submitted && outcome.ok) void load();
      return outcome;
    }

    // 剩下的都是**只读或导航**命令（查看资料…）：它们不提交任何东西，
    // 没有回执正是它们该有的样子（`view` 那条走 `onView`，见上面的说明）
    return { submitted: false } as const;
  };

  return (
    <div className="relative w-full h-full">
      <SpatialCanvas
        sceneId="configuration"
        nodes={model.projection.nodes}
        relations={model.projection.relations}
        nodeTypes={nodeTypes}
        selectedNodeId={selectedNodeId}
        interactive={!isFlying}
        /*
          不对整个场景取景：展开一个供应商就可能铺出几百项配置，塞进一屏只会
          让所有资料变成看不清的点。投影把可操作的 Ability / Capability 排在
          原点附近，目录按供应商分段排在后面，默认视口正好落在它们上面；
          往下滚、按需展开就是了。
        */
        fitView={false}
        onNodeClick={toggleSelected}
        onSelectionRestore={setSelected}
        onNodeDoubleClick={toggleExpansion}
        onPaneClick={() => setSelected(null)}
        onPaneContextMenu={(position) => setMenuPosition(position)}
        onNodeLongPress={setSelected}
        known={known}
      />

      {/*
        空白处右键 / 长按：**在配置舱里新建一个智能体**。
        智能体就是一个包，所以这一格提交的是"建一个新包目录 + 清单"——
        节点由重读的快照产生，前端不预置任何东西。
      */}
      {menuPosition && (
        <WorldContextMenu
          position={menuPosition}
          onClose={() => setMenuPosition(null)}
          onNewAgent={() => {
            setMenuPosition(null);
            setPendingEdit({ kind: 'agent', agentRef: '' });
          }}
        />
      )}

      {/*
        概览：贴在左上角返回锚点下方；顶部中央留给 HUD。

        **两块卡片，不是一块**：
        - 上面那块是**这一屏有多少东西**（谁都不点也在）；
        - 下面那块是**你正看着的那一个**（点名、位置、意图、观测、诊断）。

        混在一张卡上的时候，"总共几个"和"这一个怎么了"是同一个字号、同一个间距，
        扫一眼分不出哪几行是在说全场景、哪几行是在说手上这一格。
      */}
      <SceneOverlayStack>
        <SceneFacts
          title="配置舱"
          facts={[
            // 供应商和配置都给总数：收起时画布上只有几格，但目录实际有多少项
            // 是后端的事实，不能因为没展开就不说
            { label: '智能体', value: `${model.agents.length} 个` },
            { label: '供应商', value: `${model.providers.length} 项` },
            // **智能体那条不算在这里**（它在上一行的智能体里）：一个单位只报一次数，
            // 两处都报就是把同一个东西数了两遍
            { label: 'Executor', value: `${model.executorConfigurations.length} 项` },
            /*
              **Ability 数的是"提供能力的单位"**（后端 `registry.capabilities`：
              一条 `tools:` 声明就是一台供给），**不是包数**——只声明执行者的包不算，
              它是执行者实现或者智能体。实测那三个包里两个是这样，所以这一格是 1，
              不是 3；也不是画布上的节点数。
            */
            { label: 'Ability', value: `${snapshot.abilities.length} 项` },
            { label: 'Capability', value: `${model.capabilities.length} 项` },
          ]}
        />

        {/*
          下面那块：**只有选中了才出现**。点空白处取消选中，它就跟着收掉——
          「这一格现在是什么样」这个问题只有在"正在看某一格"的时候才有对象。
        */}
        {panelNode && (
          <SceneFacts
            title={panelNode.label}
            facts={[
              // 它是**哪一份文件里的东西**——配置舱是按文件看的，所以这一句要说得出来
              ...(panelNode.path ? [{ label: '位置', value: panelNode.path }] : []),
              // 它是哪一类（包 / 工具 / 执行者 / 智能体…）：**条目卡上不再写了**
              ...(panelNode.category ? [{ label: '类型', value: panelNode.category }] : []),
              /*
                **清单里那句说明**（包的描述、执行者为什么跑不了）也在这儿。

                它是**描述**不是诊断——以前它被塞进配置状态的 `diagnostic` 里，
                于是界面上每一格都挂着一句长得像故障的描述。
              */
              ...(panelNode.panel_note
                ? [{ label: '说明', value: panelNode.panel_note, wrap: true }]
                : []),
              /*
                焦点对象的那两栏：**意图**与**观测**分开说，另有诊断一句。
                「用户停用」与「它坏了」因此是两句不同的话——合成一个布尔值就
                说不清「你要它开着，但它起不来」。
              */
              ...configColumns(panelNode.config).map((column) => ({
                label: column.label,
                value: column.value,
                tone: column.tone,
              })),
              /*
                **诊断全文在这儿**，不在节点卡片上。

                一句诊断可能是一整段报错，而卡片上那一格只有十几个字宽——印上去的
                结果是每张卡都矮一截、字挤成几行，整块画布变成一片读不完的字。
                卡片上不是就不说了：坏了的东西观测那一栏是红色的「失败」，
                一眼看得出哪一格有问题，点一下就能读到全文。
              */
              ...(focusedDiagnostic ? [{ ...focusedDiagnostic, wrap: true }] : []),
            ]}
          />
        )}
      </SceneOverlayStack>

      {/*
        只读引用：真实引用该配置的 Task（不是配置的一部分，也不是执行单位）

        放右下而不是左下：设计给的区域是「底部两侧」，而配置舱最左一列
        Capability 就压在左下角——实测被面板盖掉 1263px²。右下的空位
        在四个场景里都是空的（`scripts/scenes/overlap.mjs` 量得到）。
      */}
      <div className="fixed bottom-24 right-5 z-30">
        <div className="glass rounded-xl p-3">
          <div className="label topline pb-1.5 mb-2">
            引用该配置的真实 Task
            <span className="num ml-1 text-gray-500">
              {model.referencedByTaskIds.length}
            </span>
          </div>
          {model.referencedByTaskIds.length === 0 ? (
            <div className="text-[11px] text-slate-500">暂无引用</div>
          ) : (
            // 列表本身可能很长（一天一次的日程会带出几十个子 Task）：
            // 限高滚动，不把画布压掉一整列
            <div className="space-y-1 max-h-[220px] overflow-auto">
              {model.referencedByTaskIds.map((taskId) => (
                <div key={taskId} className="num text-[11px] text-slate-300">
                  {taskId}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedNode?.type === 'resource' && !isFlying && (
        <CommandSurface
          targetLabel={selectedNode.label}
          model={buildNodeCommands(selectedNode, {
            canEnter: false,
            enterLabel: '进入局部场景',
          })}
          onExecute={executeCommand}
        />
      )}

      {/*
        供应商的模型目录：**小窗，不铺到画布上**（双击那个节点打开）。
        它是只读清单——模型目录写在供应商声明里，改它要改那份文件。
      */}
      {catalog && (
        <ProviderCatalogOverlay
          catalog={catalog}
          referencedBy={catalog.referencedBy}
          onClose={() => setCatalog(null)}
        />
      )}

      {/*
        智能体编辑页：覆盖层，不是可进入的 Scene。
        定义来自**快照**：这里不另存一份目录，节点上看到的就是它。
      */}
      {pendingEdit?.kind === 'agent' && (
        <AgentEditorOverlay
          key={editingAgent?.agent_ref ?? 'new-agent'}
          agent={editingAgent}
          creating={pendingEdit.agentRef === ''}
          snapshot={snapshot}
          onClose={() => setPendingEdit(null)}
        />
      )}

      {pendingEdit?.kind === 'tool' && (
        <ToolPermissionOverlay
          extensionId={pendingEdit.extensionId}
          capability={snapshot.capabilities.find((item) => item.tool_id === pendingEdit.toolId)}
          declarations={declarations}
          onClose={() => setPendingEdit(null)}
        />
      )}

    </div>
  );
}
