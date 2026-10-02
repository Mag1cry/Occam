/**
 * SceneStack 测试
 *
 * 对应验收条目：进入和返回只是 UI Scene State 改变，
 * 且返回后不丢失外层状态（viewport、selection）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useSceneStore } from './sceneStore';
import { useTransitionStore } from './transitionStore';

const initialStack = () => [
  {
    sceneId: 'world' as const,
    focusId: '',
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    selection: { selectedNodeId: null },
  },
];

describe('SceneStack', () => {
  beforeEach(() => {
    useSceneStore.setState({
      stack: initialStack(),
      currentScene: 'world',
      isTransitioning: false,
    });
  });

  it('初始位于 World', () => {
    const state = useSceneStore.getState();
    expect(state.currentScene).toBe('world');
    expect(state.stack).toHaveLength(1);
  });

  it('push 进入子场景并保留外层帧', () => {
    const { push } = useSceneStore.getState();
    push('task', 'task-002', {
      viewport: { zoom: 1.4, pan: { x: -120, y: 40 } },
      selection: { selectedNodeId: 'task-002' },
    });

    const state = useSceneStore.getState();
    expect(state.currentScene).toBe('task');
    expect(state.stack).toHaveLength(2);
    expect(state.stack[1].focusId).toBe('task-002');
    expect(state.stack[1].viewport.zoom).toBe(1.4);
  });

  it('pop 返回并恢复外层快照', () => {
    const { push, pop } = useSceneStore.getState();

    // 进入前的外层状态
    useSceneStore.setState({
      stack: [
        {
          sceneId: 'world',
          focusId: '',
          viewport: { zoom: 0.8, pan: { x: 50, y: -30 } },
          selection: { selectedNodeId: 'task-001' },
        },
      ],
    });

    push('task', 'task-002', {
      viewport: { zoom: 1.2, pan: { x: 0, y: 0 } },
      selection: { selectedNodeId: 'task-002' },
    });

    const restored = pop();
    expect(restored?.sceneId).toBe('world');
    expect(restored?.viewport.zoom).toBe(0.8);
    expect(restored?.selection.selectedNodeId).toBe('task-001');

    const state = useSceneStore.getState();
    expect(state.currentScene).toBe('world');
    expect(state.stack).toHaveLength(1);
  });

  it('多层进入：World → Task → Configuration 逐层返回', () => {
    const { push, pop } = useSceneStore.getState();

    push('task', 'task-001', {
      viewport: { zoom: 1, pan: { x: 0, y: 0 } },
      selection: { selectedNodeId: 'task-001' },
    });
    push('configuration', 'config-001', {
      viewport: { zoom: 1, pan: { x: 0, y: 0 } },
      selection: { selectedNodeId: 'config-001' },
    });

    expect(useSceneStore.getState().stack).toHaveLength(3);

    pop();
    expect(useSceneStore.getState().currentScene).toBe('task');
    pop();
    expect(useSceneStore.getState().currentScene).toBe('world');
  });

  it('World 层再 pop 不改变状态', () => {
    const { pop } = useSceneStore.getState();
    expect(pop()).toBeNull();
    expect(useSceneStore.getState().currentScene).toBe('world');
    expect(useSceneStore.getState().stack).toHaveLength(1);
  });
});

describe('TransitionStore', () => {
  beforeEach(() => {
    useTransitionStore.setState({
      proxy: null,
      flying: false,
      pending: null,
      pendingPop: false,
    });
  });

  it('进入动画登记 pending，飞行结束由编排层提交', () => {
    const store = useTransitionStore.getState();

    store.beginEnter({
      targetScene: 'task',
      focusId: 'task-001',
      sourceRect: { x: 100, y: 100, width: 200, height: 96 },
      targetRect: { x: 20, y: 20, width: 208, height: 56 },
      label: '分析用户反馈数据',
      color: '#6366f1',
      sourceNodeId: 'task-001',
    });

    let state = useTransitionStore.getState();
    expect(state.flying).toBe(true);
    expect(state.pending?.targetScene).toBe('task');

    // 取走 pending 后不重复提交
    const consumed = state.consumePending();
    expect(consumed?.focusId).toBe('task-001');
    expect(useTransitionStore.getState().consumePending()).toBeNull();

    state = useTransitionStore.getState();
    state.endFlight();
    expect(useTransitionStore.getState().flying).toBe(false);
    expect(useTransitionStore.getState().proxy).toBeNull();
  });

  it('返回动画登记 pendingPop', () => {
    const store = useTransitionStore.getState();
    store.beginExit({
      sourceRect: { x: 20, y: 20, width: 208, height: 56 },
      targetRect: { x: 300, y: 200, width: 200, height: 96 },
      label: 'task-001',
      color: '#3b82f6',
    });

    const state = useTransitionStore.getState();
    expect(state.flying).toBe(true);
    expect(state.pendingPop).toBe(true);
    expect(state.consumePendingPop()).toBe(true);
    expect(useTransitionStore.getState().consumePendingPop()).toBe(false);
  });
});
