/**
 * 进入 Task 场景并截图
 *
 * 用真实双击（两次可信 click）进入，顺便验证「双击不依赖原生 dblclick」这条修复。
 */
export default async ({ page }) => {
  await page.sleep(600);

  // 记录浏览器到底有没有派发原生 dblclick
  await page.eval(`
    window.__dbl = 0;
    document.addEventListener('dblclick', () => { window.__dbl += 1; }, true);
    true;
  `);

  await page.dblclickSelector('.react-flow__node[data-id="task-001"]');
  await page.sleep(1600);

  const scene = await page.eval('document.body.innerText.includes("调用顺序")');
  const dbl = await page.eval('window.__dbl');
  console.log(`[task] 进入审计信息面=${scene} 原生 dblclick 派发次数=${dbl}`);
};
