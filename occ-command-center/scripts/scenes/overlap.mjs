/**
 * 找画布上互相重叠的节点（World + 三个子图）
 *
 * 默认取景下节点叠在一起就是「标签看不清」，但靠眼睛看容易漏。
 * 这里直接量矩形，两两求交。
 *
 * 悬浮层的取法：**所有 fixed 面板**，不是按 class 点名。
 * 点名法漏过一次——配置舱的引用列表用的是 `.glass`，不在
 * `.glass-strong` 白名单里，于是「面板压住 cap-001」量了几个月都没报出来。
 * 全屏信息面（Task 场景）按尺寸排除，它不是面板。
 */
import { 找节点, 等应用, 进场景 } from './enterScene.mjs';

const MEASURE = `
  (() => {
    const rects = [...document.querySelectorAll('.react-flow__node')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute('data-id'), x: r.x, y: r.y, w: r.width, h: r.height };
    });

    // 悬浮层盖住节点：overlay 是 fixed，在屏幕坐标里比对
    const overlays = [...document.querySelectorAll('.fixed')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 80 && r.height > 40)
      // 铺满全屏的不是面板（Task 场景的信息面），它不遮画布
      .filter((r) => !(r.width > window.innerWidth * 0.7 && r.height > window.innerHeight * 0.7));
    const covered = rects
      .map((node) => {
        const worst = overlays.reduce((acc, o) => {
          const ox = Math.min(node.x + node.w, o.right) - Math.max(node.x, o.left);
          const oy = Math.min(node.y + node.h, o.bottom) - Math.max(node.y, o.top);
          return ox > 1 && oy > 1 ? Math.max(acc, ox * oy) : acc;
        }, 0);
        return { id: node.id, covered: Math.round(worst) };
      })
      .filter((x) => x.covered > 0);
    const hits = [];
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 1 && oy > 1) hits.push([a.id, b.id, Math.round(ox), Math.round(oy)]);
      }
    }

    /*
      **浮层互相遮挡。** 上面那两条只量"浮层盖住节点"，量不到浮层压浮层——
      而 2026-10-06 报出来的三个真问题里，有两个正是浮层压浮层：
      概览栈被子 Task 分区盖住 144px，HUD 压住左上角锚点 104px。

      pointer-events:none 的那层不算：它只是定位用的容器（HUD 和操作牌
      外面那根撑满全宽的带子），真正看得见的是它里面的胶囊。所以遇到这种
      就往下钻到第一个能接收指针的后代——不钻的话，那根带子会被当成一块
      横贯屏幕的面板，和所有贴顶的东西都"重叠"。
    */
    const 实面板 = (el) => {
      let node = el;
      while (getComputedStyle(node).pointerEvents === 'none' && node.firstElementChild) {
        node = node.firstElementChild;
      }
      return node;
    };
    const panels = [...document.querySelectorAll('.fixed')]
      .map((el) => ({ el: 实面板(el) }))
      .map(({ el }) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 80 && r.height > 24)
      .filter(({ r }) => !(r.width > innerWidth * 0.7 && r.height > innerHeight * 0.7));

    const 重叠 = [];
    for (let i = 0; i < panels.length; i += 1) {
      for (let j = i + 1; j < panels.length; j += 1) {
        const a = panels[i];
        const b = panels[j];
        // 一个是另一个的祖先就跳过：祖先的矩形当然框得住后代
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ox > 1 && oy > 1) {
          const 名 = (x) => (x.el.textContent || '').trim().slice(0, 14) || x.el.className.slice(0, 14);
          // 这段是外面那个模板字符串的内容，**只能用拼接**：这里再写反引号会把外层截断
          重叠.push(名(a) + ' × ' + 名(b) + ' 重叠 ' + Math.round(ox) + '×' + Math.round(oy) + 'px');
        }
      }
    }

    return { total: rects.length, hits, covered, 面板数: panels.length, 重叠 };
  })()
`;

const report = async (page, name) => {
  const result = await page.eval(MEASURE);

  /*
    **先证明页面真的渲染了。** 这一条踩过：dev server 停着的时候，量到的是空白页——
    0 块浮层、0 处遮挡，于是脚本高高兴兴报"全过"。**没有东西可重叠，不等于没有重叠。**
    HUD 是每个场景都在的，拿它当"页面活着"的证据。
  */
  if (!result.面板数) {
    throw new Error(`${name}：一块浮层都没量到——页面多半没渲染出来（dev server 起了吗？）`);
  }

  console.log(`[${name}] 节点 ${result.total} 个，重叠 ${result.hits.length} 对`);
  for (const [a, b, ox, oy] of result.hits) {
    console.log(`  ${a} × ${b} 重叠 ${ox}×${oy}px`);
  }
  for (const item of result.covered ?? []) {
    console.log(`  被悬浮层盖住：${item.id}（${item.covered}px²）`);
  }

  console.log(`  浮层 ${result.面板数} 块，互相遮挡 ${result.重叠.length} 对`);
  for (const line of result.重叠) {
    console.log(`    ${line}`);
  }
  /*
    **浮层互相遮挡会抛，节点重叠只报告。**
    节点叠在一起有时候是能接受的（取景、LOD），要人判断；而两块浮层叠在一起
    没有"可以接受"这一说——被盖住的那半句信息就是读不到。这是 `hud.mjs`
    同一个立场。
  */
  if (result.重叠.length) {
    throw new Error(`${name}：浮层互相遮挡 —— ${result.重叠.join('；')}`);
  }
};

export default async ({ page }) => {
  await 等应用(page);
  await page.sleep(600);
  await report(page, 'world');

  /*
    **日程的 id 是它的名字**（`weather.daily`），不是夹具里的 `schedule-006`——
    照夹具写死的话，连上真实后端一个都找不到。按类型找。
  */
  const 日程 = await 找节点(page, 'schedule');
  const 场景 = [
    ...(日程 ? [[日程, 'schedule', '进入编排台']] : []),
    ['archive-entry', 'archive', '进入档案馆'],
    ['configuration-entry', 'configuration', '进入配置舱'],
  ];

  for (const [nodeId, name, 按钮] of 场景) {
    await 进场景(page, nodeId, 按钮);
    await report(page, name);
    await page.clickSelector('[aria-label="返回上一场景"]');
    await page.sleep(1700);
  }
};
