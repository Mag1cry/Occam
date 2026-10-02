/**
 * Mock 数据统一导出
 *
 * 这些是**夹具**，不是运行时数据源：真实运行时只认后端网关快照。
 * 它们服务三条用途——投影契约测试、`VITE_DATA_SOURCE=mock` 的离线开发、
 * 以及测试里 stub `fetch` 返回的快照。
 */

export { buildMockSnapshot } from './snapshot';
export { mockTasks } from './tasks';
export { mockScheduleSeeds } from './schedules';
export { mockArchiveMetadata } from './archives';
export {
  mockExecutorConfigurations,
  mockExtensions,
  mockCapabilities,
  mockExtensionCapabilities,
} from './configurations';
export { allCoreTasks, findCoreTask } from './coreTasks';
export { getCoreEventsForTask, mockCoreEvents } from './events';
export {
  mockScheduleEntries,
  mockOccurrences,
  mockScheduleChildTasks,
  mockTaskDefinitions,
  DAILY_RUN_COUNT,
} from './scheduleChildren';

export type { ArchiveMetadata } from './archives';
export type { ScheduleEntry, TaskDefinition } from './scheduleChildren';
export type { ScheduleSeed } from './schedules';
