/**
 * 当前连接（后端地址 + 凭据），跟着变
 *
 * 用 `useSyncExternalStore` 而不是 `useState` + 订阅：`connection.ts` 那份状态是
 * **模块级的**，不是某个组件的——多个组件同时读它，任何一处改了都要一起动。
 * 自己拿 `useState` 抄一份的话，就会有"N 份各自会漂移的连接状态"。
 */

import { useSyncExternalStore } from 'react';
import { readConnection, subscribeConnection, type Connection } from '../api/connection';

export function useConnection(): Connection {
  return useSyncExternalStore(subscribeConnection, readConnection, readConnection);
}
