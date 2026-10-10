/**
 * 连接：**后端在哪、以什么身份**。
 *
 * ## 为什么是运行时状态，不是构建期常量
 *
 * 它以前是 `import.meta.env.VITE_GATEWAY_URL` —— 而 `import.meta.env` 是 Vite
 * **打包时替换成字符串**的，也就是说地址被烧进了 JS bundle。后果两条：
 *
 * 1. **换个后端要重新打包**，手机上改不了；
 * 2. 打包成 Android 应用之后这个是**死路**：APK 里的页面从 `https://localhost`
 *    加载，对后端就是跨域，地址必须是绝对的 —— 而绝对地址从哪来？
 *
 * 所以这两样东西是**运行时**的，存在 localStorage 里。
 *
 * ## 为什么"空"是有意义的默认值
 *
 * `endpoint` 空 = **同源**，走相对路径。那是今天的主流形态（后端自己把 `dist/`
 * 端出来，或者开发时 Vite 把 `/api` 代理过去），也是 `VITE_GATEWAY_URL` 不设时
 * 的默认。**这个默认必须保住**：设了才用绝对的，没设就还是原来那条路。
 *
 * ## 凭据只有一种带法，但有两种来源
 *
 * 访问令牌（一台机器一根）和设备凭据（配对签发的一台一条）**都走同一个头**：
 * `Authorization: Bearer <它>`。前端不需要区分——后端那边 `judge_caller` 会认。
 *
 * SSE 例外：`EventSource` 带不了自定义头，所以流那条路走 `?token=`。
 *
 * ← 新建（`gateway.ts` 和 `access.ts` 都从这里取地址和凭据）
 */

/** localStorage 的键。**改了它就等于让所有人重新填一遍地址和凭据**。 */
const STORAGE_KEY = 'occ-connection';

export interface Connection {
  /** 后端地址。**空 = 同源**（相对路径）。末尾斜杠会被去掉，拼接时统一。 */
  endpoint: string;
  /** 凭据：访问令牌或设备凭据。空 = 不带。 */
  credential: string;
}

/** 构建期给的默认值。**只当默认**——运行时改过之后以 localStorage 为准。 */
const DEFAULT_ENDPOINT = (import.meta.env.VITE_GATEWAY_URL ?? '').trim();

function normalize(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

let current: Connection = load();
const listeners = new Set<() => void>();

function load(): Connection {
  const fallback: Connection = { endpoint: normalize(DEFAULT_ENDPOINT), credential: '' };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<Connection>;
    return {
      // **存储里没有 `endpoint` 这一格时回退到默认**，而不是回退到空——
      // 那样会把"构建期设的地址"悄悄抹掉。
      endpoint: normalize(String(saved.endpoint ?? fallback.endpoint)),
      credential: String(saved.credential ?? ''),
    };
  } catch {
    // 读不出来（隐私模式、坏掉的 JSON）就当没存过：**那是可恢复的，而"起不来"不是**
    return fallback;
  }
}

export function readConnection(): Connection {
  return current;
}

export function writeConnection(next: Partial<Connection>): void {
  const merged: Connection = {
    endpoint: normalize(next.endpoint ?? current.endpoint),
    credential: next.credential ?? current.credential,
  };
  if (merged.endpoint === current.endpoint && merged.credential === current.credential) return;

  current = merged;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // 存不下也照样用——内存里那份是对的，只是下次打开要重填
  }
  for (const listener of listeners) listener();
}

/** 变了要重连：地址换了，SSE 那条流得整个重开。 */
export function subscribeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 拼一个请求地址
 *
 * `endpoint` 空时**返回相对路径**——那就是同源，和从前逐字节相同。
 */
export function endpointFor(path: string): string {
  return current.endpoint ? `${current.endpoint}${path}` : path;
}

/** 带凭据的请求头。没凭据时**一个头都不加**，免得空 `Bearer` 反而被判成"凭据不对"。 */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return current.credential
    ? { ...extra, authorization: `Bearer ${current.credential}` }
    : extra;
}

/**
 * 流的地址
 *
 * **`EventSource` 带不了自定义头** —— 所以凭据只能走查询参数。
 * 后端为此一直留着 `?token=` 这条兜底（`web/http.py::_presented`）。
 */
export function streamUrl(path: string): string {
  const url = endpointFor(path);
  if (!current.credential) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(current.credential)}`;
}
