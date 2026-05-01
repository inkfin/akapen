import { prisma } from "@/lib/db";

/**
 * 给批改大盘准备一份"结构化全图"。
 *
 * 输出形态（前端把它扁平化成 cells 矩阵）：
 *   - students: [{ id, externalId, name }]
 *   - questions: [{ id, index, prompt, maxScore }]
 *   - cells: { [questionId]: { [studentId]: CellState } }
 *
 * CellState 是 UI 关心的全部状态。重批之间的多版本 GradingTask 在这里只展示
 * 「最新一条」（按 revision desc），历史版本在详情抽屉里再展开。
 */

export type CellState = {
  submissionId: string | null;
  imageCount: number;
  imagePaths: string[];
  latest: {
    gradingTaskId: string;
    akapenTaskId: string | null;
    status: string;
    revision: number;
    finalScore: number | null;
    // LLM 评分时实际用的满分（来自 result.max_score）；UI 显示优先用这个，
    // null（未批改 / 任务挂了）时回退到 question.maxScore
    maxScore: number | null;
    reviewFlag: boolean;
    errorCode: string | null;
    errorMessage: string | null;
    updatedAt: string; // ISO
  } | null;
};

export type GradeBoardData = {
  batchId: string;
  batchTitle: string;
  className: string;
  students: { id: string; externalId: string; name: string }[];
  questions: {
    id: string;
    index: number;
    prompt: string;
    maxScore: number;
  }[];
  cells: Record<string, Record<string, CellState>>;
};

function safeArr(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function loadGradeBoard(
  batchId: string,
  ownerId: string,
): Promise<GradeBoardData | null> {
  const batch = await prisma.homeworkBatch.findFirst({
    where: { id: batchId, ownerId },
    include: {
      class: {
        include: { students: { orderBy: { externalId: "asc" } } },
      },
      questions: { orderBy: { index: "asc" } },
    },
  });
  if (!batch) return null;

  const submissions = await prisma.submission.findMany({
    where: { questionId: { in: batch.questions.map((q) => q.id) } },
    include: {
      gradings: { orderBy: { revision: "desc" }, take: 1 },
    },
  });

  const subByKey = new Map<string, (typeof submissions)[number]>();
  for (const s of submissions) {
    subByKey.set(`${s.questionId}::${s.studentId}`, s);
  }

  const cells: GradeBoardData["cells"] = {};
  for (const q of batch.questions) {
    cells[q.id] = {};
    for (const s of batch.class.students) {
      const sub = subByKey.get(`${q.id}::${s.id}`);
      const latest = sub?.gradings[0];
      cells[q.id][s.id] = {
        submissionId: sub?.id ?? null,
        imageCount: sub ? safeArr(sub.imagePaths).length : 0,
        imagePaths: sub ? safeArr(sub.imagePaths) : [],
        latest: latest
          ? {
              gradingTaskId: latest.id,
              akapenTaskId: latest.akapenTaskId,
              status: latest.status,
              revision: latest.revision,
              finalScore: latest.finalScore,
              maxScore: latest.maxScore,
              reviewFlag: latest.reviewFlag,
              errorCode: latest.errorCode,
              errorMessage: latest.errorMessage,
              updatedAt: latest.updatedAt.toISOString(),
            }
          : null,
      };
    }
  }

  return {
    batchId: batch.id,
    batchTitle: batch.title,
    className: batch.class.name,
    students: batch.class.students.map((s) => ({
      id: s.id,
      externalId: s.externalId,
      name: s.name,
    })),
    questions: batch.questions.map((q) => ({
      id: q.id,
      index: q.index,
      prompt: q.prompt,
      maxScore: q.maxScore,
    })),
    cells,
  };
}
