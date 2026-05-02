import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

type Props = {
  /** 模型给学生写的 feedback / 评语，markdown 源文本。 */
  children: string;
  /** 外层容器 className（颜色 / 边框 / padding 等）。 */
  className?: string;
};

/**
 * 渲染 LLM 输出的 feedback markdown。
 *
 * 为什么单独抽出来：
 * - `core/schemas.py:DimensionScore` 与 `web/lib/model-catalog.ts` 的 prompt
 *   都明确说 `feedback` 字段是 markdown，但前端两处（`grade/[id]` 详情抽屉、
 *   `results/[id]/students/[studentId]` 成绩单）以前都用 `whitespace-pre-wrap`
 *   把它当纯文本渲染，老师看到一堆 `**` / `-` 字符，体验很糟。
 * - 这里直接用 react-markdown + remark-gfm（GFM 表格 / 任务列表 / 删除线），
 *   `safe` 模式（默认不 raw HTML），避免 LLM 输出被注入 script。
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
        "[&>*]:my-1 first:[&>*]:mt-0 last:[&>*]:mb-0",
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
        // GFM 表格
        "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[0.95em]",
        "[&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium",
        "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
        // 链接
        "[&_a]:text-sky-600 [&_a]:underline-offset-2 hover:[&_a]:underline dark:[&_a]:text-sky-400",
        // 分隔线
        "[&_hr]:my-3 [&_hr]:border-border",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // 不开 rehype-raw —— LLM 输出的 raw HTML 必须当字面量显示，
        // 防御 prompt injection 嵌入 <script> / <iframe>。
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
