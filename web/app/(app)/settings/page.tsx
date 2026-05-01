import { getWebSettings } from "@/lib/actions/settings";

import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const initial = await getWebSettings();
  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <div>
        <h1 className="text-xl font-semibold">设置</h1>
        <p className="text-sm text-muted-foreground">
          这里配的内容**所有班级、所有作业批次共用**：模型、提示词框架、思考模式等。
          每道题的具体满分 / 给分点请在题目页填评分细则（rubric）。
        </p>
      </div>
      <SettingsForm initial={initial} />
    </div>
  );
}
