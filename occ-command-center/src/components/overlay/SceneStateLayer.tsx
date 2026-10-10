/**
 * SceneStateLayer
 *
 * 拿不到后端快照时画布上显示的东西。
 *
 * 这一层存在的原因：后端不可达和「后端是空的」是两件事，都不能用原型数据
 * 顶上（backend-contract.md 第 6 节）。这里只说明当前状态和可做的事，
 * 不渲染任何节点——没有事实就没有节点。
 */

import { useState } from 'react';
import { AlertTriangle, Loader2, Plug } from 'lucide-react';
import { GlassPanel } from '../ui/GlassPanel';
import { Button } from '../ui/Button';
import { ConnectionForm } from './ConnectionForm';
import type { SnapshotStatus } from '../../store/gatewayStore';

export interface SceneStateLayerProps {
  status: SnapshotStatus;
  error: string | null;
  onRetry: () => void;
}

export function SceneStateLayer({ status, error, onRetry }: SceneStateLayerProps) {
  /*
    **连不上时这里是唯一还能渲染的东西。**

    没有快照 → 画布上一个节点都没有 → 配置舱那类"进去改设置"的路全都不通
    （它们本身就要读快照）。所以设置连接这件事必须**就地**能做，不能指路到别处。
    打包成 Android 应用之后这是硬要求：首次打开时它既不知道后端地址、
    也没有任何凭据。
  */
  const [设置中, set设置中] = useState(false);

  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <GlassPanel className="px-6 py-5 w-[min(440px,92vw)] max-h-[85vh] overflow-auto">
        {status === 'loading' ? (
          <div className="flex items-center gap-3">
            <Loader2 className="w-4 h-4 text-occ-accent animate-spin shrink-0" />
            <div>
              <div className="text-sm text-slate-200">正在读取网关快照</div>
              <div className="text-xs text-gray-500 mt-1">
                读取完成前不显示任何节点
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-occ-warn shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              {/*
                认证失败和「后端挂了」要分开说。后端是好的，它只是在等你证明
                你有权访问——把它说成「不可达」，用户就会去重启一个好好的服务。
              */}
              <div className="text-sm text-slate-200">
                {status === 'unauthorized' ? '需要认证' : '后端不可达'}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {status === 'unauthorized'
                  /*
                    这里以前写的是"浏览器应当已经弹出登录框" —— **那句话是错的**：
                    后端挑战的是 `Bearer`，而浏览器只对 `Basic` 弹框，所以永远不弹。
                    现在两条路都说得出来：配对（手机上唯一可行的那条），
                    或者从 `data/access-token.json` 里抄令牌（你就在那台机器前时最快）。
                  */
                  ? '后端是好的，它只是在等你证明有权访问。用下面「设置连接」请求接入；那台机器的令牌在 data/access-token.json 里。'
                  : '没有拿到 Core 事实，因此不显示任何节点'}
              </div>
              {error && (
                <div className="text-xs text-occ-warn-light mt-2 break-words">
                  {error}
                </div>
              )}
              <div className="mt-4 flex items-center gap-2">
                <Button variant="secondary" onClick={onRetry}>
                  重试
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => set设置中((prev) => !prev)}
                >
                  <Plug className="w-3.5 h-3.5" />
                  设置连接
                </Button>
              </div>
              {设置中 && (
                <div className="mt-4 pt-4 border-t border-white/10">
                  <ConnectionForm onChanged={onRetry} />
                </div>
              )}
            </div>
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
