// 占位 —— grade-ui 阶段会替换为「学生 × 题号」批改大盘。
export default function GradeIndexPage() {
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">批改大盘</h1>
      <p className="text-sm text-muted-foreground">
        请先去「作业批次」选一份作业再进入批改。
      </p>
    </div>
  );
}
