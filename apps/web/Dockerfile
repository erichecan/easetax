# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# package-lock.json 必须在 linux 上生成，否则这里会挂：
# @tailwindcss/oxide-wasm32-wasi（optional，cpu=wasm32）的子树依赖
# （@emnapi/core、@emnapi/runtime）在 macOS 上从不被解析、进不了 lock，
# 而 linux 的 npm ci 会校验它们并报 EUSAGE «Missing ... from lock file»。
# 当前 lock 是在 ubuntu 上生成的，macOS 与 linux 的 npm ci 都实测通过。
# 若日后有人在 macOS 上跑 npm install 并提交 lock，这一步会再次失败 —— 到时在 linux 上重生成。
RUN npm ci --no-audit --no-fund

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Prisma client 不在依赖安装时生成（package.json 没有 postinstall），
# 不显式生成的话 next build 会因为 @prisma/client 未初始化而失败。
#
# schema.prisma 的 datasource 确实不带 url，但 prisma.config.ts 在**加载时**就调
# env("DATABASE_URL")，缺了直接抛 PrismaConfigEnvError。generate 只读 schema、不连库，
# 给个占位串即可。仅存在于 builder 阶段，不进最终镜像（runner 只拷 .next 产物）。
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
