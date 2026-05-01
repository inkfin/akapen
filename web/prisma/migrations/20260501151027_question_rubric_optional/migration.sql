-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Question" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "rubric" TEXT,
    "customGradingPrompt" TEXT,
    "customSingleShotPrompt" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Question_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "HomeworkBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Question" ("batchId", "createdAt", "customGradingPrompt", "customSingleShotPrompt", "id", "index", "prompt", "rubric") SELECT "batchId", "createdAt", "customGradingPrompt", "customSingleShotPrompt", "id", "index", "prompt", "rubric" FROM "Question";
DROP TABLE "Question";
ALTER TABLE "new_Question" RENAME TO "Question";
CREATE INDEX "Question_batchId_idx" ON "Question"("batchId");
CREATE UNIQUE INDEX "Question_batchId_index_key" ON "Question"("batchId", "index");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
