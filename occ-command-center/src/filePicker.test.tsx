/**
 * 「选择文件」：系统对话框 → 放进工作区 → **落点填回那一格**
 *
 * 浏览器里的系统对话框只给内容和名字、**不给路径**，而 `task_ref` 要的是相对工作区
 * 的路径——所以这一条链路是三步，缺一步那一格就填了个不存在的东西：
 *
 * ```text
 * 选（原生对话框） → 存（POST /api/workspace/files） → 填（后端答回来的 path）
 * ```
 *
 * 这里钉的是第三步用的是**后端说的落点**，不是本地那个文件名：重名时后端会加序号
 * （`a.md` → `a-2.md`），照着本地名字填回去，那一格就指向一份不存在的正文。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { FilePickerButton } from './components/ui/FilePickerButton';
import { ActionFormOverlay } from './components/overlay/ActionFormOverlay';
import { NewTaskOverlay } from './components/overlay/NewTaskOverlay';
import { buildMockSnapshot } from './mock/snapshot';

/** 桩打在 HTTP 一层：组件内部那条链在自己模块里调 `fetch`，模块边界的桩拦不住 */
function stubUpload(response: { ok?: boolean; body?: unknown } = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const ok = response.ok !== false;
    return {
      ok,
      status: ok ? 200 : 400,
      json: async () => response.body ?? { path: '周报.md' },
    };
  }));
  return calls;
}

/** 选一个文件（jsdom 里就是给那个隐藏的 input 塞 files） */
function pickFile(name: string, text: string) {
  const input = screen.getByLabelText('选择文件') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([text], name)] } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('选择文件', () => {
  it('选中的那份进工作区，落点交给调用方', async () => {
    const calls = stubUpload({ body: { path: '周报.md' } });
    const picked = vi.fn();
    render(<FilePickerButton onPicked={picked} />);

    await act(async () => {
      pickFile('周报.md', '# 这周的活');
    });

    expect(calls[0].url).toContain('/api/workspace/files');
    // 名字与正文原样递过去——命名规则（重名加序号）是后端的事
    expect(calls[0].body).toEqual({ name: '周报.md', text: '# 这周的活' });
    expect(picked).toHaveBeenCalledWith('周报.md');
  });

  it('填回去的是**后端说的落点**，不是本地那个文件名', async () => {
    // 重名时后端加了序号：照着本地名字填回去，那一格就指向一份不存在的正文
    stubUpload({ body: { path: 'a-2.md' } });
    const picked = vi.fn();
    render(<FilePickerButton onPicked={picked} />);

    await act(async () => {
      pickFile('a.md', 'x');
    });

    expect(picked).toHaveBeenCalledWith('a-2.md');
  });

  it('存不进去时原话说给表单，不自己编一句', async () => {
    stubUpload({ ok: false, body: { error: '这份正文太大了（1000001 字节，上限 1000000）' } });
    const failed = vi.fn();
    render(<FilePickerButton onPicked={vi.fn()} onError={failed} />);

    await act(async () => {
      pickFile('大文件.md', 'x');
    });

    expect(failed).toHaveBeenCalled();
    expect(String(failed.mock.calls[0][0])).toContain('上限');
  });

  it('没选文件（对话框被取消）时什么都不发生', async () => {
    const calls = stubUpload();
    const picked = vi.fn();
    render(<FilePickerButton onPicked={picked} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('选择文件'), { target: { files: [] } });
    });

    expect(calls).toHaveLength(0);
    expect(picked).not.toHaveBeenCalled();
  });
});

describe('两张表单上都有它', () => {
  it('新建任务那一格：手打的输入框和「选择文件」并排', () => {
    render(<NewTaskOverlay initialPosition={{ x: 0, y: 0 }}
                            snapshot={buildMockSnapshot()} onClose={() => {}} />);

    expect(screen.getByLabelText(/输入引用/)).toBeTruthy();
    expect(screen.getByLabelText('选择文件')).toBeTruthy();
  });

  it('通用表单：标了 workspaceFile 的字段才有那个按钮', () => {
    const { unmount } = render(
      <ActionFormOverlay
        title="新建日程" description="" command="manifest.create" submitLabel="创建"
        onClose={() => {}} onSubmit={vi.fn()}
        fields={[{ name: 'task_ref', label: '输入引用', workspaceFile: true }]}
      />
    );
    expect(screen.getByLabelText('选择文件')).toBeTruthy();
    unmount();

    // 没标的那一格旁边不该长按钮（那是"所有文本框都能选文件"的意思了）
    render(
      <ActionFormOverlay
        title="新建日程" description="" command="manifest.create" submitLabel="创建"
        onClose={() => {}} onSubmit={vi.fn()}
        fields={[{ name: 'cron', label: '规则（cron）' }]}
      />
    );
    expect(screen.queryByLabelText('选择文件')).toBeNull();
  });
});
