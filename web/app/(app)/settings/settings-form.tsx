"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

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
  GRADING_PROVIDERS,
  OCR_PROVIDERS,
  isLikelyVisionModel,
  modelsFor,
} from "@/lib/model-catalog";

export function SettingsForm({ initial }: { initial: WebSettingsView }) {
  const [s, setS] = useState<WebSettingsView>(initial);
  const [pending, startTransition] = useTransition();
  const [testing, setTesting] = useState(false);

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
        toast.success("akapen 连通正常 + API key 鉴权通过");
      } else {
        const parts: string[] = [];
        if (r.livez !== "ok") parts.push("livez 失败");
        if (r.auth === "bad_key") parts.push("API key 错");
        else if (r.auth !== "ok") parts.push("鉴权异常");
        if (r.detail) parts.push(r.detail);
        toast.error(`连接异常：${parts.join("；") || "unknown"}`);
      }
    } finally {
      setTesting(false);
    }
  }

  const gradingIsVision = isLikelyVisionModel(s.gradingModel);
  const ocrIsVision = isLikelyVisionModel(s.ocrModel);

  return (
    <div className="space-y-4">
      {/* ────── 模型选择 ────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">批改 / 转写模型</CardTitle>
          <p className="text-xs text-[--color-muted-foreground]">
            下拉给的是常见模型；找不到的可以直接键入快照名（如{" "}
            <code>qwen3-vl-plus-2025-09-23</code>）。模型名 backend 不做白名单校验，
            但 provider 必须是已注册的。
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <ProviderModelRow
              labelPrefix="批改"
              providerOptions={GRADING_PROVIDERS}
              modelOptions={modelsFor(s.gradingProvider, "grading")}
              provider={s.gradingProvider}
              model={s.gradingModel}
              onProvider={(v) => update("gradingProvider", v)}
              onModel={(v) => update("gradingModel", v)}
              hint={
                gradingIsVision
                  ? "✓ 视觉模型，可走 single-shot（看图直出 JSON）"
                  : "⚠ 推测为纯文本模型，single-shot 会自动退化为两步"
              }
            />
            <ProviderModelRow
              labelPrefix="OCR"
              providerOptions={OCR_PROVIDERS}
              modelOptions={modelsFor(s.ocrProvider, "ocr")}
              provider={s.ocrProvider}
              model={s.ocrModel}
              onProvider={(v) => update("ocrProvider", v)}
              onModel={(v) => update("ocrModel", v)}
              hint={
                ocrIsVision
                  ? "✓ 视觉模型，可识别学生手写图"
                  : "⚠ OCR 必须用视觉模型，非视觉会直接挂"
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* ────── 行为开关 ────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">批改行为</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ToggleRow
            id="enable-single-shot"
            label="single-shot：一次调用同时转写 + 评分"
            hint="批改模型是视觉模型时建议开。带宽 / 延迟最优。"
            checked={s.enableSingleShot}
            onChange={(v) => update("enableSingleShot", v)}
          />
          <ToggleRow
            id="grading-with-image"
            label="两步模式下批改阶段也带图（vision 批改）"
            hint="single-shot 关闭时才生效。带图能让模型对照原图修正 OCR 错误，但带宽 ×2。"
            checked={s.gradingWithImage}
            onChange={(v) => update("gradingWithImage", v)}
            disabled={s.enableSingleShot}
          />
          <ToggleRow
            id="grading-thinking"
            label="批改启用思考模式（thinking）"
            hint="部分模型支持（qwen3-vl-thinking、gemini-2.5-pro 等）；不支持的会自动忽略。"
            checked={s.gradingThinking}
            onChange={(v) => update("gradingThinking", v)}
          />
        </CardContent>
      </Card>

      {/* ────── Prompts ────── */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <CardTitle className="text-base">自定义 prompts</CardTitle>
              <p className="mt-1 text-xs text-[--color-muted-foreground]">
                默认预填的是「中文作文 100 分」推荐模板（schema-correct）。
                想改格式 / 评分细则就改下面对应栏。每段 ≤ 16,000 字符。
                <br />
                清空某栏后保存 = 存 NULL，那次跑批改时 backend 会退回到{" "}
                <code>prompts/*.md</code> 默认（注意：默认是日语作文 30 分模板，
                schema 不一定匹配新作文类型）。
                <br />
                模板里可以用 <code>{"{student_name}"}</code> /{" "}
                <code>{"{student_id}"}</code> /{" "}
                <code>{"{transcription}"}</code>（OCR 草稿）/{" "}
                <code>{"{ocr_review_block}"}</code> 占位符；
                题干会被 backend 自动拼到 prompt 顶部。
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                update("singleShotPrompt", DEFAULT_PROMPT_SINGLE_SHOT);
                update("ocrPrompt", DEFAULT_PROMPT_OCR);
                update("gradingPrompt", DEFAULT_PROMPT_GRADING);
                toast.success("已重置为推荐模板（中文作文 100 分）");
              }}
            >
              重置为推荐模板
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <PromptField
            label="single-shot prompt（看图同时转写 + 评分）"
            value={s.singleShotPrompt}
            onChange={(v) => update("singleShotPrompt", v)}
            rows={8}
          />
          <PromptField
            label="OCR prompt（仅两步模式用）"
            value={s.ocrPrompt}
            onChange={(v) => update("ocrPrompt", v)}
            rows={5}
          />
          <PromptField
            label="批改 prompt（仅两步模式用）"
            value={s.gradingPrompt}
            onChange={(v) => update("gradingPrompt", v)}
            rows={8}
          />
        </CardContent>
      </Card>

      {/* ────── 操作栏 ────── */}
      <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t bg-[--color-background] px-4 py-3 md:mx-0 md:rounded-md md:border">
        <Button variant="outline" onClick={onTest} disabled={testing}>
          {testing ? "测试中…" : "测试 akapen 连接"}
        </Button>
        <Button onClick={onSave} disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  );
}

function ProviderModelRow({
  labelPrefix,
  providerOptions,
  modelOptions,
  provider,
  model,
  onProvider,
  onModel,
  hint,
}: {
  labelPrefix: string;
  providerOptions: readonly string[];
  modelOptions: readonly string[];
  provider: string;
  model: string;
  onProvider: (v: string) => void;
  onModel: (v: string) => void;
  hint: string;
}) {
  const datalistId = `dl-${labelPrefix}-${Math.random().toString(36).slice(2, 7)}`;
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">{labelPrefix} provider</Label>
          <select
            className="h-9 w-full rounded-md border border-[--color-input] bg-transparent px-2 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-[--color-ring] focus-visible:outline-none"
            value={provider}
            onChange={(e) => onProvider(e.target.value)}
          >
            {providerOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{labelPrefix} model</Label>
          <Input
            list={datalistId}
            value={model}
            onChange={(e) => onModel(e.target.value)}
            placeholder="e.g. qwen3-vl-plus"
          />
          <datalist id={datalistId}>
            {modelOptions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      </div>
      <p className="text-xs text-[--color-muted-foreground]">{hint}</p>
    </div>
  );
}

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
        <p className="text-xs text-[--color-muted-foreground]">{hint}</p>
      </div>
    </div>
  );
}

function PromptField({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="text-xs text-[--color-muted-foreground]">
          {value.length} / 16000
        </span>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder="留空 = 用 backend 默认"
        className="font-mono text-xs"
      />
    </div>
  );
}
