/**
 * shot.mjs —— 用 CDP 驱动本机 Edge 截图（零依赖，Node ≥ 22）
 *
 * 为什么不用 Playwright/Puppeteer：那要下载一份浏览器，而这个仓库里
 * 已经装了 Edge，Node 24 自带 WebSocket 和 fetch，走 CDP 就够用了。
 *
 * 用法：
 *   node scripts/shot.mjs --out shots/world.png
 *   node scripts/shot.mjs --script scripts/scenes/task.mjs --out shots/task.png
 *
 * 参数：
 *   --url    <url>    默认 http://localhost:5173/
 *   --out    <path>   默认 shot.png
 *   --size   WxH      默认 1600x1000
 *   --scale  <n>      设备像素比，默认 1（用 2 可以看清字号细节）
 *   --script <path>   截图前要跑的交互脚本，默认导出一个 async 函数
 *   --profile <dir>   复用同一个浏览器 profile（保留 localStorage 布局记忆）
 *   --keep            截完不关浏览器（调试用）
 *
 * 交互脚本写法：
 *   export default async ({ page }) => {
 *     await page.sleep(800);
 *     await page.dblclickSelector('.react-flow__node[data-id="task-001"]');
 *     await page.sleep(1200);
 *   };
 *
 * 事件用 CDP 的 Input 域派发，是**可信事件**：会真实触发浏览器原生的
 * click / dblclick、命中测试和 CSS :hover，和 jsdom 里的合成事件不是一回事。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

/**
 * 开发产物的落点：**这个仓库里的 `.shots/`**（已 gitignore）。
 *
 * 以前默认落系统临时目录，理由是"截图不该掉进仓库"——但那个理由的代价是
 * **往用户的 Temp 里堆东西**，而 Temp 是用户的地盘、不是这个项目的产物堆。
 * 同理：浏览器的临时 profile 也放这儿，跑完就删。
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
].filter(Boolean);

const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9222);

function parseArgs(argv) {
  const args = {
    url: 'http://localhost:5173/',
    out: join(ROOT, '.shots', 'shot.png'),
    size: '1600x1000',
    scale: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    if (name === 'keep') {
      args.keep = true;
      continue;
    }
    args[name] = argv[i + 1];
    i += 1;
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端：一连接、一命令、一应答 */
class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message} (${entry.method})`));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function findPageTarget(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // 浏览器还没起来
    }
    await sleep(200);
  }
  throw new Error('找不到可调试的页面目标（Edge 没起来？端口被占？）');
}

/** 给交互脚本用的页面封装 */
function createPage(client, defaultOut) {
  const box = async (selector) => {
    const result = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
      })()`,
      returnByValue: true,
    });
    return result.result.value;
  };

  /** 可信的指针序列：和真实手指/鼠标同一条路径 */
  const pointerSequence = async (x, y, times) => {
    for (let i = 0; i < times; i += 1) {
      const common = { x, y, button: 'left', buttons: 1, clickCount: i + 1 };
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: i + 1,
      });
      if (i + 1 < times) await sleep(60); // 双击的两下要落在同一个窗口内
    }
  };

  return {
    sleep,
    box,
    async eval(expression) {
      const result = await client.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        /*
          `text` 常常就只有「Uncaught」四个字，真正的栈在 `exception.description`
          里。只印 text 等于把这条错误丢进垃圾桶——写脚本的人看不出哪一行炸了。
        */
        const details = result.exceptionDetails;
        throw new Error(`页面内报错：${details.exception?.description ?? details.text}`);
      }
      return result.result.value;
    },
    async click(x, y) {
      await pointerSequence(x, y, 1);
    },
    async dblclick(x, y) {
      await pointerSequence(x, y, 2);
    },
    async clickSelector(selector) {
      const target = await box(selector);
      if (!target) throw new Error(`点不到：${selector}`);
      await pointerSequence(target.x, target.y, 1);
      return target;
    },
    async dblclickSelector(selector) {
      const target = await box(selector);
      if (!target) throw new Error(`点不到：${selector}`);
      await pointerSequence(target.x, target.y, 2);
      return target;
    },
    async scrollSelector(selector, deltaX, deltaY) {
      const target = await box(selector);
      if (!target) throw new Error(`找不到：${selector}`);
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: target.x,
        y: target.y,
        deltaX,
        deltaY,
      });
      return target;
    },
    async shot(path = defaultOut) {
      const result = await client.send('Page.captureScreenshot', { format: 'png' });
      const file = resolve(path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(result.data, 'base64'));
      console.log(`[shot] ${file}`);
      return file;
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [width, height] = args.size.split('x').map(Number);
  const scale = Number(args.scale) || 1;

  const edge = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!edge) throw new Error(`没找到 Edge，可用 EDGE_PATH 指定：${EDGE_CANDIDATES.join(' | ')}`);

  const profile =
    args.profile ?? join(ROOT, '.shots', `.profile-${process.pid}`);
  const freshProfile = !args.profile;

  const browser = spawn(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: false }
  );

  let client;
  try {
    const target = await findPageTarget(DEBUG_PORT);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
    });

    client = new CdpClient(ws);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });

    const page = createPage(client, args.out);

    await client.send('Page.navigate', { url: args.url });
    await page.sleep(1200); // 等首屏渲染 + fitView

    if (args.script) {
      const module = await import(pathToFileURL(resolve(args.script)).href);
      await module.default({ page });
    }

    await page.shot(args.out);

    if (!args.keep) await client.send('Browser.close').catch(() => {});
  } finally {
    if (!args.keep) {
      await sleep(300);
      browser.kill();
      /*
        临时 profile 删不掉是**常事**（Edge 刚退出时还攥着文件句柄，Windows 给
        EPERM）。它绝不能把真正的失败盖掉：`finally` 里抛出的错会替换掉原来那个，
        于是页面脚本里的报错（比如某个选择器点不到）会被一句
        「EPERM, Permission denied: occ-shot-12345」顶掉，看的人完全找不着北。
        删不掉就留着——它在系统临时目录里。
      */
      if (freshProfile) {
        try {
          rmSync(profile, { recursive: true, force: true });
        } catch {
          // 留着就好
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(`[shot] 失败：${error.message}`);
  process.exitCode = 1;
});
