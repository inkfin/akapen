-- CreateTable
CREATE TABLE "WebSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "gradingProvider" TEXT NOT NULL DEFAULT 'qwen',
    "gradingModel" TEXT NOT NULL DEFAULT 'qwen3-vl-plus',
    "enableSingleShot" BOOLEAN NOT NULL DEFAULT true,
    "gradingWithImage" BOOLEAN NOT NULL DEFAULT true,
    "gradingThinking" BOOLEAN NOT NULL DEFAULT false,
    "ocrProvider" TEXT NOT NULL DEFAULT 'qwen',
    "ocrModel" TEXT NOT NULL DEFAULT 'qwen3-vl-plus',
    "ocrPrompt" TEXT,
    "gradingPrompt" TEXT,
    "singleShotPrompt" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WebSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "WebSettings_userId_key" ON "WebSettings"("userId");
