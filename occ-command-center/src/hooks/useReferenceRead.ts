/**
 * 单个引用的权威解析
 *
 * 快照是一个**批量**视图：它一次给出全部注册对象与全部配置状态行，够画布用了。
 * 但用户一次只盯着一个对象（自己选的模型、这个能力的所属包）时，权威答案在
 * 对象重读那一口上（ADR-031 §8：状态一律来自对象重读）——`GET /api/objects/{ref}`
 * 就是它，也正因为它是按对象读的，一条历史记录引用已下线的配置不会把整屏拖垮。
 *
 * 所以：先用快照算一个结论（画布立刻能画），**只在它不是「可解析」时**再问一次
 * 权威答案，拿到了就以后者为准。两个细节：
 *
 * - 读失败**不改结论**：读不到不等于未知，那只是一次没读成；
 * - 每次挂载只读一次（`ref` 与本地结论做依赖），填写表单时不该反复打后端。
 */

import { useEffect, useState } from 'react';
import { resolveObject, type GatewaySnapshot, type ResolvedReference } from '../api/gateway';
import { referenceStateOf } from '../core/projection/referenceState';
import type { ReferenceView } from '../core/types/node';

export function useReferenceRead(ref: string, snapshot: GatewaySnapshot): ReferenceView {
  const local = referenceStateOf(ref, snapshot);
  const [read, setRead] = useState<ResolvedReference | null>(null);

  const localState = local.state;
  useEffect(() => {
    if (!ref || localState === 'resolvable') return;
    let alive = true;
    void resolveObject(ref).then(
      (answer) => { if (alive) setRead(answer); },
      () => { /* 读不到就保留快照算出来的那个结论，不改成「未知」 */ }
    );
    return () => { alive = false; };
  }, [ref, localState]);

  if (!read) return local;
  return {
    ref: read.ref || local.ref,
    // 后端没给出键时用它自己的答案：unknown 就是「连键都没有」
    object_ref: read.object_ref || local.object_ref,
    state: read.state,
    kind: read.kind || local.kind,
    reason: read.reason,
  };
}
