#!/usr/bin/env node
/**
 * 命令行创建初始老师账号 —— Docker runtime 用（CommonJS，不依赖 tsx）。
 *
 * 用法：
 *   docker compose exec web node scripts/create-user.cjs \
 *     --email teacher@example.com --password 'pw' --name '王老师'
 *
 * 本地开发用 npm run create-user（走 tsx + create-user.ts），逻辑等价。
 * 已存在邮箱直接报错退出，不做"覆盖"语义。
 */
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag || !flag.startsWith("--")) continue;
    const key = flag.slice(2);
    if (value && !value.startsWith("--")) {
      args[key] = value;
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { email, password, name } = args;
  const role = args.role || "teacher";

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

  const prisma = new PrismaClient();
  try {
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
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("创建失败：", err);
  process.exit(1);
});
