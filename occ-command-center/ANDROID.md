# 打包成 Android 客户端 —— 待办

> 目标：把 `occ-command-center` 打包成一个 Android 应用，连**另一台机器上**的 `occ-next`。
> 手机和平板都要。后端不进 APK（应用是客户端）。
>
> 状态截至 2026-10-06。所有数字都是实测的，出处标在括号里。

---

## 一、已经就绪的

| | 说明 |
| --- | --- |
| **手机上的布局适配** | HUD 不折行、浮层零遮挡、滚动提示。**验证尺寸 800×360 = 真机横屏**（截图 2400×1080 @3x） |
| **后端受限 CORS** | `OCC_NEXT_ALLOWED_ORIGINS`，精确白名单、默认空 = 与从前逐字节相同（`occ-next/tests/test_cors.py`，29 项） |
| **Java 21** | `java 21.0.10` 在 PATH 上。注意 `JAVA_HOME` **未设** |
| **Node 24 / npm 11** | 前端构建没问题 |

---

## 二、A 类：连接层 —— ✅ 已完成（2026-10-07）

做了什么：

- `src/api/connection.ts`（新）——地址 + 凭据，**运行时可变**、存 localStorage，
  默认值仍取 `VITE_GATEWAY_URL`（不设就是同源，和从前逐字节相同）
- `gateway.ts` 的 7 处**改成调用时读**；4 个 `fetch` 挂 `Authorization: Bearer`，
  `EventSource` 走 `?token=`。**签名一个没动**，`src/test/setup.ts` 那条 mock 边界完好
- `src/api/access.ts`（新）——接入面的 7 个端点。和 `gateway.ts` 分开：
  那边是四原语的契约，这边是宿主边界
- `ConnectionForm`（新）——两处共用：`SceneStateLayer`（连不上时唯一还能渲染的东西）
  和配置舱
- 连接一变，`App` 就 `reset()` + 重读 + 按新地址重开 SSE（**丢掉旧快照**：
  地址换了就是换了台机器，继续显示它就是另一个世界的节点）

### 为什么（留档）

APK 里的页面由 Capacitor 从 `https://localhost` 交给 WebView，而后端在 `http://<某台机器>:8765`。
**不同源** —— 于是 `fetch('/api/state')` 会打到 `https://localhost/api/state`，而 APK 里没有这个东西：
界面会停在「后端不可达」。后端**刻意不加 CORS**（`occ-next/src/web/http.py` 的 `_mount_web` 文档写着
"前端必须和 `/api` 同源"），所以这条路必须靠绝对地址。

而地址今天是构建期烧死的（`src/api/gateway.ts:342`）：

```ts
const base = import.meta.env.VITE_GATEWAY_URL ?? '';
```

`import.meta.env` 是 Vite **打包时替换成字符串**的。后果两条：

1. 换后端地址要重新打包 —— 手机上改不了。**Stage 2 要验的东西正好卡在这**。
2. **一个令牌都没带**。前端今天没有一行认证代码，它假设"同源 = 局域网 = 免凭据"。

### 做什么

- [ ] 新增 `src/api/connection.ts`：**后端地址 + 凭据**，运行时可变、存 localStorage，
      默认值仍取 `VITE_GATEWAY_URL`
- [ ] `gateway.ts` 的 7 个接口改成**调用时**读它（现在 `base` 是模块加载时求值一次的常量）
- [ ] 4 个 `fetch` 挂 `Authorization: Bearer`；`EventSource` 的 URL 挂 `?token=`
      （后端两种都认，见 `occ-next/src/web/http.py` 的 `_presented` —— **后端不用改**）
- [ ] 一个"连接设置"入口（填地址、填凭据），接上已有的 `unauthorized` 状态

### 不能碰的

- **所有导出留在 `src/api/gateway.ts`**：`src/test/setup.ts:14` 按模块路径整块 mock，
  约 50 个文件按路径 import。是**改函数体，不是搬家**。
- 默认 HTTP 实现必须**在调用时**取 `globalThis.fetch`（测试在 import 之后才 stub 全局）。
- 7 个函数的签名、`GatewayError.status`、`isUnauthorized` 的 instanceof 语义不变。
- `sendAccepted → sendGatewayCommand` 这条内部链不动。

---

## 三、B 类：身份控制 —— ✅ 设备配对已完成（2026-10-07）

做了什么：

- `occ-next/src/gateway/access/pairing.py`（新）——待批队列 + 设备台账 + 签发凭据。
  台账落 `data/access-devices.json`，**只有摘要**（服务端从不展示凭据原文）
- `policy.judge_caller` 加第三条：**在信任网段 或 令牌对 或 设备凭据有效**。
  它只收一个布尔 `paired`——这一层不该同时认识"来源怎么分级"和"台账长什么样"
- 7 个端点：`request` / `status` **免鉴权**（请求方就是还没进来的人），
  `pending` / `approve` / `deny` / `devices` / `revoke` 走 guard
- `ConnectionPanel`（新）挂配置舱左下：待批（带核对码）+ 已接入设备（可吊销）
- `tests/test_pairing.py`（新）15 项，**全程走 HTTP**

三条自己扛的（免鉴权端点）：限速（同一来源 5 次/10 分钟）、待批 5 分钟过期、
队列上限 8。**凭据取走即删**，吊销下次请求就生效（每次现场比台账，不用重启）。

### 现状（实测过，留档）

`occ-next/src/gateway/access/policy.py` 的 `judge_caller` 是**全项目唯一的判决函数**，
**只有一个调用方**（`src/web/http.py:67`）：

```text
放行 = 在信任网段（回环 + RFC1918 + link-local） 或 令牌对
```

令牌在 `data/access-token.json`（`secrets.token_urlsafe(32)`，首次启动生成、之后复用）。
用 TestClient 实测：`Bearer` → 200 / `Basic` → **401** / `?token=` → 200。
（`occ-next/README.md` 里那句"HTTP Basic 会让浏览器弹框"是错的，已改。）

### 对 Android 意味着什么

| 手机在哪 | 后端判定 | 要凭据吗 |
| --- | --- | --- |
| 同一个局域网 | LAN | **不要**。今天就能用 |
| 网外 | EXTERNAL | 要 |

所以**身份控制现在不是阻塞项** —— 但 A 类要**为它留位置**：`connection.ts` 存的是
"一个凭据字符串"，它怎么来的（手抄 / 配对 / 以后的证书指纹）是另一件事。

### 现有令牌的四个问题

1. **不好搬**：43 个字符的随机串，在服务器上。手机上要么手打，要么你把文件传过去。
2. **一令牌多设备**：换令牌 = 所有带着旧令牌的设备一起失效。
3. **认不出设备**：审计里只有 `external@<ip>`。
4. **不能单独吊销**。

### 建议：设备配对 + 按设备签发

```text
手机（未认证）                    后端                        局域网里的你
   │                              │                              │
   ├─ POST /api/access/request ──▶│                              │
   │  {device_name: "Pixel 8"}    │ 生成待批记录                 │
   │◀─ {code: "8F3K-2M9Q", …} ────┤                              │
   │                              │                              │
   │ 手机上显示这个码              ├─ 配置舱出现待批 ────────────▶│
   │                              │                              │ 核对两个码一样
   │                              │◀─ 批准 ──────────────────────┤
   │◀─ {credential} ──────────────┤ 签发并记账                   │
```

判据从两条变三条：**在信任网段 或 令牌对 或 设备凭据有效**。

**三条必须做对，否则是个洞：**

1. **请求端点必须免鉴权**（它就是入口）→ 限速 + 短有效期（5 分钟）+ 待批队列上限。
2. **码要人对**：手机显示、批准方屏幕上出现同一个码。
   **没有这一步，谁先请求谁就拿到访问权。**
3. **按设备签发、可单独吊销**：删 `data/access-devices.json` 里一条即可。

**落地位置**：`gateway/access/`，和 `data/access-token.json` 平级。
**不进内核、不建第二套权限中心** —— 这是 `docs-Next-Version/architecture-next/peripherals/remote-adapters.md`
的明文约束。

**批准界面放哪**：建议**配置舱**（"配置与能力"，"谁能连进来"是配置），
**不要混进"待拍板"** —— 待拍板是 Task 的语义，设备接入是宿主的事，混在一起会把那条边界糊掉。
但 HUD 上该加个标记，不然你得正好在配置舱里才看得见有人等着。

### ⚠️ 一条不能绕的约束

**`mcp.register` 会把 payload 直接交给 `Popen`。**
凡是够得着 `/api/command` 的，**都能在这台机器上起进程**。

所以：

- 远程接入的边界**只会更该收紧**，不是放松；
- 凭据泄露 = 机器被控；
- **明文 HTTP 上搬令牌 = 把钥匙写在明信片上。**

**结论：身份控制不能脱离传输单独做。** 家里局域网手抄令牌可以接受；
一旦出网，必须走 HTTPS（隧道自带）或 WebRTC（DTLS 自带）。

---

## 四、C 类：工具链（阻塞）

现在**一样都没有**（实测）：

```text
ANDROID_HOME / ANDROID_SDK_ROOT      未设
$LOCALAPPDATA/Android/Sdk            不存在
adb / gradle / sdkmanager            都不在 PATH
Android Studio                       没装
```

- [ ] 装 Android Studio（自带 SDK / JDK / Gradle / 模拟器），或 command-line tools + `sdkmanager`
- [ ] 设 `ANDROID_HOME`；`JAVA_HOME` 也要设（Java 21 有，环境变量没有）
- [ ] 加依赖：`@capacitor/core` `@capacitor/cli` `@capacitor/android`
- [ ] `npx cap add android`

---

## 五、D 类：安卓壳要配的

### D1. 安全区 —— 不补就白调了

`index.html` 现在是：

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```

**缺 `viewport-fit=cover`。** 浏览器里没有刘海和手势条，WebView 里有 ——
不补的话**顶部那条 HUD 会被切掉一截**，而那正是前几轮刚调好的东西。
全仓库 `env(safe-area-inset-*)` **一处都没用**。

- [ ] viewport 加 `viewport-fit=cover`
- [ ] HUD / 锚点 / 底部操作牌的定位改用 `env(safe-area-inset-*)`

### D2. 明文 HTTP

后端默认 `http://…:8765`，而 **Android 9 以上默认禁明文**。

- [ ] 要么 manifest 开 `usesCleartextTraffic`（家用够），要么给后台上 HTTPS
- [ ] **必须在真机上验** —— 这条只在设备上才现形

### D3. 返回键

`FocusAnchor` 已经在听 `popstate`（浏览器返回），但 **Android 的物理/手势返回键走的是
Capacitor 的 `backButton` 事件**，不是 `popstate`。

- [ ] 监听 `backButton` → `SceneStack.pop()`；已经在第一层时再退出应用
- [ ] 不接的话：按返回键**直接退出应用**，而不是退回上一场景

### D4. 外链

Markdown 的链接是 `target="_blank"`（`src/components/ui/Markdown.tsx:58`），
在 WebView 里会试图应用内开新窗口。

- [ ] 转给系统浏览器打开

### D5. 方向

- [ ] 定死横屏还是允许旋转。画布 UI 是横向设计的，竖屏 400px 那档只是"不崩"不是"好用"

---

## 六、E 类：资源与签名

`public/` 里**只有一个 `favicon.svg`**。

- [ ] 应用图标：一套 mipmap（各密度 + 自适应图标）。`@capacitor/assets` 能从一个
      1024×1024 源图生成全套
- [ ] 启动图
- [ ] 应用名 + **包名**（`com.?.occ` 之类，定了改不了）
- [ ] 签名 keystore（只有 release 要；debug 构建不用）

---

## 七、顺序

```text
A 连接层        ✅ 完成
B 身份控制      ✅ 完成（设备配对）
   ↓
Stage 2 · 手机上验真跨域   ← ★ 只剩这一步没验
   ↓
C 工具链（装 Android Studio，几个 GB）
   ↓
D 壳配置 ／ E 资源   （都是配置）
```

### ★ Stage 2 已经**部分验掉了**（2026-10-07）

拿一个 8766 的临时后端、用新做的连接功能把前端指过去（页面 `localhost:5173`、
接口 `127.0.0.1:8766`），**HUD 显示「实时」**。也就是说：

- **跨域 `fetch` 通了**（预检 + `ACAO` 都对）；
- **跨域 `EventSource` 也通了**。

这是整个方案里风险最高的那条未知数，**在桌面 Chromium 上已经成立**。
真机 WebView 还要单独验一次（系统 WebView 的版本跟着设备走），
但那已经不是"CORS / SSE 行不行"的问题了。

### ⚠️ 你那个后端要重启一次

`python -m src.serve` 不带 reload，所以**现在跑着的 8765 还是旧代码**——
配置舱那块「连接」面板会调 `/api/access/pending` 拿到 404（面板显示错误，
其余一切正常）。重启之后就对了。

### 为什么 Stage 2 必须在装 Studio 之前

**跨域 SSE 是整个方案里风险最高的未知数。** 而绕开跨域的标准手段 CapacitorHttp
会把响应**整段缓冲** —— 用它等于放弃实时流。
（这一条来自别人的报告，不是我量的：elizaOS PR #8773 记的是"服务端全部生成完之后，
一整块才到"，他们最后只能绕开 CapacitorHttp 走未打补丁的原生 fetch。
**我们这边还没在真机上验过** —— 那正是 Stage 2 要干的事。）

它不过的话，C 之后的东西都白做。

### Stage 2 的确切跑法

```powershell
# 后端：绑到局域网 + 允许来自 5173 的源
$env:OCC_NEXT_HOST='0.0.0.0'
$env:OCC_NEXT_ALLOWED_ORIGINS='http://192.168.0.100:5173'
cd occ-next ; uv run python -m src.serve
```

```bash
# 前端：接口地址指成绝对路径 —— 页面源和接口源这才分开
cd occ-command-center
VITE_GATEWAY_URL=http://192.168.0.100:8765 npm run dev -- --host
```

手机打开 `http://192.168.0.100:5173`，**HUD 还显示「实时」才算过**。
这次是真跨域：`fetch` 要过预检、`EventSource` 要带 `?token=`、响应要带 `ACAO`。

> **别被"日常开发时也是实时"骗了**：平时开的是 `:5173`，Vite 把 `/api` 代理到后端，
> 浏览器看到的是**同源** —— 那条路上根本没有 CORS 这回事。

---

## 八、验证工具（已经在仓库里）

```bash
node scripts/shot.mjs --script scripts/scenes/hud.mjs     --size 800x360 --out .shots/hud.png
node scripts/shot.mjs --script scripts/scenes/overlap.mjs --size 800x360 --out .shots/rep.png
```

两个都**会抛**。`overlap.mjs` 还带一条"页面真的渲染了"的自检 —— 它踩过一次：
dev server 停着时量到空白页，**0 块浮层当然 0 处遮挡**，脚本高高兴兴报全过。

过一遍的尺寸：`800x360`（真机横屏）、`400x720`（竖屏）、`1024x768`（平板）、
`1600x1000`、`1912x948`（开发机）。

### jsdom 抓不到这些

`npm test` 只能保证不破坏现有断言 —— **它不做布局**。上面那类问题只有真浏览器量得出来。

---

## 九、一个仍未关掉的落差

左上角那块**锚点牌固定 208px**，而下面的概览卡是**按内容收窄**的（配置舱 112px、
编排台 181px）。左对齐、右边缘差 27px。

锚点的宽度写死在 `src/lib/flip.ts` 的 `ANCHOR_SIZE` 里，它同时是**进出场景飞行代理的终点**
（进场景那一刻锚点还没挂载，量不到，所以只能用常量）。要让两块齐平只能二选一：

- 锚点也随内容变，飞行终点仍用 208 → 每次飞行落点比牌子宽 27px；
- 或者卡片下限抬到 208 → 那 98px 空白又回来了。

**没动，因为两个都有代价。**
