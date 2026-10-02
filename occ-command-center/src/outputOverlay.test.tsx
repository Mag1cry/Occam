/**
 * 悬着的输出自己弹出来（`OutputOverlay`）
 *
 * 这是**前端那条输出路径**的送达方式：后端把悬着的东西放进快照（投影、无状态），
 * 这里看见**没弹过的**那一条就弹一个浮窗。钉三件事：
 *
 * - 弹出来的是那条输出的**原文**（标题、摘要、动作都由后端给，前端不编）；
 * - 点下去走的是**命令面那一条**（`approve` / `deny`），证据那一格归接入面填；
 * - **弹过的不会弹第二遍**——否则一次刷新弹三遍，而这正是"最近几条里我不想再看它"的来源。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { OutputOverlay } from './components/overlay/OutputOverlay';
import { sendGatewayCommand, type LiveOutput } from './api/gateway';

const OUTPUT: LiveOutput = {
  ref: 'task:task-002:approval',
  kind: 'approval',
  target_ref: 'task:task-002',
  title: '部署生产环境',
  summary: '要调用 `deploy.production`（approval:deploy.production）',
  actions: [
    { ref: 'approve', label: '批准', command: 'approve' },
    { ref: 'deny', label: '拒绝', command: 'deny' },
  ],
};

afterEach(() => {
  vi.mocked(sendGatewayCommand).mockClear();
});

describe('悬着的输出', () => {
  it('弹出来的是后端给的那份原文', () => {
    render(<OutputOverlay outputs={[OUTPUT]} />);

    expect(screen.getByText('有一件要你拍板')).toBeTruthy();
    // 标题是"它属于谁"，摘要是"要你干什么"——都来自快照，前端不拼
    expect(screen.getByText('部署生产环境')).toBeTruthy();
    // 摘要是 Markdown：`` `deploy.production` `` 渲染成 code（正文那一句也含这个词，
    // 所以这里指名要那个 code，不拿一句"找得到就行"凑数）
    expect(screen.getByText('deploy.production', { selector: 'code' })).toBeTruthy();
    expect(screen.getByText('批准', { selector: 'button' })).toBeTruthy();
    expect(screen.getByText('拒绝', { selector: 'button' })).toBeTruthy();
  });

  it('没有悬着的就不弹', () => {
    render(<OutputOverlay outputs={[]} />);

    expect(screen.queryByText('有一件要你拍板')).toBeNull();
  });

  it('点下去走的是命令面那一条，带上 task id', async () => {
    render(<OutputOverlay outputs={[OUTPUT]} />);

    await act(async () => {
      fireEvent.click(screen.getByText('拒绝', { selector: 'button' }));
    });

    // `task:<id>` 是引用，命令要的是 id——换算就在浮窗这一处
    expect(vi.mocked(sendGatewayCommand).mock.calls.at(-1)?.[0]).toBe('deny');
    expect(vi.mocked(sendGatewayCommand).mock.calls.at(-1)?.[1]).toBe('task-002');
  });

  it('弹过的不会再弹（刷新一次弹三遍就是在这儿挡住的）', () => {
    const { rerender } = render(<OutputOverlay outputs={[OUTPUT]} />);
    expect(screen.getByText('有一件要你拍板')).toBeTruthy();

    // 关掉它，然后快照又重读了一次（同一条还悬着）
    fireEvent.click(screen.getByLabelText('关闭'));
    rerender(<OutputOverlay outputs={[{ ...OUTPUT }]} />);

    expect(screen.queryByText('有一件要你拍板')).toBeNull();
  });

  it('两条都在时，关掉一条接着弹另一条', () => {
    const second: LiveOutput = {
      ...OUTPUT, ref: 'task:task-007:approval', target_ref: 'task:task-007', title: '发邮件',
    };
    render(<OutputOverlay outputs={[OUTPUT, second]} />);

    fireEvent.click(screen.getByLabelText('关闭'));

    // 一条一条来：同时弹两个等于把"先看哪个"替用户决定了两遍
    expect(screen.getByText('发邮件')).toBeTruthy();
  });
});
