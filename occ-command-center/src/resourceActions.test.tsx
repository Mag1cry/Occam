/**
 * 通用参数表单（`ActionFormOverlay`）
 *
 * 它只做三件事：收参数、按必填拦住提交、把**原样**的值交出去；提交结果按真实
 * 回执显示。它不认识任何一个命令——今天用它的是日程的创建与编辑。
 *
 * 下面拿"填一份表单"当例子：字段是随手挑的，重点在组件的行为（必填拦不拦、
 * 默认值从哪来、值是不是原样交出去、失败关不关）。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ActionFormOverlay } from './components/overlay/ActionFormOverlay';

describe('通用参数表单', () => {
  it('必填项没填时不能提交', () => {
    render(
      <ActionFormOverlay
        title="新建日程"
        description="规则是 5 段 cron"
        command="manifest.create"
        submitLabel="创建"
        fields={[
          { name: 'schedule_id', label: '日程 ID', required: true },
          { name: 'cron', label: '规则（cron）', required: true },
        ]}
        onSubmit={vi.fn()}
        onClose={() => {}}
      />
    );

    expect(screen.getByText('创建', { selector: 'button' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/日程 ID/), { target: { value: 'daily-report' } });
    expect(screen.getByText('创建', { selector: 'button' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/规则（cron）/), { target: { value: '0 9 * * *' } });
    expect(screen.getByText('创建', { selector: 'button' })).toHaveProperty('disabled', false);
  });

  it('提交的是原样的字段值，命令名显示给用户看', async () => {
    const onSubmit = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <ActionFormOverlay
        title="再填一份"
        description="这条用例关心的是值有没有原样交出去"
        command="manifest.create"
        submitLabel="保存"
        fields={[{ name: 'port', label: '端口', type: 'number', defaultValue: '72', required: true }]}
        onSubmit={onSubmit}
        onClose={onClose}
      />
    );

    // 预填值来自字段声明，不是前端猜的默认值
    expect((screen.getByLabelText(/端口/) as HTMLInputElement).value).toBe('72');
    expect(screen.getByText('manifest.create')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText('保存', { selector: 'button' }));
    });

    expect(onSubmit).toHaveBeenCalledWith({ port: '72' });
    expect(onClose).toHaveBeenCalled();
  });

  it('提交失败时显示后端给的原因，且不关闭表单', async () => {
    const onClose = vi.fn();
    render(
      <ActionFormOverlay
        title="再填一份"
        description="这条用例关心的是值有没有原样交出去"
        command="manifest.create"
        submitLabel="保存"
        fields={[{ name: 'port', label: '端口', defaultValue: '9999', required: true }]}
        onSubmit={async () => {
          throw new Error('端口超出范围: 9999');
        }}
        onClose={onClose}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByText('保存', { selector: 'button' }));
    });

    expect(screen.getByText(/提交失败：端口超出范围: 9999/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
