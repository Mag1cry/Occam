/**
 * SceneRenderer
 *
 * 只维护一个当前活动的空间画布实例：
 *
 *   SceneRenderer
 *   ├── Active Scene
 *   │   └── SpatialCanvas
 *   └── Transition Layer
 *       └── FlyingProxy
 *
 * 禁止在节点内部嵌套第二个 React Flow。ChildScene 不是节点内部的画布，
 * 而是由 SceneRenderer 切换到的下一个场景。
 *
 * SceneRenderer 只关心“当前是哪个 Scene”，不根据业务类型写死 if/else
 * 来决定是否可以进入——入口由投影器返回的 SceneEntry 提供。
 */

import { useSceneStore } from '../../store/sceneStore';
import { WorldScene } from '../../scenes/WorldScene/WorldScene';
import { TaskScene } from '../../scenes/TaskScene/TaskScene';
import { ScheduleScene } from '../../scenes/ScheduleScene/ScheduleScene';
import { ArchiveScene } from '../../scenes/ArchiveScene/ArchiveScene';
import { ConfigurationScene } from '../../scenes/ConfigurationScene/ConfigurationScene';
import { SceneStateLayer } from '../../components/overlay/SceneStateLayer';
import { useGatewayStore } from '../../store/gatewayStore';
import { TransitionLayer } from './TransitionLayer';

export function SceneRenderer() {
  const stack = useSceneStore((state) => state.stack);
  const currentScene = useSceneStore((state) => state.currentScene);
  const snapshot = useGatewayStore((state) => state.snapshot);
  const status = useGatewayStore((state) => state.status);
  const error = useGatewayStore((state) => state.error);
  const load = useGatewayStore((state) => state.load);

  const frame = stack[stack.length - 1];
  const focusId = frame?.focusId ?? '';

  return (
    <>
      <div className="absolute inset-0">
        {/*
          快照是唯一的运行时数据源：没有它就不渲染场景。
          场景本身因此可以假定快照存在，不必各自写 mock 兜底——
          「后端不可达」由这一层如实说明，不由原型数据顶上。
        */}
        {!snapshot ? (
          <SceneStateLayer status={status} error={error} onRetry={() => void load()} />
        ) : (
          <>
            {currentScene === 'world' && <WorldScene snapshot={snapshot} />}
            {currentScene === 'task' && <TaskScene taskId={focusId} snapshot={snapshot} />}
            {currentScene === 'schedule' && (
              <ScheduleScene scheduleId={focusId} snapshot={snapshot} />
            )}
            {currentScene === 'archive' && <ArchiveScene snapshot={snapshot} />}
            {currentScene === 'configuration' && (
              <ConfigurationScene configurationId={focusId} snapshot={snapshot} />
            )}
          </>
        )}
      </div>

      {/* Transition Layer 与 Active Scene 解耦 */}
      <TransitionLayer />
    </>
  );
}
