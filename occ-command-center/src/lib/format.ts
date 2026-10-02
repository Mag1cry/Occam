/**
 * 数值格式化
 *
 * `formatDurationSec` 从 occ-web 的 `src/lib/format.ts` 原样抄来：
 * 卡片是密集排版，`1h 15min` 比 `75m 0s` 短一半，而 `20min` 比 `20m 0s`
 * 少两个字符——节点页脚只有 154px 可用，这点长度是决定性的
 * （见 DESIGN.md 第 6 节的实测数）。
 *
 * 保留 occ-web 的语义：秒数进位到分、分进位到小时，**零秒不显示**。
 */

/**
 * 秒 → 紧凑时长文本
 *
 * - `45` → `45s`；`1230` → `20min 30s`；`1200` → `20min`；
 * - `11520` → `3h 12min`；`10800` → `3h`；
 * - 非有限数或负数返回 `null`——调用方据此显示占位符，不猜。
 */
export function formatDurationSec(seconds?: number): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min < 60) return sec > 0 ? `${min}min ${sec}s` : `${min}min`;
  const h = Math.floor(min / 60);
  const restMin = min % 60;
  return restMin > 0 ? `${h}h ${restMin}min` : `${h}h`;
}
