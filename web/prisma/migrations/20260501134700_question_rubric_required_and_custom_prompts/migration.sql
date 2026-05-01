-- 把 Question.rubric 从可选改成必填、加 customGradingPrompt / customSingleShotPrompt、
-- 删 Question.maxScore（不再用占位满分，每题在 rubric 里自己写"本题满分 X 分"）。

-- 1) 已有 rubric 为 NULL 的题目兜底，避免重建表时 NOT NULL 约束失败
UPDATE "Question" SET "rubric" = '请补充本题评分细则（满分、给分点、扣分项）' WHERE "rubric" IS NULL;

-- 2) SQLite 改列只能重建表（标准 prisma 风格 `RedefineTables`）
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Question" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "rubric" TEXT NOT NULL,
    "customGradingPrompt" TEXT,
    "customSingleShotPrompt" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Question_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "HomeworkBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Question" ("id", "batchId", "index", "prompt", "rubric", "createdAt")
SELECT "id", "batchId", "index", "prompt", "rubric", "createdAt" FROM "Question";

DROP TABLE "Question";
ALTER TABLE "new_Question" RENAME TO "Question";

CREATE UNIQUE INDEX "Question_batchId_index_key" ON "Question"("batchId", "index");
CREATE INDEX "Question_batchId_idx" ON "Question"("batchId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
