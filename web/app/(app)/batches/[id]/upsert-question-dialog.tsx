"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { ChevronDown, ChevronRight, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { upsertQuestionAction } from "@/lib/actions/batches";

function Submit({ existing }: { existing?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "保存中..." : existing ? "保存修改" : "添加"}
    </Button>
  );
}

type Existing = {
  id: string;
  index: number;
  prompt: string;
  rubric: string | null;
  feedbackGuide: string | null;
  customGradingPrompt: string | null;
  customSingleShotPrompt: string | null;
};

// 单一 placeholder 只能放一个题型示例；丰富示例靠下面的折叠展开。
// 这里挑作文，因为它最复杂、最能展示"分维度 + 扣分项"完整结构。
const RUBRIC_PLACEHOLDER_TEXT = `示例：

本题满分 30 分。
- 立意紧扣题目（10 分）：是否回答了题目要求；论点是否清晰
- 论据 / 例证（10 分）：列举的事例是否真实；与论点是否相关
- 语言表达（10 分）：用词、语法、句式

严重跑题（题目要点完全未涉及）→ 立意维度最多 3 分，总分一般不超过 10。

留空 = 模型只给修改建议、不打分。`;

// 修改意见栏的 placeholder。给老师写"想让模型怎么写 feedback"的具体例子。
const FEEDBACK_GUIDE_PLACEHOLDER_TEXT = `示例：

- 用鼓励性的语气，先肯定一处具体的优点；
- 重点指出语法 / 用词错误，引用学生原句说明；
- 按段落分点给意见，每段不超过 3 句话；
- 结尾给一句总评（不超过 30 字）。

留空 = 用通用默认指南（覆盖内容 / 结构 / 语言 / 语法常见问题）。`;

// 题型快速参考。按"复杂度从低到高"排，老师扫一眼能找到自己题型最接近的写法。
const RUBRIC_EXAMPLES: { title: string; body: string }[] = [
  {
    title: "选择题",
    body: `标准答案：B。
- 选对 5 分
- 选错 / 未作答 0 分`,
  },
  {
    title: "填空题",
    body: `本题满分 6 分，三空各 2 分。
答案：① 水    ② 氢气    ③ 2H₂ + O₂ = 2H₂O
- 每空答对得满分；错别字 / 化学式书写不规范扣 0.5 分`,
  },
  {
    title: "默写 / 背诵",
    body: `本题满分 10 分。
原文：床前明月光，疑是地上霜，举头望明月，低头思故乡。
- 全句完全正确得 10 分
- 每错一字扣 1 分；缺一句扣 2 分
- 标点不计分`,
  },
  {
    title: "简答 / 应用题",
    body: `本题满分 12 分，按以下要点给分：
- 写出公式（2 分）
- 代入正确数值（4 分）
- 计算过程清晰（4 分）
- 结论正确并标明单位（2 分）

只有最终答案、没有过程 → 最多得 4 分。`,
  },
  {
    title: "续写 / 创意写作",
    body: `本题满分 15 分。
- 情节连贯（5 分）：与原文衔接自然
- 风格一致（5 分）：人物、语言风格保持
- 创意 / 表达（5 分）：有亮点 / 用词得当`,
  },
  {
    title: "作文 / 论述",
    body: `本题满分 30 分。
- 立意紧扣题目（10 分）
- 论据 / 例证（10 分）
- 语言表达（10 分）

严重跑题 → 立意维度最多 3 分。`,
  },
  {
    title: "只批注 · 不打分",
    body: `（rubric 留空就行 —— 模型会只输出修改建议、不给分。
适合开放作文、写作辅导这类没有标准答案的题。）`,
  },
];

export function UpsertQuestionDialog({
  batchId,
  defaultIndex,
  existing,
}: {
  batchId: string;
  defaultIndex: number;
  existing?: Existing;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(upsertQuestionAction, undefined);
  const [advancedOpen, setAdvancedOpen] = useState(
    !!(existing?.customGradingPrompt || existing?.customSingleShotPrompt),
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success(existing ? "已保存修改" : "题目已添加");
      setOpen(false);
    } else if (state?.error) {
      toast.error(state.error);
    }
  }, [state, existing]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {existing ? (
          <Button variant="ghost" size="icon" aria-label="编辑题目">
            <Pencil className="size-4" />
          </Button>
        ) : (
          <Button>
            <Plus className="size-4" /> 添加题目
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{existing ? `编辑第 ${existing.index} 题` : "添加题目"}</DialogTitle>
          <DialogDescription>
            题干会和下面两栏（给分细则 / 修改意见）一起送给 LLM。两栏都是可选的：
            <strong>给分</strong>留空 → 不打分；<strong>修改意见</strong>留空 → 用通用默认。
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="grid gap-4">
          <input type="hidden" name="batchId" value={batchId} />
          <div className="grid gap-2">
            <Label htmlFor="index">题号</Label>
            <Input
              id="index"
              name="index"
              type="number"
              min={1}
              max={99}
              required
              defaultValue={existing?.index ?? defaultIndex}
              className="max-w-32"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="prompt">题干 *</Label>
            <Textarea
              id="prompt"
              name="prompt"
              required
              rows={3}
              defaultValue={existing?.prompt ?? ""}
              placeholder="请用 200 字以内描述「家乡的秋天」"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rubric">
              给分细则{" "}
              <span className="text-xs font-normal text-muted-foreground">
                可选 · 留空 = 不打分（只批注）
              </span>
            </Label>
            <Textarea
              id="rubric"
              name="rubric"
              rows={6}
              defaultValue={existing?.rubric ?? ""}
              placeholder={RUBRIC_PLACEHOLDER_TEXT}
            />
            <p className="text-xs text-muted-foreground">
              写明本题<strong>满分多少、给分点 / 扣分项</strong>。不同题型（作文、选择、填空、默写、计算…）各写各的。
              <br />
              留空 = 模型只输出修改建议、不打分（适合开放作文、写作辅导这类没标准答案的题）。
            </p>
            <details className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium">
                查看不同题型的写法示例（点击展开）
              </summary>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {RUBRIC_EXAMPLES.map((ex) => (
                  <div key={ex.title} className="rounded-md border bg-background p-2">
                    <div className="mb-1 font-medium">{ex.title}</div>
                    <pre className="font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
                      {ex.body}
                    </pre>
                  </div>
                ))}
              </div>
            </details>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="feedbackGuide">
              修改意见{" "}
              <span className="text-xs font-normal text-muted-foreground">
                可选 · 留空 = 用通用默认指南
              </span>
            </Label>
            <Textarea
              id="feedbackGuide"
              name="feedbackGuide"
              rows={5}
              defaultValue={existing?.feedbackGuide ?? ""}
              placeholder={FEEDBACK_GUIDE_PLACEHOLDER_TEXT}
            />
            <p className="text-xs text-muted-foreground">
              告诉模型<strong>怎么给学生写反馈</strong>：关注哪些方面、用什么语气、要不要分点、要不要先肯定优点等。
              <br />
              留空 = 用通用默认（覆盖内容 / 结构 / 语言 / 语法常见问题，专业中立的语气）。
              和「给分细则」<strong>独立</strong>，可以"打分但用默认 feedback"，也可以"不打分但 feedback 有自定义指引"。
            </p>
          </div>

          {/* ─── 高级：覆盖全局 prompt ─── */}
          <div className="rounded-md border">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center gap-2 p-3 text-left text-sm font-medium"
            >
              {advancedOpen ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
              高级：单题自定义 prompt（极少需要）
            </button>
            {advancedOpen ? (
              <div className="space-y-4 border-t p-3">
                <p className="text-xs text-muted-foreground">
                  下面两栏留空就好，会自动用「设置」里的全局批改提示词 + 本题评分要求组合。
                  只有当本题需要**完全独立**的提示词（比如全局模板根本不适用）时，才往下面填东西 ——
                  填了之后会**整段替换**全局提示词。
                </p>
                <div className="grid gap-2">
                  <Label htmlFor="customSingleShotPrompt" className="text-xs">
                    自定义提示词 · 视觉模型一次过
                  </Label>
                  <Textarea
                    id="customSingleShotPrompt"
                    name="customSingleShotPrompt"
                    rows={6}
                    defaultValue={existing?.customSingleShotPrompt ?? ""}
                    placeholder="留空（推荐）"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="customGradingPrompt" className="text-xs">
                    自定义提示词 · 文本模型两步批改
                  </Label>
                  <Textarea
                    id="customGradingPrompt"
                    name="customGradingPrompt"
                    rows={6}
                    defaultValue={existing?.customGradingPrompt ?? ""}
                    placeholder="留空（推荐）"
                    className="font-mono text-xs"
                  />
                </div>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Submit existing={!!existing} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
