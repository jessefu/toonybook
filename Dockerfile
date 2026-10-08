FROM node:22-alpine AS base

# 安装基础依赖
RUN apk add --no-cache libc6-compat && npm install -g pnpm@10
WORKDIR /app

# 1. 构建依赖和环境
FROM base AS builder
WORKDIR /app

# 复制配置文件及可能需要的脚本
COPY package.json pnpm-lock.yaml* vite.config.ts ./
COPY scripts/ ./scripts/
COPY src/config/db/ ./src/config/db/

ARG DATABASE_PROVIDER=sqlite
ENV DATABASE_PROVIDER=${DATABASE_PROVIDER}
ENV NODE_ENV=production

# 安装全部依赖（包含 devDependencies 才能运行 vite build）
RUN pnpm i --frozen-lockfile

# 复制剩余的所有源码
COPY . .

# 【核心修改】告诉 Vinxi / TanStack 使用 node-server 预设生成标准 .output
RUN NITRO_PRESET=node-server pnpm build

# 2. 运行阶段
FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

# 将生成的标准的 .output 文件夹同步过来
COPY --from=builder --chown=appuser:nodejs /app/.output ./.output

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# 运行标准的 Nitro 入口
CMD ["node", ".output/server/index.mjs"]