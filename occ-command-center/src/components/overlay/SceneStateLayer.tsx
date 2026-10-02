/**
 * SceneStateLayer
 *
 * 拿不到后端快照时画布上显示的东西。
 *
 * 这一层存在的原因：后端不可达和「后端是空的」是两件事，都不能用原型数据
 * 顶上（backend-contract.md 第 6 节）。这里只说明当前状态和可做的事，
 * 不渲染任何节点——没有事实就没有节点。
 */

import { AlertTriangle, Loader2 } from 'lucide-react';
import { GlassPanel } from '../ui/GlassPanel';
import { Button } from '../ui/Button';
import type { SnapshotStatus } from '../../store/gatewayStore';

export interface SceneStateLayerProps {
  status: SnapshotStatus;
  error: string | null;
  onRetry: () => void;
}

export function SceneStateLayer({ status, error, onRetry }: SceneStateLayerProps) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <GlassPanel className="px-6 py-5 max-w-[420px]">
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
                  ? '这是从外网访问：浏览器应当已经弹出登录框，用户名随意，密码填本机的访问令牌（data/access-token.json）'
                  : '没有拿到 Core 事实，因此不显示任何节点'}
              </div>
              {error && (
                <div className="text-xs text-occ-warn-light mt-2 break-words">
                  {error}
                </div>
              )}
              <div className="mt-4">
                <Button variant="secondary" onClick={onRetry}>
                  重试
                </Button>
              </div>
            </div>
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
