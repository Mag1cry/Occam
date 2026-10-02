/**
 * AgentEditorOverlay
 *
 * 编辑一个智能体：**模型 + system_prompt + 扩展包（整包选）+ 逐工具的权限**。
 *
 * 它是覆盖层而不是一个 Scene：`SceneId` 里没有 agent，智能体是配置舱内的
 * **一等对象**（ADR-026），在配置舱里被看见、被编辑，但不进入另一个世界。
 *
 * 三条硬要求：
 *
 * 1. **模型只有一个入口**：模型不再出现在任务层，它在这里被选定（两级级联，
 *    供应商是分组轴，提交的只有叶子）。保存下来的那个模型如果已经不在可选项里
 *    （被停用），把它**画成一个选项**，而不是让它静默回落到第一条——那会在用户
 *    什么都没做的情况下改掉模型。基座同一条规矩（现存的定义要看得见），
 *    区别只在新建时它**默认落在第一项**：这一格没有"请选择"这一档；
 * 2. **权限只能收紧**（ADR-027）：声明就是地板，所以声明已经要审批的工具那一格
 *    是钉死的（后端也会拒——那是「放宽」的反方向，写进去毫无作用却让人以为改了）；
 * 3. **每一行只回答一个问题**：调这条工具之前要不要先问你。所以那一格给的是
 *    **权限本身**（不用审批 / 要审批），选中的那一个就是生效值——不再并排摆
 *    「声明 / 生效 / 我收紧的」三个值让人自己去推它们之间的关系。
 *    谁能改也一眼看得出：**改不了的是包定的，改得动的是我定的**；
 * 4. **模型那一格出不出，由基座说**：基座 `needs_llm: true` 才问（不问，后端在
 *    登记那一步会拒）。一段写死的代码（`weather.collect` 那种）不问——填了没人
 *    读，而"选了模型"会让人以为这条配置归某个模型管。
 *
 * 被拒时显示后端给的那句中文原因，不裹成「保存失败」。
 */

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { GlassPanel } from '../ui/GlassPanel';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { CascadingSelect } from '../ui/CascadingSelect';
import { ReferencePlaceholder } from '../ui/ReferencePlaceholder';
import { ActionPreview } from './ActionPreview';
import { deleteAgentCommand } from '../../lib/commandMatrix';
import { previewAgentTools } from '../../lib/agents';
import { referenceStateText } from '../../lib/nodeVisual';
import { useReferenceRead } from '../../hooks/useReferenceRead';
import { useGatewayStore } from '../../store/gatewayStore';
import { agentModelGroups, deleteAgent, upsertAgent,
         type GatewayAgent, type GatewaySnapshot } from '../../api/gateway';
import type { SelectGroup } from '../../lib/selectGroups';

export interface AgentEditorOverlayProps {
  /** 编辑哪一份定义：来自快照，不在这里另存一份目录。新建时是 `null` */
  agent?: GatewayAgent | null;
  snapshot: GatewaySnapshot;
  onClose: () => void;
  /** 新建：没有既有定义，多问一个**标识**（它同时是包目录名和执行者条目名） */
  creating?: boolean;
}

const FIELD_CLASS =
  'num mt-1 w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-occ-accent/50 transition-smooth';

/** 标识进文件系统当包目录名，所以只收 ASCII 的字母数字和 `-` `_` `.`。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function AgentEditorOverlay({ agent, snapshot, onClose, creating = false }: AgentEditorOverlayProps) {
  const load = useGatewayStore((state) => state.load);

  // 新建时 `agent_ref` 形如 `agent.<id>`；id 就是包目录名
  const existingId = (agent?.agent_ref ?? '').replace(/^agent\./, '');
  const [id, setId] = useState(existingId);
  const [label, setLabel] = useState(agent?.label ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(agent?.system_prompt ?? '');
  // 基座 = 自己带代码的执行者。**智能体不能基于智能体**（那样继承链要处理环）
  const bases = useMemo(
    () => (snapshot.executors ?? []).filter((item) => item.type !== 'agent'),
    [snapshot.executors]
  );
  /*
    两件事在旧模型里是一件：**基于哪段代码**（`executor:`）和**用哪个模型**。
    新模型里模型属于供应商（`_providers/*.yaml` 的 `models[]`），所以是两级：
    先挑基座，再挑"哪家的哪个"。

    **新建时默认落在第一项**：这一格本来就没得选——一台执行者都没有的时候，
    表单也交不出去（`canSubmit` 仍要求非空）。留一个"选择一段代码"的空档，
    只是逼人点一下下拉，而右边模型那一格早就自己填了第一项（`CascadingSelect`
    的回落），两格看着像两套规矩。
  */
  const [base, setBase] = useState(agent?.executor_config_ref ?? bases[0]?.ref ?? '');
  const [model, setModel] = useState(agent?.model_ref ?? '');
  const [packages, setPackages] = useState<string[]>(agent?.packages ?? []);
  const [tighten, setTighten] = useState<string[]>(
    () => (agent?.tools ?? []).filter((tool) => tool.tightened_by_agent).map((tool) => tool.tool_id)
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  /*
    模型的权威状态：快照只知道「可被新建引用」的那些，这里问一次对象重读。
    保存下来的那个模型已下线时，这是唯一能把原因说准的地方。
  */
  const modelView = useReferenceRead(agent?.executor_config_ref ?? '', snapshot);

  /*
    **模型那一格出不出现，由基座自己说。**

    它不是界面偏好：基座写着 `needs_llm: true` 而这条配置没给模型，后端在
    **登记那一步**就拒（`extensions/executors.py::check`）——所以那段代码要模型，
    就必须问。反过来，一段写死的代码（`needs_llm: false`，`weather.collect` 那种）
    问它要模型是**假问题**：填了也没人读，而"选了模型"这件事本身会让人以为
    这条配置归某个模型管。

    基座自己声明了 `model` 的也不问（一回事：它已经定死了，配置覆盖是特例）。
    基座还认不出来（编辑一份定义、而它的基座已经不在列表里）时**照问**——
    宁可多问一格，也不要凭空收掉一个字段。
  */
  const selectedBase = bases.find((item) => item.ref === base) ?? null;
  const asksModel = selectedBase ? Boolean(selectedBase.needs_llm) && !selectedBase.model : true;

  const modelGroups = useMemo<SelectGroup[]>(() => {
    const groups = agentModelGroups(snapshot);
    const known = groups.some((group) => group.options.some((option) => option.value === model));
    if (!model || known) return groups;
    // 不在列表里的当前值显式画出来：它是这个智能体现存的定义，不是「没选」
    return [
      {
        key: '__current__',
        label: `当前（${referenceStateText(modelView.state)}）`,
        options: [{ value: model, label: model }],
      },
      ...groups,
    ];
  }, [snapshot, model, modelView.state]);

  // 候选工具 = 选中包的工具并集。后端只在保存后才算得出，编辑时必须先看得见
  const tools = useMemo(
    () => previewAgentTools(snapshot, packages, tighten),
    [snapshot, packages, tighten]
  );

  const packagesWithTools = useMemo(
    () => snapshot.abilities.map((item) => ({
      // **供给名**，不是配置状态里的引用：这一格最终写成 `tools_from`，
      // 而那个字段按供给名找（`extensions/manifest.py` 的契约表）
      ref: item.supply ?? item.ability.ability_ref,
      label: item.ability.label || item.ability.ability_ref,
      toolCount: (item.capabilities ?? []).length,
    })),
    [snapshot.abilities]
  );

  /*
    校验只有这一处，而**每一格为什么不合格都必须说得出来**。

    按钮会禁用，但禁用不等于"什么都不用说"：一个禁用的按钮不会再弹任何东西，
    用户点它没反应，只能猜自己哪里错了（"我填了字，界面没提示，按钮就是点不动"）。
    所以禁用的同时，原因必须一直摆在旁边——`missing` 就是那句话。
  */
  const idFilled = ID_PATTERN.test(id.trim());
  const labelFilled = label.trim().length > 0;
  // 系统提示**不必填**：留空就继承基座声明的那份
  // （`extensions/executors.py::configured()` 是 `entry.prompt or base.prompt`），
  // 所以这里不校验它——界面不该比后端更严，要求一个后端并不要求的字段。
  const modelFilled = !asksModel || model.length > 0;

  const canSubmit = labelFilled && base.length > 0 && modelFilled
    && (!creating || idFilled) && !submitting;

  // 「还差什么」：按格子列出来，贴在保存按钮旁边
  const missing = [
    !labelFilled && '名称',
    creating && !idFilled && '标识',
    !modelFilled && '模型',
    base.length === 0 && '基座',
  ].filter((item): item is string => Boolean(item));

  /*
    填了东西却**不合法**的，当场在那一格上冒红。

    空着的必填项不在这里冒红——新建时它们本来就是空的，一上来满屏红没有信息量；
    那几种由按钮旁边的「还差……」承担。两者合起来才覆盖"每一条不合格都看得见"。
  */
  const idError = creating && id.trim().length > 0 && !idFilled
    ? '只能字母数字和 - _ .，且以字母数字开头——它是包目录名，中文和空格都不行'
    : '';

  const toggleIn = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await upsertAgent({
        id: id.trim(),
        label: label.trim(),
        description: description.trim(),
        base,
        modelRef: model,
        system_prompt: systemPrompt.trim(),
        packages,
        tighten,
        creating,
      });
      // 保存成功不等于节点已经变了：定义由重读的快照呈现
      await load();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    setConfirmingDelete(false);
    setSubmitting(true);
    setError(null);
    try {
      await deleteAgent(id.trim());
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
      <GlassPanel variant="strong" className="w-[560px] max-h-[86vh] overflow-auto p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-base font-medium text-white">
              {creating ? '新建智能体配置' : '编辑智能体'}
            </div>
            <div className="num text-xs text-gray-500 mt-1">
              {creating ? '它就是一个包：保存 = 写一份声明' : `${agent?.agent_ref} · 修订 ${agent?.revision}`}
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
          {creating && (
            <label className="block">
              <span className="text-xs text-gray-400">
                标识（包目录名，之后改不了 · 只能字母数字和 - _ .）
              </span>
              <input
                value={id}
                onChange={(event) => setId(event.target.value)}
                placeholder="ops-readonly"
                aria-invalid={Boolean(idError)}
                className={`${FIELD_CLASS} ${idError ? 'border-occ-crit' : ''}`}
              />
              {idError && (
                <span role="alert" className="mt-1 block text-[11px] text-occ-crit-light">
                  {idError}
                </span>
              )}
            </label>
          )}

          <label className="block">
            <span className="text-xs text-gray-400">名称</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className={FIELD_CLASS}
            />
          </label>

          <label className="block">
            <span className="text-xs text-gray-400">基座（基于哪段代码）</span>
            <select
              value={base}
              onChange={(event) => {
                const next = event.target.value;
                setBase(next);
                /*
                  换到一段**不用模型**的代码上，就把已经选好的模型清掉。

                  不清的话，那一格从屏幕上消失、值却还在 state 里，保存时一起写进
                  声明——用户看不见它，却要为它负责。切换基座是用户自己的动作，
                  顺手清掉一个**已经和这条定义无关**的值，不算替他改东西。
                */
                const target = bases.find((item) => item.ref === next) ?? null;
                if (target && (!target.needs_llm || target.model)) setModel('');
              }}
              className={FIELD_CLASS}
              aria-label="基座"
            >
              {/*
                每一格都要**自己带底色**。原生下拉那一层弹窗不在页面的背景里，
                不给它上色就按操作系统的默认走——在这个深色界面上就是一片白。
                （其余下拉都这么写，这一格当初漏了。）
              */}
              {/*
                **没有"请选择"这一档**：默认就是第一项。留着那个空档等于逼人点一下
                下拉，而值是空的这件事在这一格上没有任何意义——一台执行者都没有的
                话，表单本来也交不出去。

                列表空着时说"没有"，而不是给一个选了也没用的选项。
              */}
              {bases.length === 0 && (
                <option value="" className="bg-occ-bg">没有可用的基座</option>
              )}
              {/*
                定义里的基座**不在候选里**（它所属的包被删了、或被停用）时，把它
                **画成一格**。不画的话，受控的 select 落到第一项上显示——那一格
                看起来选了 A，值却还是 B，而保存会把这个错位写回声明。
                （和模型那一格同一条规矩：现存的定义要看得见。）
              */}
              {base && !bases.some((item) => item.ref === base) && (
                <option value={base} className="bg-occ-bg">{base}（已不在系统里）</option>
              )}
              {bases.map((item) => (
                <option key={item.ref} value={item.ref ?? ''} className="bg-occ-bg">
                  {item.display_name ?? item.ref}
                </option>
              ))}
            </select>
          </label>

          {asksModel ? (
            <div className="block">
              <span className="text-xs text-gray-400">模型</span>
              <CascadingSelect
                groups={modelGroups}
                value={model}
                onChange={setModel}
                groupLabel="供应商"
                ariaLabel="模型"
                emptyLabel="没有可用的模型"
                className="mt-1"
              />
              {/*
                占位**只在编辑时画**：新建的时候那个引用本来就是空的，
                画出来只会多一句「未知 · 系统里没有这个引用的任何记录」——
                而那是**还没填**，不是"找不到"。把空说成失踪，是最糟的一种假话。
              */}
              {!creating && (
                <div className="mt-1">
                  <ReferencePlaceholder view={modelView} role="模型" />
                </div>
              )}
            </div>
          ) : (
            /*
              收掉那一格要说为什么。**空一块地方比多一格更让人不安**：
              用户会以为界面漏画了，或者自己点错了什么。
            */
            <div className="block">
              <span className="text-xs text-gray-400">模型</span>
              <div className="num mt-1 text-[11px] text-gray-500">
                {/* 说这句用的名字要和上面那一格**同一个**——不然读的人还要自己
                    对上"天气"和"weather.collect"是不是一回事 */}
                {selectedBase?.display_name ?? selectedBase?.ref} 是一段固定代码，不用模型
              </div>
            </div>
          )}

          <label className="block">
            <span className="text-xs text-gray-400">
              系统提示（它每次开工前看到的那段话 · 可留空）
            </span>
            <textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              rows={4}
              /* 留空是合法的，而且是最常见的做法——把"继承"这件事写在格子里，
                 别让人以为漏填了 */
              placeholder="留空则用基座声明的那份系统提示"
              className={`${FIELD_CLASS} resize-y`}
            />
          </label>

          <div className="block">
            <span className="text-xs text-gray-400">扩展包（整包选，不逐个工具）</span>
            <div className="mt-1 space-y-1 max-h-[140px] overflow-auto rounded border border-white/10 p-2">
              {packagesWithTools.length === 0 && (
                <div className="text-[11px] text-gray-500">快照里没有可选的包</div>
              )}
              {packagesWithTools.map((item) => (
                <label key={item.ref} className="flex items-center gap-2 text-[12px] text-slate-300">
                  <input
                    type="checkbox"
                    checked={packages.includes(item.ref)}
                    onChange={() => setPackages((prev) => toggleIn(prev, item.ref))}
                  />
                  <span className="truncate">{item.label}</span>
                  <span className="num text-[10px] text-gray-500">{item.ref}</span>
                  <span className="num text-[10px] text-gray-500 ml-auto">{item.toolCount} 项工具</span>
                </label>
              ))}
            </div>
          </div>

          <div className="block">
            <span className="text-xs text-gray-400">逐工具权限</span>
            <div className="mt-1 rounded border border-white/10">
              <div className="flex items-center gap-2 px-2 py-1 text-[10px] text-gray-500 border-b border-white/10">
                <span className="flex-1">工具</span>
                <span className="w-44 text-center">权限</span>
              </div>
              {tools.length === 0 && (
                <div className="px-2 py-2 text-[11px] text-gray-500">
                  选中的包没有声明工具
                </div>
              )}
              {tools.map((tool) => (
                <div key={tool.tool_id} className="flex items-center gap-2 px-2 py-1 text-[11px] text-slate-300">
                  <span className="num flex-1 truncate">{tool.tool_id}</span>
                  <select
                    aria-label={`${tool.tool_id} 的权限`}
                    /*
                      这一格问的是**这一条工具要不要人点头**，直接给两个权限值：
                      选中的那一个就是**生效**的那个（`declared or tightened`），
                      中间那两列因此不需要了——一列「声明」、一列「生效」、再加一列
                      「我收紧的」，读者得在三个值之间自己推关系，而回答的其实只有
                      一件事：调它之前要不要先问你。

                      能力声明已经要审批的工具那一格是**钉死的**：收紧它毫无作用
                      （`declared or tightened` 里它恒为真），后端也会拒。锁上并说明
                      是谁定的——「可改的是我定的，改不了的是包定的」。
                    */
                    value={tool.effective ? 'approve' : 'free'}
                    disabled={tool.declared}
                    onChange={(event) =>
                      setTighten((prev) => {
                        const approve = event.target.value === 'approve';
                        if (approve) return prev.includes(tool.tool_id) ? prev : [...prev, tool.tool_id];
                        return prev.filter((item) => item !== tool.tool_id);
                      })
                    }
                    className="w-44 px-2 py-0.5 rounded bg-white/5 border border-white/10 text-[11px] text-white outline-none focus:border-occ-accent/50 transition-smooth disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {tool.declared ? (
                      <option value="approve" className="bg-occ-bg">要审批 · 扩展包钉死</option>
                    ) : (
                      <>
                        <option value="free" className="bg-occ-bg">不用审批</option>
                        <option value="approve" className="bg-occ-bg">要审批</option>
                      </>
                    )}
                  </select>
                </div>
              ))}
            </div>
            <span className="block text-[11px] text-gray-500 mt-1">
              扩展包声明的是地板：只能更严，不能放宽。写着「扩展包钉死」的那些改不了——
              它们本来就按最严的来
            </span>
          </div>

          <label className="block">
            <span className="text-xs text-gray-400">描述</span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className={FIELD_CLASS}
            />
          </label>
        </div>

        {error && (
          <div className="mt-3 text-[11px] text-occ-crit-light break-words">{error}</div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* 提交的**就是**这两条命令之一：新建是建一份声明，改是重写一栏 */}
            <Badge variant="info" size="sm">
              {creating ? 'manifest.create' : 'manifest.write'}
            </Badge>
            {!creating && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmingDelete(true)}
                disabled={submitting}
              >
                删除
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/*
              **按钮为什么点不动，就写在这里。** 禁用的按钮不会再弹任何东西，
              所以原因必须一直看得见，而不是等用户去猜（R-001）。
            */}
            {missing.length > 0 && (
              <span className="text-[11px] text-occ-warn" role="status">
                还差：{missing.join(' · ')}
              </span>
            )}
            <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button size="sm" onClick={() => void handleSubmit()} disabled={!canSubmit}>
              {submitting ? '提交中…' : '保存'}
            </Button>
          </div>
        </div>
      </GlassPanel>

      {/* 删除不可逆：先预览再提交（focus-leap 第 6 节） */}
      {confirmingDelete && agent && (
        <ActionPreview
          targetId={agent.agent_ref}
          targetLabel={label || agent.agent_ref}
          command={deleteAgentCommand()}
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
