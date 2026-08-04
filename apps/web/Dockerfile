# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# 这里**不能**用 npm ci：package-lock.json 是在 macOS 上生成的，而
# @tailwindcss/oxide-wasm32-wasi（optional，cpu=wasm32）的子树依赖
# （@emnapi/core、@emnapi/runtime）在 macOS 上从不被解析，所以没进 lock。
# linux 的 npm ci 会校验这些条目并报 EUSAGE «Missing ... from lock file»。
# 改用 npm install，在目标平台重新解析。
# 代价：构建不再严格锁定到 lock 文件。
# TODO: 在 linux 上重新生成 lock（CI 里跑 npm install --package-lock-only 并提交）后换回 npm ci。
RUN npm install --no-audit --no-fund

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Prisma client 不在 npm ci 时生成（package.json 没有 postinstall），
# 不显式生成的话 next build 会因为 @prisma/client 未初始化而失败。
# Prisma 7 的 datasource 不带 url，generate 不需要 DATABASE_URL。
RUN npx prisma generate
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
