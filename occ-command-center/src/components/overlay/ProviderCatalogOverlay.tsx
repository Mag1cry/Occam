/**
 * ProviderCatalogOverlay
 *
 * 一家供应商的**模型目录**，一个小窗装下。
 *
 * **为什么不铺到画布上**：一家聚合商两百多个模型。按节点铺开，它们会把整块画布
 * 变成一片看不清的点——而"这家有哪些模型"恰好是打开这一格唯一想知道的事。
 * 所以它是一个可滚动的清单，不是一堆节点。
 *
 * 清单本身是**纯读**：模型目录是供应商声明里的 `models:` 一栏（模型属于供应商，
 * 不由执行者拼出来），改它要改那份文件，不是在这里点按。
 */

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { GlassPanel } from '../ui/GlassPanel';
import { Badge } from '../ui/Badge';

export interface ProviderCatalogOverlayProps {
  catalog: {
    name: string;
    enabled: boolean;
    models: { name: string; owned_by?: string }[];
  };
  /** 有几条执行者正引用这家。**不是这一格的内容，是它的用处** */
  referencedBy?: number;
  onClose: () => void;
}

const SEARCH_CLASS =
  'w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm text-white ' +
  'outline-none focus:border-occ-accent/50 transition-smooth';

export function ProviderCatalogOverlay({
  catalog,
  referencedBy = 0,
  onClose,
}: ProviderCatalogOverlayProps) {
  const [query, setQuery] = useState('');

  const found = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return catalog.models;
    return catalog.models.filter(
      (model) =>
        model.name.toLowerCase().includes(needle)
        || String(model.owned_by ?? '').toLowerCase().includes(needle)
    );
  }, [catalog.models, query]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50">
      <GlassPanel variant="strong" className="w-[420px] p-5 flex flex-col max-h-[70vh]">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-base font-medium text-white">{catalog.name}</div>
            <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
              <span>
                模型目录 <span className="num text-slate-300">{catalog.models.length}</span> 项
              </span>
              {!catalog.enabled && <Badge variant="warning" size="sm">已停用</Badge>}
              <span>
                被 <span className="num text-slate-300">{referencedBy}</span> 条执行者引用
              </span>
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

        {/* 两百多个名字靠滚动找是折磨；这一格只是把找变快，不改清单本身 */}
        {catalog.models.length > 12 && (
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按名字或厂家筛"
            className={SEARCH_CLASS}
            aria-label="筛选模型"
          />
        )}

        <div className="mt-3 overflow-auto" data-provider-catalog>
          {found.length === 0 ? (
            <div className="text-[12px] text-slate-500">
              {catalog.models.length === 0 ? '这家还没有模型目录' : '没有匹配的模型'}
            </div>
          ) : (
            found.map((model) => (
              <div
                key={model.name}
                className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0"
              >
                <span className="num text-[12px] text-slate-200 break-all">{model.name}</span>
                {model.owned_by && (
                  <span className="ml-2 shrink-0 text-[11px] text-slate-500">
                    {model.owned_by}
                  </span>
                )}
              </div>
            ))
          )}
        </div>

        <p className="mt-3 text-[11px] text-gray-500 leading-relaxed">
          模型属于供应商（`extensions/_providers/{catalog.name}.yaml` 的 `models:`），
          不属于任何执行者。要用哪一个，是在智能体上说的。
        </p>
      </GlassPanel>
    </div>
  );
}
