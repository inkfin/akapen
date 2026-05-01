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
          这里配的内容**所有班级、所有作业批次共用**：批改用的模型 / 思考模式 / OCR 兜底等。
          <br />
          题型相关的内容（满分、答案、给分点 / 扣分项）请在每道题里填「评分要求」 ──
          全局提示词模板只是个通用框架，绝大多数老师不需要改。
        </p>
      </div>
      <SettingsForm initial={initial} />
    </div>
  );
}
