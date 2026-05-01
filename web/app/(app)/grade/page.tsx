import { redirect } from "next/navigation";

// 「批改」从 sidebar 移除后这条 URL 不再是顶层入口，但旧链接 / 书签可能还在用，
// 直接跳回作业批次列表，老师会自然从那里再点「批改」进入。
export default function GradeIndexPage() {
  redirect("/batches");
}
