import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { AppError } from "./errors";
const globalDb = globalThis as unknown as { prisma?: PrismaClient };
export function db() {
  if (!process.env.DATABASE_URL)
    throw new AppError(
      503,
      "База данных не подключена. Задайте DATABASE_URL и выполните миграции.",
    );
  return (globalDb.prisma ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    log: [],
  }));
}
