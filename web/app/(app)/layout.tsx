import Link from "next/link";
import { redirect } from "next/navigation";
import { Users, BookOpen, ClipboardCheck, Settings, LogOut } from "lucide-react";

import { auth, signOut } from "@/lib/auth";
import { cn } from "@/lib/utils";

async function signOutAction() {
  "use server";
  await signOut({ redirectTo: "/login" });
}

const NAV = [
  { href: "/classes", label: "班级 / 学生", icon: Users },
  { href: "/batches", label: "作业批次", icon: BookOpen },
  { href: "/grade", label: "批改大盘", icon: ClipboardCheck },
  { href: "/settings", label: "设置", icon: Settings },
];

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="flex min-h-screen">
      {/* 桌面侧边栏 */}
      <aside className="hidden w-56 flex-col border-r bg-card md:flex">
        <div className="flex h-14 items-center border-b px-4 font-semibold">
          akapen
        </div>
        <nav className="flex-1 px-2 py-4">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t p-3 text-xs text-muted-foreground">
          <div>{session.user.name}</div>
          <div>{session.user.email}</div>
          <form action={signOutAction} className="mt-2">
            <button
              type="submit"
              className="flex items-center gap-1 text-foreground hover:underline"
            >
              <LogOut className="size-3" /> 退出
            </button>
          </form>
        </div>
      </aside>

      {/* 移动端顶栏 */}
      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b bg-card px-4 md:hidden">
          <span className="font-semibold">akapen</span>
          <nav className="flex gap-3 text-sm">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href}>
                <item.icon className="size-5" />
              </Link>
            ))}
          </nav>
        </header>
        <main className="flex-1 overflow-x-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
