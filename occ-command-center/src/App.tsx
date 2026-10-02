/**
 * App
 *
 * 全屏画布 + 悬浮 Overlay。
 *
 * 画布独占全屏，HUD、焦点锚点、操作牌、转场层一律悬浮在画布之上，
 * 不与画布并列，不使用 header + sidebar + main 布局。
 */

import { SceneRenderer } from './core/scene/SceneRenderer';
import { FloatingHud } from './components/overlay/FloatingHud';
import { FocusAnchor } from './components/overlay/FocusAnchor';
import { OutputOverlay } from './components/overlay/OutputOverlay';
import { useFocusLeap } from './hooks/useFocusLeap';
import { useEffect } from 'react';

/** 没有悬着的输出时那个**稳定**的空表（见下面选择器那段） */
const EMPTY_OUTPUTS: never[] = [];
import { useGatewayStore } from './store/gatewayStore';

function App() {
  // 挂载 Focus Leap 编排：转场结束后提交 SceneStack 变更
  useFocusLeap();
  const connect = useGatewayStore((state) => state.connect);
  const load = useGatewayStore((state) => state.load);
  /*
    **选择器里不能现造新数组**：`state.snapshot?.outputs ?? []` 每次调用都返回一个
    新数组，`useSyncExternalStore` 拿 `Object.is` 比它 → 每次都"变了" → 无限重渲染
    （实测：`Maximum update depth exceeded`）。所以空值只取出去，兜底放在选择器外面。
  */
  const outputs = useGatewayStore((state) => state.snapshot?.outputs) ?? EMPTY_OUTPUTS;
  useEffect(() => { void load(); return connect(); }, [connect, load]);

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-occ-bg">
      {/* 战术网格：固定底衬，不随画布平移（occ-web 同一层） */}
      <div className="grid-bg" />
      {/* 画布层：100vw × 100vh */}
      <SceneRenderer />

      {/* 悬浮层：全部 fixed 定位，不占用画布空间 */}
      <FloatingHud />
      <FocusAnchor />

      {/*
        **悬着的输出自己弹出来**——挂在最外层，所以在哪个场景都会弹：一件等人拍板的事
        卡在那儿，整条链就停在它上面，跟用户当前在看哪个屏幕没有关系。
      */}
      <OutputOverlay outputs={outputs} />
    </div>
  );
}

export default App;
