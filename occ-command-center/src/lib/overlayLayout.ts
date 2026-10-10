/**
 * 屏幕浮层之间的布局约定
 *
 * ## 为什么需要这个文件
 *
 * 桌面宽度上这些浮层各占一方，互不打扰，所以它们的尺寸和位置一直是各写各的。
 * 手机上一挤，问题全出来了——**而它们互相不知道对方占了哪里**：
 *
 * - 概览栈（左上）和「子 Task 分区」（左下）整块重叠 144px；
 * - HUD 和左上角锚点牌重叠 104px；
 * - `ScheduleScene` 和 `ConfigurationScene` 各自写了一个 `bottom-24`，
 *   **没有注释、也没有常量**，而且算错了：`CommandSurface` 的顶边在离底约 102px，
 *   96px 是**重叠 6px**。
 *
 * 所以这里只放**跨组件的那几个数**。单纯的尺寸（某张卡多宽）留在组件自己那儿。
 */

/**
 * 底部留给 `CommandSurface` 的整条带子
 *
 * = 它的 `bottom-6`(24) + 胶囊高度（约 78：2px 边框 + `p-2.5`(20) + 标题行 ~24
 * + 按钮行 `min-h-[32px]`）+ 一点余量。
 *
 * **只有窄屏且操作牌在场时才用得上它**（见 `bottomPanelClass`）：宽屏上操作牌够不到
 * 左右两边，侧面板贴底就行。
 */
export const BOTTOM_BAND = 110;

/**
 * 宽到"操作牌伸不过来"的门槛
 *
 * 操作牌最多 720px 宽、居中，所以它的左边缘在 `(视口 − 720) / 2`。
 * 侧面板右边到 340，要够不着它就得 `(视口 − 720) / 2 ≥ 340` → 视口 ≥ 1400。
 * 取 1536（Tailwind 的 `2xl`）留出余量。
 */
export const WIDE_ENOUGH_TO_IGNORE_COMMAND_SURFACE = 1536;

export function isWideViewport(viewportWidth: number): boolean {
  return viewportWidth >= WIDE_ENOUGH_TO_IGNORE_COMMAND_SURFACE;
}

/**
 * 底部两个侧面板的位置
 *
 * **它们以前是永远抬起的**（先是 `bottom-24`，后来是 110px），于是桌面上也白白
 * 空着一条——而那条缝只有在"操作牌会横向伸过来"的时候才有必要。
 *
 * 更细一层：**操作牌没出现时根本不用让**。`CommandSurface` 只在选中了对象时才渲染，
 * 而没选中是常态——那时抬着就是纯浪费。
 *
 * ⚠️ 两个类名都要写成**字面量**：Tailwind 是扫源码文本的，拼出来的它看不见，
 * 会直接不生成。改 `BOTTOM_BAND` 时记得同步 `BOTTOM_PANEL_YIELD`。
 */
export const BOTTOM_PANEL_REST = 'bottom-5';
export const BOTTOM_PANEL_YIELD = 'bottom-[110px]';

/** 面板该用哪个位置：**有操作牌、而且窄到它会伸过来**，才让位 */
export function bottomPanelClass(commandSurfaceVisible: boolean, wide: boolean): string {
  return commandSurfaceVisible && !wide ? BOTTOM_PANEL_YIELD : BOTTOM_PANEL_REST;
}

/**
 * 左列下半部分至少要留出来的高度（含它和概览栈之间的缝）
 *
 * 概览栈据此封顶，保证它**永远够不到**下面那个面板——在手机上这是硬约束：
 * 360 高时，"锚点 + 栈" 和 "分区面板 + 底带" 加起来要 513px，两样全尺寸摆不下。
 *
 * 值 = 分区面板收起时的高度（42）+ 缝。缝要给够：两块玻璃面板隔 4px 看着就是贴在一起，
 * 那正是"它们是不是同一块"的误读来源。
 */
export const BOTTOM_PANEL_MIN = 56;

/**
 * 矮到这个高度就算"手机横屏"
 *
 * 触发两件事：左下那个分区面板**默认收起**成一行，概览栈收得更紧。
 *
 * 判据取 500 而不是某个手机型号的高度：360 是真机横屏的高度，
 * 而 jsdom 的默认高度是 768 —— 所以这条**不会**影响任何现有测试。
 */
export const SHORT_VIEWPORT_MAX_HEIGHT = 500;

export function isShortViewport(viewportHeight: number): boolean {
  return viewportHeight < SHORT_VIEWPORT_MAX_HEIGHT;
}
