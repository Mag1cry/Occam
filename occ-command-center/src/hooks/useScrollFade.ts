/**
 * 「底下还有内容」的淡出提示
 *
 * ## 为什么要有
 *
 * 一个限高的滚动区，**没有提示时看起来就是"卡片到此为止"**——被截掉的那半句和
 * 一个 bug 是同一种后果。概览栈在矮视口上封顶之后就是这样：`子 Task` 和
 * `当前显示` 两行在折线以下，而卡片的圆角底边被切平，看上去像卡片就这么长。
 *
 * ## 为什么用 `mask-image` 而不是加一个渐变 div
 *
 * 渐变 div 要么是滚动容器的**子元素**（于是会占布局、被 `gap` 推移、还会让
 * `[data-scene-overlay-stack] > div` 这类直接子选择器多数出一块），要么得套一层
 * 定位容器（于是整棵结构都要动）。`mask-image` 一行 CSS 就贴在下沿上，
 * **不进 DOM、不改布局、不动任何选择器**。
 *
 * ## 为什么是 JS 而不是 CSS 的 `animation-timeline: scroll()`
 *
 * 那个写法更短，但它要求 Chromium 115+。这个界面要跑在 Android 的 WebView 上，
 * 而系统 WebView 的版本跟着设备走——不支持时那条动画会**在加载时自己播完**，
 * 于是提示永远不出现，而且没有任何迹象说明为什么。宁可自己算。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** 哪几条边被截断了 */
export type ScrollEdge = 'none' | 'below' | 'above' | 'both';

/** 内容比可视区高出不到 2px 就算没有更多——滚动容差的抖动不该让提示闪 */
const SLACK = 2;

const CLASS: Record<ScrollEdge, string> = {
  none: '',
  below: 'occ-scroll-fade-below',
  above: 'occ-scroll-fade-above',
  both: 'occ-scroll-fade-both',
};

/**
 * 返回 `[ref, 类名]`
 *
 * **为什么是元组而不是 `{ ref, className }`**：后者要在渲染期写 `x.ref`，
 * 而 `oxlint` 的 `react(refs)` 规则把**任何 `.ref` 成员访问**都当成"渲染期读 ref"
 * 报一条警告。这里传的是 ref 对象本身、没有读 `.current`，是误报——但为它把
 * 二十多处警告留在输出里，下一个人就分不出真问题。元组没有成员访问，绕开了。
 */
export function useScrollFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [edge, setEdge] = useState<ScrollEdge>('none');

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const above = el.scrollTop > SLACK;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight > SLACK;
    setEdge(above && below ? 'both' : below ? 'below' : above ? 'above' : 'none');
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    update();
    // 滚动改变"还差多少"，容器自己变高变矮改变"有没有更多"
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [update]);

  /*
    内容换了高度也会换，而那不是"容器尺寸变了"——`ResizeObserver` 盯的是容器自己，
    它看不见里面。所以每次渲染之后再算一遍。`setEdge` 拿到同一个值时 React 直接跳过，
    不会因此多渲染。
  */
  useEffect(update);

  return [ref, CLASS[edge]] as const;
}
