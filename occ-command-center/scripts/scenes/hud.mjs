/**
 * 量 HUD 胶囊在窄视口下有没有折行、溢出
 *
 * 这一类问题**只有真浏览器量得出来**：jsdom 不做布局，`npm test` 一条都抓不到。
 * 起因是 2026-10-06 在手机上（800×360）截图看到 HUD 里的文字竖着折行、溢出胶囊。
 *
 * 根因记在这里，免得改回去：胶囊当时用 `fixed left-1/2 -translate-x-1/2` 居中。
 * 绝对定位元素在 left 有值、right 为 auto、width 为 auto 时按 shrink-to-fit 算，
 * 而可用宽度 = 包含块 − left = **视口的一半**。所以它最多只有半屏宽（真机实测：
 * 800 宽的视口上限正好 400px，而断开时内容要 494px）——桌面窗口宽时看不出来。
 *
 * 跑法（**一次一个尺寸**，`--size` 是启动参数）：
 *   node scripts/shot.mjs --script scripts/scenes/hud.mjs --size 800x360  --out .shots/hud-phone.png
 *   node scripts/shot.mjs --script scripts/scenes/hud.mjs --size 400x720  --out .shots/hud-portrait.png
 *   node scripts/shot.mjs --script scripts/scenes/hud.mjs --size 1600x1000 --out .shots/hud-desktop.png
 *
 * 和 `overlap.mjs` 不一样，这个脚本**会抛**：重叠有时候是能接受的、要人判断，
 * 而文字折行溢出胶囊没有"可以接受"这一说。
 */

/**
 * 胶囊要认准。**不能用 `.topline` 选**——那是 `index.css:254` 的全局类，
 * 配置舱和编排台的分区标题也在用，`querySelector` 会选到它们（踩过）。
 * 折叠按钮的 `aria-label` 才是 HUD 独有的。
 */
const PILL = 'button[aria-label="折叠 HUD"], button[aria-label="展开 HUD"]';

const MEASURE = `
  (() => {
    const toggle = document.querySelector('${PILL}');
    const pill = toggle && toggle.parentElement;
    if (!pill) return { error: '找不到 HUD 胶囊' };

    const 量 = () => {
      // 折行 = 某一行文字的实际高度超过了它自己的行高
      const wrapped = [...pill.querySelectorAll('span')]
        .filter((el) => el.children.length === 0 && el.textContent.trim())
        .filter((el) => {
          const lh = parseFloat(getComputedStyle(el).lineHeight);
          return lh && el.getBoundingClientRect().height > lh * 1.5;
        })
        .map((el) => el.textContent.trim().slice(0, 24));
      const r = pill.getBoundingClientRect();
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        折行: wrapped,
        溢出: pill.scrollWidth - pill.clientWidth,
        // **溢出屏幕**才是 left-1/2 那个上限真正会造成的后果：
        // 盒子只有半屏宽，内容又是 nowrap（min-content = 整条文案），
        // 于是它撑出盒子、从屏幕边上漏出去。
        出屏: Math.round(Math.max(0, -r.left) + Math.max(0, r.right - innerWidth)),
      };
    };

    const 实时 = 量();

    // 断开时那句长文案才是最容易撑爆的。React 每秒重渲染（时钟），
    // 所以**塞进去、量完、立刻还原**，全程同步。
    const conn = [...pill.querySelectorAll('span')]
      .find((el) => el.children.length === 0 && el.textContent.trim() === '实时');
    let 断开 = null;
    if (conn) {
      const saved = conn.textContent;
      conn.textContent = '已断开 · 数据截至 15:04';
      断开 = { ...量(), 被截断: conn.scrollWidth > conn.clientWidth };
      conn.textContent = saved;
    }

    return {
      视口: innerWidth + 'x' + innerHeight,
      可用宽: innerWidth - 24,
      实时,
      断开,
      // 辉光画在元素框外（.topline::after，bottom:-1px），一有 overflow 就被裁掉
      辉光: getComputedStyle(pill).overflowX === 'visible' ? '在' : '被裁了',
    };
  })()
`;

const 检查 = (name, m, { 允许截断 }) => {
  const 问题 = [];
  if (m.折行.length) 问题.push(`折行：${m.折行.join(' / ')}`);
  if (m.溢出 > 0) 问题.push(`溢出 ${m.溢出}px`);
  if (m.出屏 > 0) 问题.push(`从屏幕边缘漏出去 ${m.出屏}px`);
  if (m.h !== 42) 问题.push(`高度 ${m.h}（应为 42）`);
  if (!允许截断 && m.被截断) 问题.push('连接文案被截断');

  const 前缀 = 问题.length ? '✗' : '✓';
  console.log(`  ${前缀} ${name}：宽 ${m.w} 高 ${m.h}${m.被截断 ? '（截断）' : ''}`);
  for (const p of 问题) console.log(`      ${p}`);
  return 问题;
};

import { 等应用, 进场景 } from './enterScene.mjs';

export default async ({ page }) => {
  await 等应用(page);

  // 进配置舱：焦点标签会挂上 HUD，那是最占地方的一条
  await 进场景(page, 'configuration-entry', '进入配置舱');

  const r = await page.eval(MEASURE);
  if (r.error) throw new Error(r.error);

  console.log(`[hud] 视口 ${r.视口}（可用 ${r.可用宽}px，旧的 left-1/2 上限只有 ${Math.round(Number(r.视口.split('x')[0]) / 2)}px）`);
  console.log(`[hud] 辉光分割线：${r.辉光}`);

  // 窄到放不下时，连接文案截断是**设计好的降级**（`max-sm:`），不算失败
  const 允许截断 = r.可用宽 < 500;
  const 问题 = [
    ...检查('实时', r.实时, { 允许截断: false }),
    ...(r.断开 ? 检查('断开', r.断开, { 允许截断 }) : []),
  ];

  if (r.辉光 !== '在') 问题.push('辉光被 overflow 裁掉了');
  if (问题.length) throw new Error(`HUD 在这档宽度下不成立：${问题.join('；')}`);
};
