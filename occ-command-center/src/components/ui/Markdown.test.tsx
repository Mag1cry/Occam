/**
 * Markdown 渲染器
 *
 * 它渲染的是**模型输出**，所以两件事都要钉住：
 * ① 结构真的画出来了（星号不该原样印在屏幕上）；
 * ② **HTML 不被执行**——那是"内容不可信"这条边界在界面上的落点。
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('粗体与列表真的画出来了，不是原样印星号和横杠', () => {
    render(<Markdown content={'**天气**：阴\n\n- 气温 21℃\n- 湿度 84%'} />);

    expect(screen.getByText('天气').tagName).toBe('STRONG');
    expect(document.querySelectorAll('li')).toHaveLength(2);
    // 渲染之后屏幕上不该再有 Markdown 的记号
    expect(document.body.textContent).not.toContain('**');
  });

  it('GFM 表格画成真的表格', () => {
    render(<Markdown content={'| 城市 | 温度 |\n| --- | --- |\n| 杭州 | 21 |'} />);

    expect(document.querySelectorAll('th')).toHaveLength(2);
    expect(document.querySelectorAll('td')).toHaveLength(2);
  });

  it('不渲染 HTML：模型输出里夹的标签只是字面量', () => {
    /*
      这是**安全默认**，不是渲染偏好。结果面板与审批申请里装的都是模型输出，
      也就是外部内容。开 `rehype-raw` 等于把模型输出当代码执行——
      而这条路上没有任何东西替你把关。
    */
    render(<Markdown content={'<img src=x onerror="boom()">'} />);

    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('<img');
  });

  it('链接跳到站外，带 noopener', () => {
    render(<Markdown content={'[文档](https://example.com/x)'} />);

    const link = screen.getByText('文档');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });
});
