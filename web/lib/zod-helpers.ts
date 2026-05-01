import { z } from "zod";

/**
 * 给「FormData 来源 + 可选 + 留空 = 用默认」的字符串字段用的 zod helper。
 *
 * 必须用这个而不是 `z.string().optional().or(z.literal(""))`，因为后者**不接受
 * `null`**：当 `<input>` / `<Textarea>` 是条件渲染（藏在折叠 / details / 某个
 * 选项后面）的、用户没展开就提交时，`formData.get(name)` 返回的是 `null`，
 * 而不是 `""` 或 `undefined`。zod 会抛默认错误信息 "Invalid input"，前端表现
 * 为一个对老师毫无意义的英文报错。
 *
 * 用法：
 * ```ts
 * const schema = z.object({
 *   notes: optionalText(2000),
 *   customGradingPrompt: optionalText(16000),
 * });
 * ```
 *
 * 校验通过后，字段的类型是 `string`（永远不为 null/undefined），空串表示
 * 「老师没填」。落库时再 `value.trim() || null` 转回 NULL 即可。
 */
export function optionalText(maxLen: number) {
  return z.preprocess(
    (v) => (v === null || v === undefined ? "" : v),
    z.string().max(maxLen),
  );
}
