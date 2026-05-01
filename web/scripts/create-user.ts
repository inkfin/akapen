/**
 * 命令行创建初始老师账号。
 *
 * 用法（本地）:
 *   npm run create-user -- --email teacher@example.com --password '...' --name '王老师'
 *
 * 用法（Docker）:
 *   docker compose exec web node scripts/create-user.js \
 *     --email teacher@example.com --password '...' --name '王老师'
 *   注意：tsx 不在 production 镜像里，所以 docker 路径用 prebuilt JS（standalone build 自动包含）。
 *
 * 已存在邮箱直接报错退出，不做"覆盖"语义；想改密码再写一个 reset-password.ts。
 */
import bcrypt from "bcryptjs";

import { prisma } from "../lib/db";

type Args = { email?: string; password?: string; name?: string; role?: string };

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--")) continue;
    const key = flag.slice(2) as keyof Args;
    if (value && !value.startsWith("--")) {
      args[key] = value;
      i++;
    }
  }
  return args;
}

async function main() {
  const { email, password, name, role = "teacher" } = parseArgs(
    process.argv.slice(2),
  );

  if (!email || !password || !name) {
    console.error(
      "用法: create-user --email <email> --password <pw> --name <name> [--role teacher|admin]",
    );
    process.exit(2);
  }
  if (password.length < 6) {
    console.error("密码至少 6 位");
    process.exit(2);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.error(`账号已存在：${email}`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { email, passwordHash, name, role },
  });
  console.log(`✓ 已创建：${user.email}（${user.name}）id=${user.id}`);
}

main()
  .catch((err) => {
    console.error("创建失败：", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
