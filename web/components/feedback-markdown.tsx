import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

type Props = {
  /** 模型给学生写的 feedback / 评语，markdown 源文本。 */
  children: string;
  /** 外层容器 className（颜色 / 边框 / padding 等）。 */
  className?: string;
};

const markdownComponents: Components = {
  /**
   * 普通 markdown 链接会变成 `<a href>`，模型可塞 `javascript:` / 外站 URL，
   * 诱导老师点出去或触发请求。不渲染真实 `<a>`，只保留可见文案 + 弱化展示 URL。
   */
  a({ href, children }) {
    return (
      <span className="text-foreground underline decoration-muted-foreground/40 decoration-dotted underline-offset-2">
        {children}
        {href ? (
          <span
            className="ml-1 break-all font-mono text-[0.85em] text-muted-foreground not-italic no-underline"
            title={href}
          >
            ({href.length > 80 ? `${href.slice(0, 80)}…` : href})
          </span>
        ) : null}
      </span>
    );
  },
  /**
   * `<img>` 会拉外站资源、泄露 Referer。改成纯文本占位，不发起网络请求。
   */
  img({ src, alt }) {
    const srcStr = typeof src === "string" ? src : "";
    return (
      <span className="my-1 block rounded border border-dashed border-border px-2 py-1 text-xs text-muted-foreground">
        [图片已省略]
        {alt ? ` ${alt}` : null}
        {srcStr ? (
          <span className="mt-0.5 block break-all font-mono opacity-80">
            {srcStr.length > 120 ? `${srcStr.slice(0, 120)}…` : srcStr}
          </span>
        ) : null}
      </span>
    );
  },
  /**
   * GFM 宽表在窄屏会撑破卡片；外包一层横向滚动。
   */
  table({ children }) {
    return (
      <div className="my-2 w-full max-w-full overflow-x-auto">
        <table className="w-max min-w-full border-collapse text-[0.95em]">
          {children}
        </table>
      </div>
    );
  },
};

/**
 * 渲染 LLM 输出的 feedback markdown。
 *
 * 为什么单独抽出来：
 * - `core/schemas.py:DimensionScore` 与 `web/lib/model-catalog.ts` 的 prompt
 *   都明确说 `feedback` 字段是 markdown，但前端两处（`grade/[id]` 详情抽屉、
 *   `results/[id]/students/[studentId]` 成绩单）以前都用 `whitespace-pre-wrap`
 *   把它当纯文本渲染，老师看到一堆 `**` / `-` 字符，体验很糟。
 * - 这里用 react-markdown + remark-gfm（GFM 表格 / 任务列表 / 删除线）。
 *   不开 `rehype-raw`，raw HTML 不会当 DOM 执行；同时自定义 `a` / `img` /
 *   `table`，避免模型用 markdown 链接触发导航或外链图片请求。
 *
 * 设计取舍：
 * - 不依赖 `@tailwindcss/typography` 的 `prose`：那套样式会强行覆盖颜色、
 *   字号，在 muted 背景 + 小字号的抽屉里不和谐。这里用 arbitrary descendant
 *   selectors 让 markdown 元素继承父容器的文字颜色 / 字号，只调"块之间的
 *   间距"和"列表缩进"。
 * - 同时兼容打印（`print:`）：父容器的打印样式（去背景 / 去边框）会自动透到
 *   markdown 元素上，不需要额外配。
 */
export function FeedbackMarkdown({ children, className }: Props) {
  return (
    <div
      className={cn(
        // 基础块间距：段落 / 列表 / 标题之间留呼吸
        // 用 :first-child / :last-child 对准「本容器直接子元素」，不要用
        // first: 修饰整段 [&>*]（那会匹配「父级里的第一个本 div」，通常永远不成立）
        "[&>*]:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        // 标题：相对当前字号轻度放大 + 加粗，不用 prose 的全局色覆盖
        "[&_h1]:mt-3 [&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold",
        "[&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-base [&_h2]:font-semibold",
        "[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:font-semibold",
        "[&_h4]:mt-2 [&_h4]:mb-1 [&_h4]:font-semibold",
        // 段落：保留行高
        "[&_p]:leading-relaxed",
        // 列表：左缩进 + 标记可见
        "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-0.5",
        "[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-0.5",
        "[&_li]:leading-relaxed marker:text-muted-foreground",
        // 强调
        "[&_strong]:font-semibold",
        "[&_em]:italic",
        // 行内代码 + 代码块
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em]",
        "[&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2",
        "[&_pre>code]:bg-transparent [&_pre>code]:p-0",
        // 引用块
        "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/30 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        // GFM 表格：具体 table 元素由 components.table 外包滚动层；这里只补 th/td
        "[&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium",
        "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
        // 分隔线
        "[&_hr]:my-3 [&_hr]:border-border",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
