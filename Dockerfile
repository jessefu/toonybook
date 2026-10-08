FROM node:22-alpine AS base

# 1. 安装依赖
FROM base AS deps
RUN apk add --no-cache libc6-compat && npm install -g pnpm@10

WORKDIR /app

COPY package.json pnpm-lock.yaml* vite.config.ts ./
COPY scripts/db-setup.mjs scripts/db-setup.mjs
COPY src/config/db/schema.sqlite.ts src/config/db/schema.sqlite.ts
COPY src/config/db/schema.postgres.ts src/config/db/schema.postgres.ts
COPY src/config/db/schema.mysql.ts src/config/db/schema.mysql.ts

ARG DATABASE_PROVIDER=sqlite
ENV DATABASE_PROVIDER=${DATABASE_PROVIDER}

RUN pnpm i --frozen-lockfile

# 2. 构建产物
FROM deps AS builder

WORKDIR /app

ENV NODE_ENV=production

COPY . .
RUN pnpm build

# 3. 运行镜像
FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

# 【关键点】从 builder 镜像中直接复制 /app/.output 文件夹
COPY --from=builder --chown=appuser:nodejs /app/.output ./.output

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# 明确启动路径
CMD ["node", ".output/server/index.mjs"]