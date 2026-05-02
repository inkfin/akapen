-- AlterTable
ALTER TABLE "HomeworkBatch" ADD COLUMN "batchObjective" TEXT;
ALTER TABLE "HomeworkBatch" ADD COLUMN "subject" TEXT;

-- AlterTable
ALTER TABLE "WebSettings" ADD COLUMN "defaultPersona" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GradingTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "parentId" TEXT,
    "akapenTaskId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mode" TEXT NOT NULL DEFAULT 'grade',
    "actionType" TEXT NOT NULL DEFAULT 'grade',
    "teacherInstruction" TEXT,
    "promptSuggestion" TEXT,
    "result" TEXT,
    "finalScore" REAL,
    "maxScore" REAL,
    "reviewFlag" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GradingTask_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "GradingTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "GradingTask_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_GradingTask" ("akapenTaskId", "attempts", "createdAt", "errorCode", "errorMessage", "finalScore", "id", "idempotencyKey", "maxScore", "result", "reviewFlag", "revision", "status", "submissionId", "updatedAt") SELECT "akapenTaskId", "attempts", "createdAt", "errorCode", "errorMessage", "finalScore", "id", "idempotencyKey", "maxScore", "result", "reviewFlag", "revision", "status", "submissionId", "updatedAt" FROM "GradingTask";
DROP TABLE "GradingTask";
ALTER TABLE "new_GradingTask" RENAME TO "GradingTask";
CREATE UNIQUE INDEX "GradingTask_akapenTaskId_key" ON "GradingTask"("akapenTaskId");
CREATE UNIQUE INDEX "GradingTask_idempotencyKey_key" ON "GradingTask"("idempotencyKey");
CREATE INDEX "GradingTask_submissionId_idx" ON "GradingTask"("submissionId");
CREATE INDEX "GradingTask_parentId_idx" ON "GradingTask"("parentId");
CREATE INDEX "GradingTask_status_idx" ON "GradingTask"("status");
CREATE INDEX "GradingTask_actionType_idx" ON "GradingTask"("actionType");
CREATE INDEX "GradingTask_akapenTaskId_idx" ON "GradingTask"("akapenTaskId");
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
    "thinkingOverride" TEXT,
    "provideModelAnswer" BOOLEAN NOT NULL DEFAULT false,
    "modelAnswerGuide" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Question_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "HomeworkBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Question" ("batchId", "createdAt", "customGradingPrompt", "customSingleShotPrompt", "feedbackGuide", "id", "index", "prompt", "requireGrading", "rubric") SELECT "batchId", "createdAt", "customGradingPrompt", "customSingleShotPrompt", "feedbackGuide", "id", "index", "prompt", "requireGrading", "rubric" FROM "Question";
DROP TABLE "Question";
ALTER TABLE "new_Question" RENAME TO "Question";
CREATE INDEX "Question_batchId_idx" ON "Question"("batchId");
CREATE UNIQUE INDEX "Question_batchId_index_key" ON "Question"("batchId", "index");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
