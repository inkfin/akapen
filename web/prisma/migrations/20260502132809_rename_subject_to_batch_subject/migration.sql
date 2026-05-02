-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_HomeworkBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "batchSubject" TEXT,
    "batchObjective" TEXT,
    "dueDate" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HomeworkBatch_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HomeworkBatch_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_HomeworkBatch" ("batchObjective", "batchSubject", "classId", "createdAt", "dueDate", "id", "notes", "ownerId", "title", "updatedAt") SELECT "batchObjective", "subject", "classId", "createdAt", "dueDate", "id", "notes", "ownerId", "title", "updatedAt" FROM "HomeworkBatch";
DROP TABLE "HomeworkBatch";
ALTER TABLE "new_HomeworkBatch" RENAME TO "HomeworkBatch";
CREATE INDEX "HomeworkBatch_classId_idx" ON "HomeworkBatch"("classId");
CREATE INDEX "HomeworkBatch_ownerId_idx" ON "HomeworkBatch"("ownerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
