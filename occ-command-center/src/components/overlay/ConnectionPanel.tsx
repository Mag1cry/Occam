/**
 * 配置舱里的「连接」面板：**谁能连上这台机器**。
 *
 * ## 为什么不混进「待拍板」
 *
 * 「待拍板」是 **Task 的语义**——一件事卡在那儿等人拍板，整条链就停在它上面
 * （`frontend-experience` 里那条）。设备接入是**宿主的事**：它不产生 Task，
 * 不进事件链，归 `gateway/access/` 管。
 *
 * 混在一起会把那条边界糊掉：以后读"待拍板有几个"就分不出是"活等人"还是"人等人"。
 *
 * ## 为什么不挂在 HUD 上
 *
 * HUD 是**注意力**那一层，它只该显示"有多少件等你"。设备接入是低频动作，
 * 犯不着占那个位置。但它确实需要被人看见——所以放在配置舱（"配置与能力"，
 * 而"谁能连进来"就是配置）。
 *
 * ## 轮询，不是 SSE
 *
 * `/api/events` 流的是 Core 的控制事实（标脏），接入请求不是控制事实。
 * 何况这个面板只在配置舱挂着，几秒问一次代价很小。
 *
 * ← 新建
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, Plug, ShieldCheck, Trash2, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { useConnection } from '../../hooks/useConnection';
import {
  approveAccess,
  denyAccess,
  listDevices,
  listPending,
  revokeDevice,
  type PairedDevice,
  type PendingAccess,
} from '../../api/access';

/** 待批是"有人在门口等着"——三秒不算密，而几秒的延迟在这里没有任何意义 */
const POLL_MS = 3000;

interface 接入面 {
  pending: PendingAccess[];
  devices: PairedDevice[];
}

/**
 * 两个接口一起拿：它们总是一起显示，分两次拿只会让"半张列表"那个中间态多出来。
 *
 * **放模块作用域而不是 `useCallback`**：下面那个 effect 直接调它、在 `.then` 里落地，
 * 和 `TaskScene` 拉执行结果同一个形状——effect 里现造一个含 `setState` 的本地回调
 * 会触发 `react(set-state-in-effect)`（那条规则分不清"同步 setState"和"await 之后的"）。
 */
async function 读接入面(): Promise<接入面> {
  const [pending, devices] = await Promise.all([listPending(), listDevices()]);
  return { pending, devices };
}

export function ConnectionPanel() {
  const connection = useConnection();
  const [pending, setPending] = useState<PendingAccess[]>([]);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [error, setError] = useState('');

  const 落地 = useCallback((next: 接入面) => {
    setPending(next.pending);
    setDevices(next.devices);
    setError('');
  }, []);

  useEffect(() => {
    let alive = true;
    const 一轮 = () => {
      读接入面()
        .then((next) => { if (alive) 落地(next); })
        // 读不到就说出来，**但不清空已经拿到的**——上一次那份列表仍然是已知事实
        .catch((reason: unknown) => {
          if (alive) setError(reason instanceof Error ? reason.message : String(reason));
        });
    };

    一轮();
    const timer = window.setInterval(一轮, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [落地]);

  const 动作 = async (run: () => Promise<void>) => {
    try {
      await run();
      await 读接入面().then(落地);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="glass rounded-xl p-3">
      <div className="label topline pb-1.5 mb-2 flex items-center gap-1.5">
        <Plug className="w-3 h-3" />
        连接
      </div>

      <div className="space-y-1 text-[11px]">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-slate-500">后端</span>
          <span className="num text-right truncate text-slate-300">
            {connection.endpoint || '同源'}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-slate-500">身份</span>
          <span className="truncate text-slate-300">
            {connection.credential ? '已带凭据' : '无凭据（靠来源网段）'}
          </span>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="mt-3 pt-2 border-t border-white/10">
          <div className="label mb-1.5">
            等在门口的 <span className="num">{pending.length}</span>
          </div>
          <div className="space-y-2">
            {pending.map((entry) => (
              <div key={entry.request_id} className="rounded-lg bg-occ-warn/[0.06] border border-occ-warn/25 px-2 py-1.5">
                <div className="text-[11px] text-slate-200 truncate">{entry.device_name}</div>
                {/*
                  **这个码是人核对的那一步。** 它必须和请求方屏幕上显示的一模一样——
                  没有这一步，谁先请求谁就拿到访问权。
                */}
                <div className="num text-[14px] tracking-[0.15em] text-occ-warn my-1">
                  {entry.code}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" onClick={() => void 动作(() => approveAccess(entry.request_id))}>
                    <Check className="w-3 h-3" />
                    批准
                  </Button>
                  <Button variant="secondary" size="sm"
                          onClick={() => void 动作(() => denyAccess(entry.request_id))}>
                    <X className="w-3 h-3" />
                    拒绝
                  </Button>
                  <span className="num text-[10px] text-gray-500 ml-auto">{entry.expires_in}s</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {devices.length > 0 && (
        <div className="mt-3 pt-2 border-t border-white/10">
          <div className="label mb-1.5">
            已接入 <span className="num">{devices.length}</span>
          </div>
          <div className="space-y-1">
            {devices.map((device) => (
              <div key={device.device_id} className="flex items-center gap-2 text-[11px]">
                <ShieldCheck className="w-3 h-3 text-occ-ok shrink-0" />
                <span className="truncate text-slate-300">{device.name}</span>
                <button
                  type="button"
                  aria-label={`吊销 ${device.name}`}
                  title={`吊销 ${device.name}`}
                  onClick={() => void 动作(() => revokeDevice(device.device_id))}
                  className="ml-auto text-gray-500 hover:text-occ-crit transition-smooth shrink-0"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2 text-[10px] text-occ-warn-light break-words" role="status">{error}</div>
      )}
    </div>
  );
}
