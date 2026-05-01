"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { ResultsDetailData } from "@/lib/results-data";

type Tab = "students" | "questions";

export function ResultsBoard({ data }: { data: ResultsDetailData }) {
  const [tab, setTab] = useState<Tab>("students");
  // 学生榜默认按平均分降序，缺考排底；点表头再切换排序方向。
  const [studentSort, setStudentSort] = useState<"score_desc" | "score_asc" | "id">(
    "score_desc",
  );

  const students = useMemo(() => {
    const arr = [...data.students];
    if (studentSort === "id") {
      arr.sort((a, b) => a.externalId.localeCompare(b.externalId));
    } else {
      arr.sort((a, b) => {
        const va = a.averagePercent ?? -1;
        const vb = b.averagePercent ?? -1;
        return studentSort === "score_desc" ? vb - va : va - vb;
      });
    }
    return arr;
  }, [data.students, studentSort]);

  // 题目分析里只展示需要打分的题；不打分的题在底部单独列一个"只批注"小节。
  const scoredQuestions = useMemo(
    () => data.questions.filter((q) => q.requireGrading),
    [data.questions],
  );
  const reviewOnlyQuestions = useMemo(
    () => data.questions.filter((q) => !q.requireGrading),
    [data.questions],
  );

  return (
    <div className="space-y-3">
      {/* Tabs（手写，因为还没装 shadcn/tabs；按钮组够直观） */}
      <div className="inline-flex rounded-md border bg-card p-1">
        <TabBtn active={tab === "students"} onClick={() => setTab("students")}>
          学生榜（{data.students.length}）
        </TabBtn>
        <TabBtn active={tab === "questions"} onClick={() => setTab("questions")}>
          题目分析（{scoredQuestions.length} 打分 + {reviewOnlyQuestions.length} 只批注）
        </TabBtn>
      </div>

      {tab === "students" ? (
        <div className="rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b p-2 text-xs text-muted-foreground">
            <span>
              排序：
              <button
                type="button"
                className={cn(
                  "ml-1 rounded px-2 py-0.5",
                  studentSort === "score_desc"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
                onClick={() => setStudentSort("score_desc")}
              >
                平均分降序
              </button>
              <button
                type="button"
                className={cn(
                  "ml-1 rounded px-2 py-0.5",
                  studentSort === "score_asc"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
                onClick={() => setStudentSort("score_asc")}
              >
                平均分升序
              </button>
              <button
                type="button"
                className={cn(
                  "ml-1 rounded px-2 py-0.5",
                  studentSort === "id"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
                onClick={() => setStudentSort("id")}
              >
                按学号
              </button>
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 text-center">#</TableHead>
                <TableHead className="w-40">学生</TableHead>
                <TableHead className="w-28 text-right">平均分</TableHead>
                <TableHead className="w-32 text-right">总分 / 满分</TableHead>
                <TableHead className="w-32 text-center">已批 / 应批</TableHead>
                <TableHead className="w-24 text-center">未交</TableHead>
                <TableHead className="w-24 text-center">待复核</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {students.length === 0 ? (
                <TableEmpty colSpan={7} message="该班级还没有学生" />
              ) : (
                students.map((s, i) => (
                  <TableRow key={s.studentId}>
                    <TableCell className="text-center font-mono text-xs text-muted-foreground">
                      {i + 1}
                    </TableCell>
                    <TableCell>
                      {/*
                        姓名整块作为详情链接 —— 老师视线最自然落到名字上，比另起一列
                        放"详情"按钮干净。学号也包进去保证 click target 大。
                      */}
                      <Link
                        href={`/results/${data.batchId}/students/${s.studentId}`}
                        className="block hover:underline"
                      >
                        <div className="font-medium">{s.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {s.externalId}
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">
                      {s.averagePercent === null ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={cn(
                            "font-semibold",
                            s.averagePercent >= 80
                              ? "text-emerald-600 dark:text-emerald-400"
                              : s.averagePercent >= 60
                                ? "text-sky-600 dark:text-sky-400"
                                : "text-amber-600 dark:text-amber-400",
                          )}
                        >
                          {s.averagePercent.toFixed(1)}%
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {s.totalMax > 0 ? (
                        <>
                          {s.totalScore}
                          <span className="text-muted-foreground">
                            {" / "}
                            {s.totalMax}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <span
                        className={cn(
                          "text-sm",
                          s.actuallyScored < s.expectedScored
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground",
                        )}
                      >
                        {s.actuallyScored} / {s.expectedScored}
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      {s.unsubmittedCount > 0 ? (
                        <Badge variant="outline">{s.unsubmittedCount}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {s.needsReview > 0 ? (
                        <Badge variant="warning">{s.needsReview}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border bg-card">
            <div className="border-b p-2 text-xs text-muted-foreground">
              打分题统计 —— 平均 / 最高 / 最低均按"百分比"算（适配每题不同满分）。
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16 text-center">题号</TableHead>
                  <TableHead>题干</TableHead>
                  <TableHead className="w-24 text-right">平均</TableHead>
                  <TableHead className="w-24 text-right">最高</TableHead>
                  <TableHead className="w-24 text-right">最低</TableHead>
                  <TableHead className="w-32 text-center">已批 / 应批</TableHead>
                  <TableHead className="w-24 text-center">待复核</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scoredQuestions.length === 0 ? (
                  <TableEmpty colSpan={7} message="本批次没有需要打分的题" />
                ) : (
                  scoredQuestions.map((q) => (
                    <TableRow key={q.questionId}>
                      <TableCell className="text-center font-mono">
                        {q.index}
                      </TableCell>
                      <TableCell className="max-w-md">
                        <p className="line-clamp-2 text-sm">{q.prompt}</p>
                      </TableCell>
                      <TableCell className="text-right">
                        {q.averagePercent === null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <span
                            className={cn(
                              "font-semibold",
                              q.averagePercent >= 80
                                ? "text-emerald-600 dark:text-emerald-400"
                                : q.averagePercent >= 60
                                  ? "text-sky-600 dark:text-sky-400"
                                  : "text-amber-600 dark:text-amber-400",
                            )}
                          >
                            {q.averagePercent.toFixed(1)}%
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {q.maxPercent === null
                          ? "—"
                          : `${q.maxPercent.toFixed(1)}%`}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {q.minPercent === null
                          ? "—"
                          : `${q.minPercent.toFixed(1)}%`}
                      </TableCell>
                      <TableCell className="text-center">
                        <span
                          className={cn(
                            "text-sm",
                            q.scoredCount < q.expectedCount
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground",
                          )}
                        >
                          {q.scoredCount} / {q.expectedCount}
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        {q.needsReview > 0 ? (
                          <Badge variant="warning">{q.needsReview}</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {reviewOnlyQuestions.length > 0 ? (
            <div className="rounded-lg border bg-card">
              <div className="border-b p-2 text-xs text-muted-foreground">
                只批注题 —— 模型只输出修改建议、不打分；这里只统计完成数。
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16 text-center">题号</TableHead>
                    <TableHead>题干</TableHead>
                    <TableHead className="w-32 text-center">已批 / 应批</TableHead>
                    <TableHead className="w-24 text-center">待复核</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reviewOnlyQuestions.map((q) => (
                    <TableRow key={q.questionId}>
                      <TableCell className="text-center font-mono">
                        {q.index}
                      </TableCell>
                      <TableCell className="max-w-md">
                        <p className="line-clamp-2 text-sm">{q.prompt}</p>
                      </TableCell>
                      <TableCell className="text-center">
                        <span
                          className={cn(
                            "text-sm",
                            q.scoredCount < q.expectedCount
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground",
                          )}
                        >
                          {q.scoredCount} / {q.expectedCount}
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        {q.needsReview > 0 ? (
                          <Badge variant="warning">{q.needsReview}</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
