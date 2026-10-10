/**
 * 连接表单：**后端在哪、以什么身份**。
 *
 * 两个入口共用它：`SceneStateLayer`（连不上时那个人是唯一能渲染的东西）和
 * 配置舱（已经连上、想换后端或管设备时）。
 *
 * ## 两条路，不是两个界面
 *
 * | | 谁适合 | 代价 |
 * | --- | --- | --- |
 * | **配对** | 手机、平板——打不了 43 个字符 | 要等局域网里的人点一下头 |
 * | **直接填凭据** | 你已经坐在那台机器前，读得到 `data/access-token.json` | 无 |
 *
 * 默认给配对，因为它才是这个表单存在的理由；填凭据那条收在下面。
 *
 * ## 等待批准是轮询，不是 SSE
 *
 * `/api/events` 挂在 guard 后面，而**待批设备什么凭据都没有**——那正是它要配对的原因。
 * 要给它推送就得再开一个免鉴权的 SSE 端点，那是新的一块公网面。
 *
 * 更要紧的是：**配对是引导流程，它必须在别的什么都不通的时候能工作**。
 * 把引导建在整个方案里最不确定的那个特性（跨域 SSE）上，方向是反的——
 * SSE 挂了 → 配不上 → 进不去 → 也查不了。
 *
 * ← 新建
 */

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../ui/Button';
import { readConnection, writeConnection } from '../../api/connection';
import { accessStatus, requestAccess, type PendingAccess } from '../../api/access';

/** 手机浏览器的名字——**默认值只是省一次输入**，人认的仍然是这个名字 */
function guessDeviceName(): string {
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android 设备';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS 设备';
  if (/Windows/i.test(ua)) return 'Windows 电脑';
  if (/Macintosh/i.test(ua)) return 'Mac';
  return '一台设备';
}

type Phase = 'form' | 'waiting' | 'paired';

export interface ConnectionFormProps {
  /** 连上了 / 凭据换了之后叫一声——调用方据此重读快照 */
  onChanged?: () => void;
}

export function ConnectionForm({ onChanged }: ConnectionFormProps) {
  const saved = readConnection();
  const [endpoint, setEndpoint] = useState(saved.endpoint);
  const [deviceName, setDeviceName] = useState(guessDeviceName);
  const [credential, setCredential] = useState('');

  const [phase, setPhase] = useState<Phase>('form');
  const [pending, setPending] = useState<PendingAccess | null>(null);
  const [left, setLeft] = useState(0);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const timer = useRef<number | null>(null);

  /** 地址当场落盘：**不落盘的话，手机一刷新就把刚填的地址忘了**，又得重来 */
  const 记住地址 = () => writeConnection({ endpoint });

  const 请求接入 = async () => {
    setMessage('');
    setBusy(true);
    try {
      writeConnection({ endpoint, credential: '' });
      const asked = await requestAccess(deviceName);
      if (!asked) {
        // 后端故意不说拒的是限速、队列满还是名字空——**对一个免鉴权的端点，
        // 说得越细越像是在帮人试探边界**
        setMessage('这次没能排上。过几分钟再试，或者换个名字看看。');
        return;
      }
      setPending(asked);
      setLeft(asked.expires_in);
      setPhase('waiting');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const 直接填凭据 = () => {
    const value = credential.trim();
    if (!value) {
      setMessage('凭据是空的。');
      return;
    }
    writeConnection({ endpoint, credential: value });
    setMessage('');
    onChanged?.();
  };

  /*
    等批准。**每 2 秒问一次**，而且只在 `waiting` 这一档里问——
    拿到结果就停，不留一个空转的定时器。
  */
  useEffect(() => {
    if (phase !== 'waiting' || !pending) return;

    let 停 = false;
    const 一轮 = async () => {
      try {
        const result = await accessStatus(pending.request_id);
        if (停) return;
        if (result.state === 'approved') {
          writeConnection({ endpoint, credential: result.credential });
          setPhase('paired');
          onChanged?.();
          return;
        }
        if (result.state === 'unknown') {
          setPhase('form');
          setMessage('这条请求过期了，或者被拒了。重新来一次吧。');
          return;
        }
        setLeft(result.expires_in);
      } catch {
        // 一轮失败不当回事——网络抖一下很正常，下一轮接着问
      }
    };

    timer.current = window.setInterval(() => void 一轮(), 2000);
    void 一轮();
    return () => {
      停 = true;
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [phase, pending, endpoint, onChanged]);

  if (phase === 'paired') {
    return (
      <div className="flex items-start gap-2 text-[12px] text-occ-ok">
        <Check className="w-4 h-4 shrink-0 mt-0.5" />
        <span>这台设备已经接入了。下次打开不用再配。</span>
      </div>
    );
  }

  if (phase === 'waiting' && pending) {
    return (
      <div className="space-y-3">
        <div className="text-[12px] text-slate-300">
          在<strong className="text-slate-100">已经连上这台后端</strong>的设备上，
          核对下面这个码之后点批准。
        </div>
        <div className="num text-center text-[22px] tracking-[0.2em] text-occ-accent py-3 rounded-lg bg-white/[0.04] border border-white/10">
          {pending.code}
        </div>
        <div className="flex items-center justify-between text-[11px] text-gray-500">
          <span className="flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" />
            等待批准
          </span>
          <span className="num">{left}s 后过期</span>
        </div>
        <Button variant="secondary" onClick={() => { setPhase('form'); setPending(null); }}>
          取消
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-[11px] text-gray-400">后端地址</span>
        <input
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          onBlur={记住地址}
          placeholder="留空 = 和页面同源；例如 http://192.168.0.100:8765"
          className="mt-1 w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-[12px] text-white outline-none focus:border-occ-accent/50 transition-smooth"
        />
      </label>

      <label className="block">
        <span className="text-[11px] text-gray-400">这台设备叫什么</span>
        <input
          value={deviceName}
          onChange={(event) => setDeviceName(event.target.value)}
          className="mt-1 w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-[12px] text-white outline-none focus:border-occ-accent/50 transition-smooth"
        />
        {/*
          名字是**人在设备列表里认出它的唯一依据**。空名字等于列表里一排"unknown"，
          而那时你要吊销谁就说不清了。
        */}
        <span className="block text-[11px] text-gray-500 mt-1">
          批准的人看到的、以后要吊销时看到的，都是这个名字。
        </span>
      </label>

      <Button onClick={() => void 请求接入()} disabled={busy || !deviceName.trim()}>
        <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
        请求接入
      </Button>

      <details className="pt-1">
        <summary className="text-[11px] text-gray-500 cursor-pointer hover:text-slate-300">
          或者，直接填一个凭据
        </summary>
        <div className="mt-2 space-y-2">
          <input
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
            placeholder="data/access-token.json 里的令牌，或配对签发的凭据"
            className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-[12px] text-white outline-none focus:border-occ-accent/50 transition-smooth"
          />
          <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <Copy className="w-3 h-3" />
            这台机器的令牌在那台机器上，只读得到一次就得自己抄下来。
          </span>
          <Button variant="secondary" onClick={直接填凭据}>用它</Button>
        </div>
      </details>

      {message && (
        <div className="text-[11px] text-occ-warn-light break-words" role="status">{message}</div>
      )}
    </div>
  );
}
