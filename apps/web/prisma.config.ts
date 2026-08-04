import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

// Prisma 7 配置。CLI 不自动加载 .env，这里显式加载（.env.local 优先，其次 .env）。
config({ path: ".env.local" });
config({ path: ".env" });

// 迁移/introspection 用直连（DIRECT_URL，非 pooler）——PgBouncer 下 Prisma Migrate 会出问题。
// 运行时（src/lib/db.ts）仍用 DATABASE_URL(pooler)。
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DIRECT_URL ?? env("DATABASE_URL"),
  },
});
