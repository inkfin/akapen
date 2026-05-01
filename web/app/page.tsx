import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

// 根 URL：登了就去 dashboard，没登就去 login
export default async function HomePage() {
  const session = await auth();
  if (session?.user) redirect("/classes");
  redirect("/login");
}
