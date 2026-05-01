-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WebSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "gradingProvider" TEXT NOT NULL DEFAULT 'qwen',
    "gradingModel" TEXT NOT NULL DEFAULT 'qwen3.6-plus',
    "enableSingleShot" BOOLEAN NOT NULL DEFAULT true,
    "gradingWithImage" BOOLEAN NOT NULL DEFAULT true,
    "gradingThinking" BOOLEAN NOT NULL DEFAULT false,
    "ocrProvider" TEXT NOT NULL DEFAULT 'qwen',
    "ocrModel" TEXT NOT NULL DEFAULT 'qwen3.6-plus',
    "ocrPrompt" TEXT,
    "gradingPrompt" TEXT,
    "singleShotPrompt" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WebSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WebSettings" ("createdAt", "enableSingleShot", "gradingModel", "gradingPrompt", "gradingProvider", "gradingThinking", "gradingWithImage", "id", "ocrModel", "ocrPrompt", "ocrProvider", "singleShotPrompt", "updatedAt", "userId") SELECT "createdAt", "enableSingleShot", "gradingModel", "gradingPrompt", "gradingProvider", "gradingThinking", "gradingWithImage", "id", "ocrModel", "ocrPrompt", "ocrProvider", "singleShotPrompt", "updatedAt", "userId" FROM "WebSettings";
DROP TABLE "WebSettings";
ALTER TABLE "new_WebSettings" RENAME TO "WebSettings";
CREATE UNIQUE INDEX "WebSettings_userId_key" ON "WebSettings"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
