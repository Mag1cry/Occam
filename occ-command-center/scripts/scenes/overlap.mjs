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
    return { total: rects.length, hits, covered };
  })()
`;

const report = async (page, name) => {
  const result = await page.eval(MEASURE);
  console.log(`[${name}] 节点 ${result.total} 个，重叠 ${result.hits.length} 对`);
  for (const [a, b, ox, oy] of result.hits) {
    console.log(`  ${a} × ${b} 重叠 ${ox}×${oy}px`);
  }
  for (const item of result.covered ?? []) {
    console.log(`  被悬浮层盖住：${item.id}（${item.covered}px²）`);
  }
};

export default async ({ page }) => {
  await page.sleep(900);
  await report(page, 'world');

  for (const [nodeId, name] of [
    ['schedule-006', 'schedule'],
    ['archive-entry', 'archive'],
    ['configuration-entry', 'configuration'],
  ]) {
    await page.dblclickSelector(`.react-flow__node[data-id="${nodeId}"]`);
    await page.sleep(1700);
    await report(page, name);
    await page.clickSelector('[aria-label="返回上一场景"]');
    await page.sleep(1700);
  }
};
