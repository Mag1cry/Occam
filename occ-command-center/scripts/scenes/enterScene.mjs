/**
 * 场景脚本共用的两件事：等节点出现、进场景
 *
 * `hud.mjs` 和 `overlap.mjs` 都要，所以放在这里而不是各抄一份。
 */

/**
 * 等应用真的渲染出来
 *
 * **写死 sleep 会脆**：dev server 刚起来时 Vite 在预打包，首屏要好几秒。
 * 等不及的话量到的是一张空白页——而"没有东西可重叠"会被报告成"零重叠"，
 * 那是假通过（踩过）。
 *
 * HUD 是**每个场景都在**的那一块，拿它当"页面活着"的证据。
 */
export const 等应用 = async (page, 上限 = 20000) => {
  const 截止 = Date.now() + 上限;
  while (Date.now() < 截止) {
    const 好了 = await page.eval(`
      !!(document.querySelector('[aria-label="折叠 HUD"]')
        || document.querySelector('[aria-label="展开 HUD"]'))
    `);
    if (好了) return;
    await page.sleep(250);
  }
  throw new Error(`等了 ${上限}ms 应用也没渲染出来——dev server 起来了吗？`);
};

/** 等一个节点出现再点。**写死 sleep 会脆**——改一次代码触发 HMR 就点空了。 */
export const 等节点 = async (page, id, 上限 = 8000) => {
  const selector = `.react-flow__node[data-id="${id}"]`;
  const 截止 = Date.now() + 上限;
  while (Date.now() < 截止) {
    if (await page.eval(`!!document.querySelector('${selector}')`)) return selector;
    await page.sleep(200);
  }
  throw new Error(`等了 ${上限}ms 也没等到节点 ${id}`);
};

/**
 * 双击节点进场景
 *
 * **第二次点击常被刚弹出的操作牌吃掉**（只选中、没进去）。后果不只是"没进"：
 * 场景不进，焦点标签就不挂上 HUD，量到的宽度比真实情况窄 58px——等于白测。
 * 所以留一条按钮兜底。
 */
export const 进场景 = async (page, id, 按钮) => {
  const selector = await 等节点(page, id);

  /*
    **点它的"可见那一截"，不是它的几何中心。**

    直接用 `dblclickSelector` 会算出节点矩形的中心——而节点**部分落在屏幕外**时
    那个中心是负坐标，点了等于没点。而那时报出来的是一句和真实原因无关的话
    （"既没进场景，也找不到按钮"）。

    为什么会落在屏幕外：`fitViewOptions.minZoom` 是 0.5，节点一多 fitView 就不肯
    再缩小了（`SpatialCanvas`），所以世界在被绑到 0.5 之后仍然比视口大。
    那是**取景**的问题（DESIGN.md 第 13 条记过），不该让脚本罢工——
    露出来的那一截照样点得着。
  */
  const 取目标 = () => page.eval(`
    (() => {
      const r = document.querySelector('${selector}').getBoundingClientRect();
      const 左 = Math.max(r.left, 0), 上 = Math.max(r.top, 0);
      const 右 = Math.min(r.right, innerWidth), 下 = Math.min(r.bottom, innerHeight);
      if (右 - 左 < 2 || 下 - 上 < 2) return null;      // 一截都不露
      return { x: Math.round((左 + 右) / 2), y: Math.round((上 + 下) / 2) };
    })()
  `);

  let 目标 = await 取目标();
  if (!目标) {
    // 整块在屏幕外：**把画布拖过来**（React Flow 的 `panOnDrag` 就是按位移平移）。
    // 拖到哪儿由"节点相对视口的偏移"算出来，再留一点边距。
    const 挪 = await page.eval(`
      (() => {
        const r = document.querySelector('${selector}').getBoundingClientRect();
        const 到中间 = { x: innerWidth / 2 - (r.left + r.right) / 2,
                         y: innerHeight / 2 - (r.top + r.bottom) / 2 };
        // 起手点得落在空画布上，不然那一下是点在某个节点上（那就是拖节点不是拖画布）
        return { 到中间, 起手: { x: Math.round(innerWidth - 20), y: Math.round(innerHeight / 2) } };
      })()
    `);
    await page.drag(挪.起手.x, 挪.起手.y,
                    挪.起手.x + 挪.到中间.x, 挪.起手.y + 挪.到中间.y);
    await page.sleep(500);
    目标 = await 取目标();
  }
  if (!目标) {
    throw new Error(`节点 ${id} 拖过来也不在视口里，点不着`);
  }
  await page.dblclick(目标.x, 目标.y);
  await page.sleep(1200);
  if (await page.eval(`!!document.querySelector('[data-scene-overlay-stack]')`)) return;

  const pt = await page.eval(`
    (() => {
      const btn = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').includes(${JSON.stringify(按钮)}));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()
  `);
  if (!pt) throw new Error('既没进场景，也找不到按钮：' + 按钮);
  await page.click(pt.x, pt.y);
  await page.sleep(1200);
};

/**
 * 按 React Flow 的类型类找一个节点的 `data-id`
 *
 * **不能写死 id。** 日程节点的 `data-id` 就是它的名字（`weather.daily`），
 * 而夹具里叫 `schedule-006`——写死的话，连上真实后端就一个都找不到。
 * React Flow 会按 `nodeTypes` 的键加 `react-flow__node-<type>` 类。
 *
 * **优先挑一个完整落在视口里的。** 这条踩过：数据一多，画布就没被 fit 满
 * （节点铺得比视口大），而 `querySelector` 拿到的第一个可能大半在屏幕外——
 * 双击的坐标算出来是负数，于是"点了没反应"，报出来的却是"既没进场景，
 * 也找不到按钮"，把一个很具体的原因说成了一句查不出头绪的话。
 */
export const 找节点 = (page, type) =>
  page.eval(`
    (() => {
      const nodes = [...document.querySelectorAll('.react-flow__node-${type}')];
      if (!nodes.length) return null;
      const 在视口里 = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0
          && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      };
      const 挑中 = nodes.find(在视口里) ?? nodes[0];
      return 挑中.getAttribute('data-id');
    })()
  `);
