FROM node:22-alpine AS base

# 1. 基础环境
RUN apk add --no-cache libc6-compat && npm install -g pnpm@10
WORKDIR /app

# 2. 构建阶段
FROM base AS builder
WORKDIR /app

# 复制控制文件与依赖
COPY package.json pnpm-lock.yaml* vite.config.ts ./
COPY scripts/ ./scripts/
COPY src/config/db/ ./src/config/db/

ARG DATABASE_PROVIDER=sqlite
ENV DATABASE_PROVIDER=${DATABASE_PROVIDER}
ENV NODE_ENV=production

# 核心：必须显式告诉 Vite 插件我们要打包成独立的 Node 生产环境
ENV NITRO_PRESET=node-server

RUN pnpm i --frozen-lockfile

# 复制其余源码并编译
COPY . .
RUN pnpm build

# 3. 运行阶段
FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

# 将生成的标准 .output 文件夹整体同步
COPY --from=builder --chown=appuser:nodejs /app/.output ./.output

USER appuser

EXPOSE 3000

# 强制将主机绑定变量覆盖到所有已知的 Vinxi / Nitro 环境变量
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV NITRO_HOST=0.0.0.0
ENV VINXI_HOST=0.0.0.0
ENV NITRO_PORT=3000
ENV VINXI_PORT=3000

# 启动标准单文件入口
CMD ["node", ".output/server/index.mjs"]
