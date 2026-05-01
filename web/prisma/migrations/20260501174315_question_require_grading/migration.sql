-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Question" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "requireGrading" BOOLEAN NOT NULL DEFAULT true,
    "rubric" TEXT,
    "feedbackGuide" TEXT,
    "customGradingPrompt" TEXT,
    "customSingleShotPrompt" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Question_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "HomeworkBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- backfill requireGrading: 之前用"rubric 留空"隐式表示"不打分"，
-- 这里把同样的语义固化到新列：rubric 为 NULL 或纯空白 → requireGrading=false。
INSERT INTO "new_Question" ("batchId", "createdAt", "customGradingPrompt", "customSingleShotPrompt", "feedbackGuide", "id", "index", "prompt", "requireGrading", "rubric")
SELECT
    "batchId",
    "createdAt",
    "customGradingPrompt",
    "customSingleShotPrompt",
    "feedbackGuide",
    "id",
    "index",
    "prompt",
    CASE WHEN "rubric" IS NULL OR TRIM("rubric") = '' THEN 0 ELSE 1 END AS "requireGrading",
    "rubric"
FROM "Question";
DROP TABLE "Question";
ALTER TABLE "new_Question" RENAME TO "Question";
CREATE INDEX "Question_batchId_idx" ON "Question"("batchId");
CREATE UNIQUE INDEX "Question_batchId_index_key" ON "Question"("batchId", "index");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
