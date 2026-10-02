/**
 * 四个场景各截一张
 *
 * 全部用可信指针事件驱动（真实双击、真实点击返回锚点），
 * 走的是用户路径，不是直接改 store。
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// 截图落在仓库的 `.shots/`（已 gitignore）——**不往用户的 Temp 里堆东西**。
// 从脚本自己的位置算，所以在哪个目录下调用都落到同一处。
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.shots');

const enter = async (page, nodeId, name) => {
  await page.dblclickSelector(`.react-flow__node[data-id="${nodeId}"]`);
  await page.sleep(1700);
  await page.shot(`${OUT}/${name}.png`);
};

const back = async (page) => {
  await page.clickSelector('[aria-label="返回上一场景"]');
  await page.sleep(1700);
};

export default async ({ page }) => {
  await page.sleep(900);
  await page.shot(`${OUT}/world.png`);

  await enter(page, 'task-001', 'task');
  await back(page);

  await enter(page, 'schedule-006', 'schedule');
  await back(page);

  await enter(page, 'archive-entry', 'archive');
  await back(page);

  await enter(page, 'configuration-entry', 'configuration');

  console.log('[all] 完成');
};
