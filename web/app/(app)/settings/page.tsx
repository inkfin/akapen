import { getWebSettings } from "@/lib/actions/settings";

import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const initial = await getWebSettings();
  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <div>
        <h1 className="text-xl font-semibold">设置</h1>
        <p className="text-sm text-[--color-muted-foreground]">
          这里配的 model / prompt / 行为开关只对 web 端的批改任务生效；demo Gradio
          UI 仍走 backend 自己的 <code>data/settings.json</code>。
          <br />
          API key（DashScope / Gemini）不在这里 —— 留在 backend 的{" "}
          <code>.env</code>，web 永远只通过请求把"模型 + prompt + 行为开关"递过去。
        </p>
      </div>
      <SettingsForm initial={initial} />
    </div>
  );
}
