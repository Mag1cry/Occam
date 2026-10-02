/**
 * App 冒烟测试
 *
 * 验证完整应用可以挂载并渲染出关键界面元素，
 * 且 HUD 在没有任何选中节点时仍能表达注意力。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import App from './App';
import { getGatewaySnapshot } from './api/gateway';
import { buildMockSnapshot } from './mock/snapshot';
import { useGatewayStore } from './store/gatewayStore';

describe('App', () => {
  // store 是模块级单例：上一个用例读到的快照会留到下一个用例。
  // 「首屏拿不到快照」这个前提必须由用例自己建立，不能靠前一个用例的状态。
  beforeEach(() => {
    useGatewayStore.setState({ snapshot: null, status: 'loading', error: null });
  });

  // 每个用例结束后把快照读取恢复到「成功」的默认行为：
  // 用例里用 mockRejectedValueOnce 模拟后端不可达，队列不能漏到下一个用例
  afterEach(() => {
    const mocked = vi.mocked(getGatewaySnapshot);
    mocked.mockReset();
    mocked.mockResolvedValue(buildMockSnapshot());
  });

  it('挂载后渲染画布与悬浮 HUD', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      render(<App />);
    });

    // 悬浮 HUD：不选中任何节点时也能判断系统有没有待拍板事项
    // （HUD 的统计文字与节点上的注意力徽标是同一个词，用 getAllByText 区分）
    expect(screen.getByText('实时')).toBeTruthy();
    expect(screen.getAllByText('待拍板').length).toBeGreaterThan(0);
    expect(screen.getAllByText('亮灯').length).toBeGreaterThan(0);

    // 画布已挂载
    const canvas = document.querySelector('.react-flow');
    expect(canvas).toBeTruthy();

    errorSpy.mockRestore();
  });

  it('后端不可达时如实显示状态层，不渲染任何节点', async () => {
    vi.mocked(getGatewaySnapshot).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:8000')
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      render(<App />);
    });

    expect(screen.getByText('后端不可达')).toBeTruthy();
    expect(screen.getByText('connect ECONNREFUSED 127.0.0.1:8000')).toBeTruthy();
    // 没有 Core 事实就没有节点——原型数据不得顶上
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(0);

    errorSpy.mockRestore();
  });

  it('World 层渲染四类节点，且只渲染四类', async () => {
    await act(async () => {
      render(<App />);
    });

    const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
    const nodeIds = nodes.map((el) => el.getAttribute('data-id'));

    // 四类节点各自出现
    expect(nodeIds).toContain('task-002'); // 等待拍板
    expect(nodeIds).toContain('schedule-001');
    expect(nodeIds).toContain('archive-entry'); // 档案馆入口
    expect(nodeIds).toContain('configuration-entry'); // 配置舱入口

    // 资料节点不得到达外层
    expect(nodeIds).not.toContain('archive-001');
    expect(nodeIds).not.toContain('config-001');
    expect(nodeIds).not.toContain('ext-001');
    expect(nodeIds).not.toContain('cap-001');

    // 外层只挂载四类节点类型
    const types = Array.from(
      new Set(
        nodes.map(
          (el) =>
            Array.from(el.classList)
              .find((c) => c.startsWith('react-flow__node-'))
              ?.replace('react-flow__node-', '') ?? ''
        )
      )
    ).sort();

    expect(types).toEqual(['archive', 'configuration', 'schedule', 'task']);
  });

  // 外层没有连线由 projection.test.ts 在投影层断言。
  // 不要在 DOM 上查 .react-flow__edge：jsdom 里 React Flow 不渲染边，
  // 那样的断言无论有没有连线都会通过。
});
