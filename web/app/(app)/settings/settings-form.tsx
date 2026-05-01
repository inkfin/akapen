"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  type WebSettingsView,
  updateWebSettingsAction,
  testAkapenConnectionAction,
} from "@/lib/actions/settings";
import {
  DEFAULT_PROMPT_GRADING,
  DEFAULT_PROMPT_OCR,
  DEFAULT_PROMPT_SINGLE_SHOT,
  GRADING_MODELS,
  OCR_MODELS,
  RUBRIC_PLACEHOLDER,
  findGradingModel,
  findOcrModel,
  isLikelyVisionModel,
  type ModelOption,
} from "@/lib/model-catalog";

const CUSTOM_OPTION_ID = "__custom__";

export function SettingsForm({ initial }: { initial: WebSettingsView }) {
  const [s, setS] = useState<WebSettingsView>(initial);
  const [pending, startTransition] = useTransition();
  const [testing, setTesting] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function update<K extends keyof WebSettingsView>(
    key: K,
    val: WebSettingsView[K],
  ) {
    setS((prev) => ({ ...prev, [key]: val }));
  }

  function onSave() {
    startTransition(async () => {
      const r = await updateWebSettingsAction(s);
      if (r.ok) toast.success("设置已保存");
      else toast.error(`保存失败：${r.error ?? "unknown"}`);
    });
  }

  async function onTest() {
    setTesting(true);
    try {
      const r = await testAkapenConnectionAction();
      if (r.ok) {
        toast.success("批改服务连接正常");
      } else {
        const parts: string[] = [];
        if (r.livez !== "ok") parts.push("批改服务无响应");
        if (r.auth === "bad_key") parts.push("服务密钥不匹配，请联系管理员");
        else if (r.auth !== "ok") parts.push("鉴权异常");
        if (r.detail) parts.push(r.detail);
        toast.error(`连接异常：${parts.join("；") || "未知错误"}`);
      }
    } finally {
      setTesting(false);
    }
  }

  // 当前批改模型在 catalog 里的 hit 信息（推荐 / 视觉徽章 / 注释 都用这个）
  const gradingHit = findGradingModel(s.gradingProvider, s.gradingModel);
  const gradingIsVision = isLikelyVisionModel(s.gradingProvider, s.gradingModel);
  const ocrHit = findOcrModel(s.ocrProvider, s.ocrModel);

  // 模型不是视觉的时候，OCR 兜底面板必然要展开（否则跑不出结果），自动展开高级
  const needOcrFallback = !gradingIsVision;

  return (
    <div className="space-y-4">
      {/* ────── 主区：批改模型 ────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">批改模型</CardTitle>
          <p className="text-xs text-muted-foreground">
            选一个视觉模型最省事，老师传图、模型直接打分。视觉模型旁边有「视觉」徽章。
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <ModelSelector
            options={GRADING_MODELS}
            current={{ provider: s.gradingProvider, model: s.gradingModel }}
            onPick={(opt) => {
              update("gradingProvider", opt.provider);
              update("gradingModel", opt.model);
            }}
          />
          {gradingHit?.note ? (
            <p className="rounded-md border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {gradingHit.note}
            </p>
          ) : null}
          {needOcrFallback ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
              选了纯文本模型，模型本身看不到图。批改时会先用「OCR
              兜底模型」把图转成文字再批改 ──
              请在下方<button
                type="button"
                className="mx-1 underline"
                onClick={() => setAdvancedOpen(true)}
              >
                高级设置
              </button>
              里确认 OCR 模型。
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ────── 主区：批改 prompt ────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">批改提示词模板</CardTitle>
          <p className="text-xs text-muted-foreground">
            这里写**评分流程、输出格式、评语风格**等所有题共用的部分；每道题的具体满分 /
            给分点请去题目页填「评分细则」。提示词中必须保留{" "}
            <code className="rounded bg-muted px-1 font-mono text-[11px]">
              {RUBRIC_PLACEHOLDER}
            </code>{" "}
            占位符，批改时会自动把当前题的评分细则填进来。
          </p>
        </CardHeader>
        <CardContent>
          <PromptField
            label={
              gradingIsVision
                ? "看图直接评分（视觉模型一次过）"
                : "看转写后的文字评分（文本模型两步批改）"
            }
            value={
              gradingIsVision ? s.singleShotPrompt : s.gradingPrompt
            }
            onChange={(v) =>
              update(
                gradingIsVision ? "singleShotPrompt" : "gradingPrompt",
                v,
              )
            }
            rows={10}
            requireRubric
            onReset={() => {
              if (gradingIsVision) {
                update("singleShotPrompt", DEFAULT_PROMPT_SINGLE_SHOT);
              } else {
                update("gradingPrompt", DEFAULT_PROMPT_GRADING);
              }
              toast.success("已重置为推荐模板（含 {rubric} 占位符）");
            }}
          />
        </CardContent>
      </Card>

      {/* ────── 高级 ────── */}
      <Card>
        <CardHeader className="cursor-pointer select-none" onClick={() => setAdvancedOpen((v) => !v)}>
          <CardTitle className="flex items-center gap-2 text-base">
            {advancedOpen ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
            高级设置
            <span className="text-xs font-normal text-muted-foreground">
              （思考模式、OCR 兜底、其他 prompt）
            </span>
          </CardTitle>
        </CardHeader>
        {advancedOpen ? (
          <CardContent className="space-y-5">
            <ToggleRow
              id="grading-thinking"
              label="启用思考模式"
              hint="部分模型支持深度思考（qwen3-vl-thinking、gemini-2.5-pro 等）；不支持的会自动忽略。开了之后批改更慢但更准。"
              checked={s.gradingThinking}
              onChange={(v) => update("gradingThinking", v)}
            />

            <div className="space-y-3 rounded-md border p-3">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">OCR 兜底模型</h3>
                <p className="text-xs text-muted-foreground">
                  当批改模型是纯文本时，需要先用 OCR
                  把图转成文字。这里选的模型必须能看图（视觉）。
                  {gradingIsVision ? (
                    <>
                      <br />
                      <span className="text-emerald-600 dark:text-emerald-400">
                        当前批改模型是视觉的，这个设置用不到 ── 但保留，方便切换。
                      </span>
                    </>
                  ) : null}
                </p>
              </div>
              <ModelSelector
                options={OCR_MODELS}
                current={{ provider: s.ocrProvider, model: s.ocrModel }}
                onPick={(opt) => {
                  update("ocrProvider", opt.provider);
                  update("ocrModel", opt.model);
                }}
              />
              {ocrHit?.note ? (
                <p className="text-xs text-muted-foreground">{ocrHit.note}</p>
              ) : null}
              <PromptField
                label="OCR 提示词"
                value={s.ocrPrompt}
                onChange={(v) => update("ocrPrompt", v)}
                rows={4}
                onReset={() => {
                  update("ocrPrompt", DEFAULT_PROMPT_OCR);
                  toast.success("已重置为推荐模板");
                }}
              />
            </div>

            {/* 视觉模型也保留两步模式的 prompt（手动想用 OCR + 批改两步时用） */}
            {gradingIsVision ? (
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  两步批改提示词（少数老师才用）
                </summary>
                <p className="mt-2 mb-3 text-xs text-muted-foreground">
                  当前用的是视觉模型一次过的方式，不会用到这条；保留是为了切到文本模型两步批改时不丢配置。
                </p>
                <PromptField
                  label="批改提示词（两步批改）"
                  value={s.gradingPrompt}
                  onChange={(v) => update("gradingPrompt", v)}
                  rows={6}
                  requireRubric
                  onReset={() => {
                    update("gradingPrompt", DEFAULT_PROMPT_GRADING);
                    toast.success("已重置");
                  }}
                />
              </details>
            ) : null}
          </CardContent>
        ) : null}
      </Card>

      {/* ────── 操作栏 ────── */}
      <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t bg-background px-4 py-3 md:mx-0 md:rounded-md md:border">
        <Button variant="outline" onClick={onTest} disabled={testing}>
          {testing ? "测试中…" : "测试服务连接"}
        </Button>
        <Button onClick={onSave} disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  );
}

// ───── 模型选择器（合并 provider+model 成单 select；带视觉/文本徽章 + 自定义） ─────

function ModelSelector({
  options,
  current,
  onPick,
}: {
  options: ModelOption[];
  current: { provider: string; model: string };
  onPick: (next: { provider: string; model: string }) => void;
}) {
  const matchedId = useMemo(() => {
    const hit = options.find(
      (o) => o.provider === current.provider && o.model === current.model,
    );
    return hit?.id ?? CUSTOM_OPTION_ID;
  }, [options, current.provider, current.model]);

  const isCustom = matchedId === CUSTOM_OPTION_ID;

  return (
    <div className="space-y-2">
      <Label className="text-xs">选择模型</Label>
      <select
        className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        value={matchedId}
        onChange={(e) => {
          const id = e.target.value;
          if (id === CUSTOM_OPTION_ID) return;
          const opt = options.find((o) => o.id === id);
          if (opt) onPick(opt);
        }}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
            {o.recommended ? "  ★推荐" : ""}
            {o.vision ? "  [视觉]" : "  [文本]"}
          </option>
        ))}
        <option value={CUSTOM_OPTION_ID}>── 自定义模型 ──</option>
      </select>

      {/* 当前选中的徽章（不在 select 里，因为 native select 不支持富内容） */}
      <div className="flex flex-wrap items-center gap-1.5">
        {isCustom ? (
          <Badge variant="outline">自定义</Badge>
        ) : (
          (() => {
            const hit = options.find((o) => o.id === matchedId)!;
            return (
              <>
                <Badge variant={hit.vision ? "success" : "secondary"}>
                  {hit.vision ? "视觉" : "文本"}
                </Badge>
                {hit.recommended ? (
                  <Badge variant="info">推荐</Badge>
                ) : null}
              </>
            );
          })()
        )}
      </div>

      {/* 自定义模式：让用户填 provider + model */}
      {isCustom ? (
        <div className="grid grid-cols-2 gap-2 rounded-md border p-3">
          <div className="space-y-1">
            <Label className="text-xs">provider</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              value={current.provider}
              onChange={(e) => onPick({ provider: e.target.value, model: current.model })}
            >
              <option value="qwen">qwen</option>
              <option value="gemini">gemini</option>
              <option value="claude">claude</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">model id</Label>
            <Input
              value={current.model}
              onChange={(e) => onPick({ provider: current.provider, model: e.target.value })}
              placeholder="e.g. qwen3-vl-plus-2025-09-23"
            />
          </div>
          <p className="col-span-2 text-xs text-muted-foreground">
            粘贴自定义模型 ID（如 <code>qwen3-vl-plus-2025-09-23</code>）。
            需要后台已经开通对应模型才能跑通；不确定可以先点上面「测试服务连接」。
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ───── helpers ─────

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex items-start gap-3 rounded-md border p-3 ${disabled ? "opacity-60" : ""}`}
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        disabled={disabled}
      />
      <div className="flex-1 space-y-0.5">
        <Label htmlFor={id} className="cursor-pointer text-sm">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function PromptField({
  label,
  value,
  onChange,
  rows,
  onReset,
  requireRubric,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
  onReset?: () => void;
  /** 非空时必须包含 {rubric} 占位符。空串 OK（= 走 backend 默认）。 */
  requireRubric?: boolean;
}) {
  const missingRubric =
    !!requireRubric &&
    value.length > 0 &&
    !value.includes(RUBRIC_PLACEHOLDER);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {value.length} / 16000
          </span>
          {onReset ? (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={onReset}
            >
              重置为推荐模板
            </button>
          ) : null}
        </div>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder="留空 = 用默认模板"
        className="font-mono text-xs"
        aria-invalid={missingRubric}
      />
      {missingRubric ? (
        <p className="text-xs text-destructive">
          缺少 <code className="font-mono">{RUBRIC_PLACEHOLDER}</code>{" "}
          占位符。保存会被拒绝 ── 点上方「重置为推荐模板」可以一键修复。
        </p>
      ) : null}
    </div>
  );
}
