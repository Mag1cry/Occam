/**
 * Markdown
 *
 * 把一段 Markdown 渲染成元素。**它只管渲染，不管放在哪**——浮窗外壳在
 * `components/overlay/MarkdownOverlay.tsx`，两处分开是因为"画在浮窗里"和
 * "把星号变成粗体"是两件事，将来要行内渲染时不必连浮窗一起搬。
 *
 * ## 为什么需要它
 *
 * 执行者报上来的东西本来就是有结构的——列表、粗体、偶尔还有表格和代码块。
 * 以前那些文本走的是 `whitespace-pre-wrap`，于是 `- **天气**：阴` 就原样印成
 * 一堆星号和横杠。分类模型输出、审批申请，都是这种文本。
 *
 * ## 内容是不可信文本，所以不碰 HTML
 *
 * 这里渲染的是**模型输出**，也就是外部内容。所以用的是 `react-markdown` 的
 * 默认行为：**它不渲染 HTML**。别为了"顺便支持一点 HTML"去加 `rehype-raw`——
 * 那等于把模型输出当代码执行，而这条路上没有任何东西替你把关。
 *
 * 同理，链接一律 `target="_blank"` + `rel="noreferrer"`：让人看得出它跳到站外。
 *
 * ## 样式为什么写在这里而不是全局 CSS
 *
 * 本仓没有 `@tailwindcss/typography`，而它的默认排版（大标题、段间距）会和
 * 这套界面打架。这些元素映射就是这份渲染器的"外观"，跟它住一个文件，
 * 读的人不必去别处找。
 */

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/*
  **字号按平板调过。** 这些正文是要在平板/触屏上读的（浮窗本来就为"读一份东西"
  而做），所以正文 14px、代码 13px——比界面里那些"扫一眼"的 11/12px 大一档。
  界面里的字号可以小，因为那是用来扫的；这个浮窗里的是用来读的。
*/
const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h3 className="mt-4 mb-2 text-[19px] font-medium text-white first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h4 className="mt-4 mb-2 text-[17px] font-medium text-white first:mt-0">{children}</h4>
  ),
  h3: ({ children }) => (
    <h5 className="mt-3 mb-1.5 text-[15px] font-medium text-slate-100 first:mt-0">{children}</h5>
  ),
  h4: ({ children }) => (
    <h6 className="mt-3 mb-1.5 text-[14px] font-medium text-slate-100 first:mt-0">{children}</h6>
  ),
  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 ml-5 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed [&>p]:my-0">{children}</li>,
  strong: ({ children }) => <strong className="font-medium text-white">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-slate-500 line-through">{children}</del>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer"
       className="text-occ-accent underline decoration-occ-accent/40 hover:decoration-occ-accent">
      {children}
    </a>
  ),
  /* 代码：块级靠 `pre` 的 `[&>code]` 把行内的底色与内边距压掉。
     不给 `code` 传 `inline` —— v10 已经没有那个 prop 了。 */
  pre: ({ children }) => (
    <pre className="num my-2.5 overflow-auto rounded border border-white/10 bg-black/30 p-3 text-[13px] leading-relaxed
                    [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[13px]">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="num rounded bg-white/[0.07] px-1 py-0.5 text-[13px] text-slate-100">
      {children}
    </code>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2.5 border-l-2 border-occ-accent/30 pl-3 text-slate-300">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-white/10" />,
  /* 表格：GFM 那一层给的。窄的时候自己横向滚，不撑破浮窗 */
  table: ({ children }) => (
    <div className="my-2.5 overflow-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-white/10 bg-white/[0.05] px-2.5 py-1.5 text-left font-medium text-slate-100">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-white/10 px-2.5 py-1.5 align-top">{children}</td>
  ),
};

export interface MarkdownProps {
  /** Markdown 原文。空串渲染成空——"空"怎么说由调用方决定 */
  content: string;
  className?: string;
}

export function Markdown({ content, className = '' }: MarkdownProps) {
  return (
    /* 正文 14px：这个浮窗里的字是**用来读的**，不是用来扫的（见上面那段） */
    <div className={`text-[14px] leading-relaxed text-slate-200 ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
