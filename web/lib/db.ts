import { PrismaClient } from "@prisma/client";

// Next.js dev 模式 hot reload 会反复 new PrismaClient → SQLite "database is locked"。
// 所以缓存到 globalThis 上。production 下每个进程一个实例，不缓存也无所谓。
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
