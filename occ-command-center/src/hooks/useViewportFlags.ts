/**
 * 视口尺寸派生出来的两个布尔判据
 *
 * 它们都是**布局事实**，不是交互状态，所以只在跨过阈值时通知 React
 * （见下面 `useFlag` 的说明）。
 */

import { useEffect, useState } from 'react';
import { anchorRectFor, isCompactAnchor, type Rect } from '../lib/flip';
import { isShortViewport, isWideViewport } from '../lib/overlayLayout';

/** 提到模块作用域，好让它们的**引用是稳定的**（放进依赖数组才不会每渲染一次重挂监听） */
const readWidth = () => window.innerWidth;
const readHeight = () => window.innerHeight;

/**
 * 左上角焦点锚点现在该不该收成图标
 *
 * **为什么是 JS 而不是 CSS 媒体查询**：`ANCHOR_SIZE` 不只是画出来的尺寸，它同时喂给
 * `flip.ts` 的 `anchorRectFor()`，而那是进入/退出场景时飞行代理的**终点**。只让 CSS
 * 变窄、JS 不变的话，每次飞行都会落在一个比锚点宽 160px 的框里——而那种错位只在
 * 手机上才看得见，桌面测试一条都抓不到。所以画面和终点必须是同一个值。
 */
export function useCompactAnchor(): boolean {
  return useFlag(isCompactAnchor, readWidth);
}

/**
 * 是不是"手机横屏"那种矮视口
 *
 * 触发两件事：左下分区面板默认收起、概览栈收得更紧。
 */
export function useShortViewport(): boolean {
  return useFlag(isShortViewport, readHeight);
}

/**
 * 够不够宽到"操作牌伸不过来"
 *
 * 底部那两个侧面板据此决定要不要给操作牌让位。判据见 `overlayLayout` 的
 * `WIDE_ENOUGH_TO_IGNORE_COMMAND_SURFACE`。
 */
export function useWideViewport(): boolean {
  return useFlag(isWideViewport, readWidth);
}

/** 锚点矩形。**锚点画的、飞行飞的，都必须是这一个。** */
export function useAnchorRect(): Rect {
  return anchorRectFor(useCompactAnchor());
}

/**
 * 把一个"尺寸 → 布尔"的判据变成会跟着窗口变的状态
 *
 * **存布尔而不是存宽度**：`resize` 在手机上触发得非常密。存布尔的话，没跨过阈值时
 * `setState` 拿到的是同一个值（`Object.is` 相等），React 直接跳过重渲染。
 */
function useFlag(predicate: (size: number) => boolean, read: () => number): boolean {
  // 没有 window 时**按宽屏算**（false）：那是桌面布局，也是出错时更保守的一边
  const [flag, setFlag] = useState(
    () => typeof window !== 'undefined' && predicate(read())
  );

  useEffect(() => {
    const onResize = () => setFlag(predicate(read()));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [predicate, read]);

  return flag;
}
