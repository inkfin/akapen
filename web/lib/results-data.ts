import { prisma } from "@/lib/db";
import {
  parseGradingResult,
  type ParsedGradingResult,
} from "@/lib/grading-result";

/**
 * 成绩页（/results 与 /results/[id]）的数据装载层。
 *
 * 这里只装载**汇总/聚合**视图，不参与"动手批改"——交互（重批 / 重试 / 详情抽屉）
 * 一律走 `/grade/[id]`。所以这里读到的数据可以做更激进的服务端预聚合，前端
 * 直接 render 静态卡片 / 表格，无需轮询。
 *
 * 复用 `prisma.questions` 出来的 `requireGrading` 字段过滤"非打分题"——
 * 只对 requireGrading=true 的题统计分数；requireGrading=false 的题只显示
 * "已批注 / 未批注"两态，不参与排序和平均分。
 */

// ─────────── 列表页（/results） ───────────

export type ResultsListBatch = {
  id: string;
  title: string;
  questionCount: number;
  studentCount: number;
  // 已批改完成的 (student × question, requireGrading=true) 占总应批的比例（0~1）
  completion: number;
  // 全部 succeeded 任务里的平均分（百分比，0~100），没题可统计 → null
  averagePercent: number | null;
  needsReviewCount: number;
  updatedAt: string;
};

export type ResultsListGroup = {
  classId: string;
  className: string;
  batches: ResultsListBatch[];
};

export async function loadResultsList(
  ownerId: string,
): Promise<ResultsListGroup[]> {
  // 一次性把"老师名下所有 batch + 关联实体的 ID"取齐，再一次性补统计。
  // 不用 N+1：成绩页是个偏只读、需要数据集成的页面。
  const batches = await prisma.homeworkBatch.findMany({
    where: { ownerId },
    orderBy: [{ createdAt: "desc" }],
    include: {
      class: { select: { id: true, name: true } },
      questions: { select: { id: true, requireGrading: true } },
      _count: { select: { questions: true } },
    },
  });
  if (batches.length === 0) return [];

  // 学生数：按 class 缓存，不为每个 batch 重查
  const classIds = Array.from(new Set(batches.map((b) => b.classId)));
  const classStudentCounts = new Map<string, number>();
  for (const cid of classIds) {
    classStudentCounts.set(
      cid,
      await prisma.student.count({ where: { classId: cid } }),
    );
  }

  // 一次抓所有 batch 的最近一条 GradingTask（按 question→submission→latest）
  // 这里偷懒用 server-side aggregation 一把：拉出所有 GradingTask + question.batchId
  // 然后在 JS 里聚合，免得手写 raw SQL。
  // 数据量假设：单老师 batch 数十、submission 数百~数千，不会撑爆内存。
  const gradings = await prisma.gradingTask.findMany({
    where: {
      submission: { question: { batch: { ownerId } } },
    },
    select: {
      id: true,
      revision: true,
      status: true,
      finalScore: true,
      maxScore: true,
      reviewFlag: true,
      updatedAt: true,
      submission: {
        select: {
          id: true,
          studentId: true,
          question: {
            select: { id: true, batchId: true, requireGrading: true },
          },
        },
      },
    },
  });

  // (submissionId) → 最新一条 GradingTask
  const latestBySubmission = new Map<string, (typeof gradings)[number]>();
  for (const g of gradings) {
    const prev = latestBySubmission.get(g.submission.id);
    if (!prev || g.revision > prev.revision) {
      latestBySubmission.set(g.submission.id, g);
    }
  }

  // batchId → 统计累加器
  type Acc = {
    totalGradedCells: number;
    expectedGradedCells: number;
    sumScorePercent: number;
    scoredCount: number;
    needsReview: number;
    lastUpdate: Date;
  };
  const accByBatch = new Map<string, Acc>();
  for (const b of batches) {
    accByBatch.set(b.id, {
      totalGradedCells: 0,
      expectedGradedCells: 0,
      sumScorePercent: 0,
      scoredCount: 0,
      needsReview: 0,
      lastUpdate: b.updatedAt,
    });
  }

  for (const g of latestBySubmission.values()) {
    const batchId = g.submission.question.batchId;
    const acc = accByBatch.get(batchId);
    if (!acc) continue;
    if (g.status === "succeeded") {
      acc.totalGradedCells += 1;
      if (g.reviewFlag) acc.needsReview += 1;
      if (
        g.submission.question.requireGrading &&
        typeof g.finalScore === "number" &&
        typeof g.maxScore === "number" &&
        g.maxScore > 0
      ) {
        acc.sumScorePercent += (g.finalScore / g.maxScore) * 100;
        acc.scoredCount += 1;
      }
    }
    if (g.updatedAt > acc.lastUpdate) acc.lastUpdate = g.updatedAt;
  }

  const groupsMap = new Map<string, ResultsListGroup>();
  for (const b of batches) {
    const acc = accByBatch.get(b.id)!;
    const studentCount = classStudentCounts.get(b.classId) ?? 0;
    const expectedGradedCells =
      studentCount * b.questions.filter((q) => q.requireGrading).length;
    const completion =
      expectedGradedCells === 0
        ? 0
        : Math.min(1, acc.totalGradedCells / expectedGradedCells);
    const averagePercent =
      acc.scoredCount === 0 ? null : acc.sumScorePercent / acc.scoredCount;

    const item: ResultsListBatch = {
      id: b.id,
      title: b.title,
      questionCount: b._count.questions,
      studentCount,
      completion,
      averagePercent,
      needsReviewCount: acc.needsReview,
      updatedAt: acc.lastUpdate.toISOString(),
    };
    if (!groupsMap.has(b.classId)) {
      groupsMap.set(b.classId, {
        classId: b.classId,
        className: b.class.name,
        batches: [],
      });
    }
    groupsMap.get(b.classId)!.batches.push(item);
  }

  return Array.from(groupsMap.values()).sort((a, b) =>
    a.className.localeCompare(b.className, "zh"),
  );
}

// ─────────── 详情页（/results/[id]） ───────────

export type ResultsStudentRow = {
  studentId: string;
  externalId: string;
  name: string;
  // 应打分题数 / 已批分题数
  expectedScored: number;
  actuallyScored: number;
  // 总得分 / 总满分（按"已批"的题加和）
  totalScore: number;
  totalMax: number;
  // 平均分百分比（已批题的 score/max 平均），没题可算就 null
  averagePercent: number | null;
  needsReview: number;
  unsubmittedCount: number; // 全部题里没交的数量（含 requireGrading=false）
};

export type ResultsQuestionRow = {
  questionId: string;
  index: number;
  prompt: string;
  requireGrading: boolean;
  // 应批人数 / 已批人数（按 student × this question）
  expectedCount: number;
  scoredCount: number;
  // 平均分百分比、最高、最低（仅 requireGrading=true）
  averagePercent: number | null;
  maxPercent: number | null;
  minPercent: number | null;
  needsReview: number;
};

export type ResultsDetailData = {
  batchId: string;
  batchTitle: string;
  batchSubject: string | null;
  batchObjective: string | null;
  className: string;
  // 是否还有题在批改（pending/queued/running），UI 上提示用户去 /grade/[id] 处理
  hasInFlight: boolean;
  students: ResultsStudentRow[];
  questions: ResultsQuestionRow[];
};

export async function loadResultsDetail(
  batchId: string,
  ownerId: string,
): Promise<ResultsDetailData | null> {
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
    select: {
      id: true,
      studentId: true,
      questionId: true,
      gradings: {
        orderBy: { revision: "desc" },
        take: 1,
        select: {
          status: true,
          finalScore: true,
          maxScore: true,
          reviewFlag: true,
        },
      },
    },
  });

  // 索引：按 questionId × studentId → latest grading（如果有）
  type LatestCell = {
    submissionId: string;
    status: string;
    finalScore: number | null;
    maxScore: number | null;
    reviewFlag: boolean;
  };
  const cellMap = new Map<string, LatestCell>();
  for (const s of submissions) {
    const k = `${s.questionId}::${s.studentId}`;
    const g = s.gradings[0];
    cellMap.set(k, {
      submissionId: s.id,
      status: g?.status ?? "no_task",
      finalScore: g?.finalScore ?? null,
      maxScore: g?.maxScore ?? null,
      reviewFlag: g?.reviewFlag ?? false,
    });
  }

  let hasInFlight = false;

  const studentRows: ResultsStudentRow[] = batch.class.students.map((s) => {
    let expectedScored = 0;
    let actuallyScored = 0;
    let totalScore = 0;
    let totalMax = 0;
    let needsReview = 0;
    let unsubmittedCount = 0;
    let scoredPercentSum = 0;
    let scoredPercentCount = 0;
    for (const q of batch.questions) {
      if (q.requireGrading) expectedScored += 1;
      const k = `${q.id}::${s.id}`;
      const cell = cellMap.get(k);
      if (!cell) {
        unsubmittedCount += 1;
        continue;
      }
      if (
        cell.status === "queued" ||
        cell.status === "running" ||
        cell.status === "pending"
      ) {
        hasInFlight = true;
      }
      if (cell.status === "succeeded") {
        if (cell.reviewFlag) needsReview += 1;
        if (
          q.requireGrading &&
          typeof cell.finalScore === "number" &&
          typeof cell.maxScore === "number" &&
          cell.maxScore > 0
        ) {
          actuallyScored += 1;
          totalScore += cell.finalScore;
          totalMax += cell.maxScore;
          scoredPercentSum += (cell.finalScore / cell.maxScore) * 100;
          scoredPercentCount += 1;
        }
      }
    }
    return {
      studentId: s.id,
      externalId: s.externalId,
      name: s.name,
      expectedScored,
      actuallyScored,
      totalScore: Math.round(totalScore * 10) / 10,
      totalMax: Math.round(totalMax * 10) / 10,
      averagePercent:
        scoredPercentCount === 0
          ? null
          : Math.round((scoredPercentSum / scoredPercentCount) * 10) / 10,
      needsReview,
      unsubmittedCount,
    };
  });

  const questionRows: ResultsQuestionRow[] = batch.questions.map((q) => {
    const expectedCount = batch.class.students.length;
    let scoredCount = 0;
    let needsReview = 0;
    const percents: number[] = [];
    for (const s of batch.class.students) {
      const cell = cellMap.get(`${q.id}::${s.id}`);
      if (!cell || cell.status !== "succeeded") continue;
      if (cell.reviewFlag) needsReview += 1;
      if (
        q.requireGrading &&
        typeof cell.finalScore === "number" &&
        typeof cell.maxScore === "number" &&
        cell.maxScore > 0
      ) {
        scoredCount += 1;
        percents.push((cell.finalScore / cell.maxScore) * 100);
      } else if (!q.requireGrading) {
        scoredCount += 1; // requireGrading=false 时 succeeded 就算"已批"
      }
    }
    const avg =
      percents.length === 0
        ? null
        : Math.round((percents.reduce((a, b) => a + b, 0) / percents.length) * 10) /
          10;
    const max = percents.length === 0 ? null : Math.round(Math.max(...percents) * 10) / 10;
    const min = percents.length === 0 ? null : Math.round(Math.min(...percents) * 10) / 10;
    return {
      questionId: q.id,
      index: q.index,
      prompt: q.prompt,
      requireGrading: q.requireGrading,
      expectedCount,
      scoredCount,
      averagePercent: avg,
      maxPercent: max,
      minPercent: min,
      needsReview,
    };
  });

  return {
    batchId: batch.id,
    batchTitle: batch.title,
    batchSubject: batch.subject ?? null,
    batchObjective: batch.batchObjective ?? null,
    className: batch.class.name,
    hasInFlight,
    students: studentRows,
    questions: questionRows,
  };
}

// ─────────── 学生成绩单（/results/[id]/students/[studentId]） ───────────

/**
 * "成绩单"视图的单题块。所有 LLM 输出都已服务端预解析，前端不需要再去
 * fetch /api/grade/result —— 一次性渲染整张报告，方便老师肉眼通读 + 一键复制。
 */
export type StudentReportQuestion = {
  questionId: string;
  index: number;
  prompt: string;
  requireGrading: boolean;
  // submission 维度
  hasSubmission: boolean;
  imagePaths: string[];
  // grading 维度（latest revision；可能不存在 = 已交未批 / 未交）
  status: string | null;
  mode: string | null;
  actionType: string | null;
  revision: number | null;
  reviewFlag: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  result: ParsedGradingResult; // 缺数据时是 EMPTY_PARSED_RESULT 的同形空值
  updatedAt: string | null;
};

export type StudentReportData = {
  batchId: string;
  batchTitle: string;
  batchSubject: string | null;
  batchObjective: string | null;
  className: string;
  student: {
    id: string;
    externalId: string;
    name: string;
  };
  // 顶部汇总
  totalScore: number;
  totalMax: number;
  averagePercent: number | null;
  expectedScored: number;
  actuallyScored: number;
  unsubmittedCount: number;
  needsReviewCount: number;
  // 邻居导航：在班级学号顺序里的上一个 / 下一个学生 ID
  prevStudentId: string | null;
  nextStudentId: string | null;
  questions: StudentReportQuestion[];
};

export async function loadStudentReport(
  batchId: string,
  studentId: string,
  ownerId: string,
): Promise<StudentReportData | null> {
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

  const student = batch.class.students.find((s) => s.id === studentId);
  if (!student) return null;

  // 邻居：班级学号顺序的上一/下一个，方便老师一份接一份连贯翻看
  const idx = batch.class.students.findIndex((s) => s.id === studentId);
  const prevStudentId = idx > 0 ? batch.class.students[idx - 1].id : null;
  const nextStudentId =
    idx >= 0 && idx < batch.class.students.length - 1
      ? batch.class.students[idx + 1].id
      : null;

  // 一次性把这个学生在本批次所有题的 submission + latest grading 拉出来
  const submissions = await prisma.submission.findMany({
    where: {
      studentId,
      questionId: { in: batch.questions.map((q) => q.id) },
    },
    include: {
      gradings: { orderBy: { revision: "desc" }, take: 1 },
    },
  });
  const subByQ = new Map<string, (typeof submissions)[number]>();
  for (const s of submissions) subByQ.set(s.questionId, s);

  function safeArr(s: string | null): string[] {
    if (!s) return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  let totalScore = 0;
  let totalMax = 0;
  let expectedScored = 0;
  let actuallyScored = 0;
  let unsubmittedCount = 0;
  let needsReviewCount = 0;
  let scoredPercentSum = 0;
  let scoredPercentCount = 0;

  const questions: StudentReportQuestion[] = batch.questions.map((q) => {
    if (q.requireGrading) expectedScored += 1;
    const sub = subByQ.get(q.id);
    if (!sub) {
      unsubmittedCount += 1;
      return {
        questionId: q.id,
        index: q.index,
        prompt: q.prompt,
        requireGrading: q.requireGrading,
        hasSubmission: false,
        imagePaths: [],
        status: null,
        mode: null,
        actionType: null,
        revision: null,
        reviewFlag: false,
        errorCode: null,
        errorMessage: null,
        result: parseGradingResult(null),
        updatedAt: null,
      };
    }
    const latest = sub.gradings[0] ?? null;
    const result = parseGradingResult(latest?.result ?? null);
    if (latest?.status === "succeeded") {
      if (latest.reviewFlag) needsReviewCount += 1;
      if (
        q.requireGrading &&
        typeof latest.finalScore === "number" &&
        typeof latest.maxScore === "number" &&
        latest.maxScore > 0
      ) {
        actuallyScored += 1;
        totalScore += latest.finalScore;
        totalMax += latest.maxScore;
        scoredPercentSum += (latest.finalScore / latest.maxScore) * 100;
        scoredPercentCount += 1;
      }
    }
    return {
      questionId: q.id,
      index: q.index,
      prompt: q.prompt,
      requireGrading: q.requireGrading,
      hasSubmission: true,
      imagePaths: safeArr(sub.imagePaths),
      status: latest?.status ?? null,
      mode: latest?.mode ?? null,
      actionType: latest?.actionType ?? null,
      revision: latest?.revision ?? null,
      reviewFlag: latest?.reviewFlag ?? false,
      errorCode: latest?.errorCode ?? null,
      errorMessage: latest?.errorMessage ?? null,
      // 用列字段覆盖 result.finalScore/maxScore：列字段是 webhook 直接落库的"权威值"，
      // result JSON 是同源解析；二者只在老脏数据 / parse 失败时漂移，列字段更稳。
      result: {
        ...result,
        finalScore: latest?.finalScore ?? result.finalScore,
        maxScore: latest?.maxScore ?? result.maxScore,
      },
      updatedAt: latest?.updatedAt.toISOString() ?? null,
    };
  });

  return {
    batchId: batch.id,
    batchTitle: batch.title,
    batchSubject: batch.subject ?? null,
    batchObjective: batch.batchObjective ?? null,
    className: batch.class.name,
    student: {
      id: student.id,
      externalId: student.externalId,
      name: student.name,
    },
    totalScore: Math.round(totalScore * 10) / 10,
    totalMax: Math.round(totalMax * 10) / 10,
    averagePercent:
      scoredPercentCount === 0
        ? null
        : Math.round((scoredPercentSum / scoredPercentCount) * 10) / 10,
    expectedScored,
    actuallyScored,
    unsubmittedCount,
    needsReviewCount,
    prevStudentId,
    nextStudentId,
    questions,
  };
}
