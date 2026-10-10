/**
 * 接入面：**请求进来、批准、吊销**。
 *
 * 和 `gateway.ts` 分开，因为它们是两种知识：那边是**四原语的契约**（Task / 执行者 /
 * 能力 / 事件），这边是**宿主边界**（谁能连上这台机器）。混在一个文件里，
 * "命令面"和"门禁面"就分不出来了。
 *
 * 地址和凭据都从 `connection.ts` 取——和 `gateway.ts` 同一份。
 *
 * ## 两条免鉴权，五条要 guard
 *
 * | 端点 | 谁用 | 有 guard 吗 |
 * | --- | --- | --- |
 * | `POST /api/access/request` | 还没进来的那台设备 | **没有** |
 * | `GET  /api/access/status` | 同上，轮询等批准 | **没有** |
 * | `GET  /api/access/pending` | 已经进来的你 | 有 |
 * | `POST /api/access/approve` / `deny` | 同上 | 有 |
 * | `GET  /api/access/devices` / `POST .../revoke` | 同上 | 有 |
 *
 * ← 新建（后端在 `occ-next/src/web/http.py`，判决在 `gateway/access/`）
 */
import { authHeaders, endpointFor } from './connection';
import { GatewayError, errorMessage } from './gateway';

/** 一条等着人点头的请求。**批准方看到的那一份**（含核对用的 `code`）。 */
export interface PendingAccess {
  request_id: string;
  code: string;
  device_name: string;
  host: string;
  /** 还有多少秒过期 */
  expires_in: number;
}

/** 一台已接入的设备。**凭据不在这里** —— 服务端只存摘要，也从不回传。 */
export interface PairedDevice {
  device_id: string;
  name: string;
  host: string;
  created_at: string;
  last_seen: string;
}

/** 手机轮询拿到的答复。`credential` **只出现一次**，取走就没了。 */
export type AccessStatus =
  | { state: 'pending'; request_id: string; code: string; device_name: string; expires_in: number }
  | { state: 'approved'; credential: string; device: PairedDevice }
  | { state: 'unknown' };

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(endpointFor(path), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new GatewayError(await errorMessage(response, '这一步没能完成'), response.status);
  }
  return response.json();
}

/**
 * 请求接入。**这条路不需要凭据** —— 它就是要来拿凭据的。
 *
 * 回 `null` 就是被拒了（限速、队列满、或者名字是空的）。**后端故意不说是哪一种**：
 * 对一个免鉴权的端点，说得越细越像是在帮人试探边界。
 */
export async function requestAccess(deviceName: string): Promise<PendingAccess | null> {
  const wire = await post('/api/access/request', { device_name: deviceName }) as
    { ok?: boolean } & Partial<PendingAccess>;
  if (wire.ok !== true || !wire.request_id) return null;
  return wire as PendingAccess;
}

/** 轮询等批准。**取到 `approved` 之后不要再来**——凭据已经被取走了。 */
export async function accessStatus(requestId: string): Promise<AccessStatus> {
  const response = await fetch(
    endpointFor(`/api/access/status?request_id=${encodeURIComponent(requestId)}`),
    { headers: authHeaders() }
  );
  if (!response.ok) {
    throw new GatewayError(await errorMessage(response, '查询接入状态失败'), response.status);
  }
  return await response.json() as AccessStatus;
}

export async function listPending(): Promise<PendingAccess[]> {
  const response = await fetch(endpointFor('/api/access/pending'), { headers: authHeaders() });
  if (!response.ok) {
    throw new GatewayError(await errorMessage(response, '读取待批设备失败'), response.status);
  }
  return ((await response.json()) as { pending?: PendingAccess[] }).pending ?? [];
}

export async function approveAccess(requestId: string): Promise<void> {
  await post('/api/access/approve', { request_id: requestId });
}

export async function denyAccess(requestId: string): Promise<void> {
  await post('/api/access/deny', { request_id: requestId });
}

export async function listDevices(): Promise<PairedDevice[]> {
  const response = await fetch(endpointFor('/api/access/devices'), { headers: authHeaders() });
  if (!response.ok) {
    throw new GatewayError(await errorMessage(response, '读取已接入设备失败'), response.status);
  }
  return ((await response.json()) as { devices?: PairedDevice[] }).devices ?? [];
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await post('/api/access/revoke', { device_id: deviceId });
}
