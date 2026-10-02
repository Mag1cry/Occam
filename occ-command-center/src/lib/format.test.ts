/**
 * 时长格式化测试
 *
 * 这个函数是从 occ-web 抄过来的，语义必须和那边一致：零秒不显示、
 * 分进位到小时。改坏任何一个分支都会让节点页脚的宽度假设失效
 * （页脚只有 154px，`75m 0s` 换成 `1h 15min` 就是从溢出到放得下）。
 */

import { describe, expect, it } from 'vitest';
import { formatDurationSec } from './format';

describe('formatDurationSec', () => {
  it('不足一分钟按秒', () => {
    expect(formatDurationSec(45)).toBe('45s');
    expect(formatDurationSec(59.4)).toBe('59s');
  });

  it('分与秒，零秒不显示', () => {
    expect(formatDurationSec(1230)).toBe('20min 30s');
    // 关键用例：20m 0s 这种写法在页面里放不下
    expect(formatDurationSec(1200)).toBe('20min');
    expect(formatDurationSec(4500)).toBe('1h 15min');
  });

  it('超过一小时进位，整小时不带零头', () => {
    expect(formatDurationSec(11520)).toBe('3h 12min');
    expect(formatDurationSec(10800)).toBe('3h');
  });

  it('没有值就是没有值，不猜 0', () => {
    expect(formatDurationSec(undefined)).toBeNull();
    expect(formatDurationSec(Number.NaN)).toBeNull();
    expect(formatDurationSec(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatDurationSec(-1)).toBeNull();
  });
});
