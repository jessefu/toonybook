FROM node:22-alpine AS base

# 1. 基础环境
RUN apk add --no-cache libc6-compat && npm install -g pnpm@10
WORKDIR /app

# 2. 构建阶段
FROM base AS builder
# 先复制依赖配置文件
COPY package.json pnpm-lock.yaml* vite.config.ts ./
# 复制数据库相关脚本（防止安装钩子需要）
COPY scripts/ ./scripts/
COPY src/config/db/ ./src/config/db/

ARG DATABASE_PROVIDER=sqlite
ENV DATABASE_PROVIDER=${DATABASE_PROVIDER}
ENV NODE_ENV=production

# 安装全部依赖（Nuxt 构建需要 devDependencies）
RUN pnpm i --frozen-lockfile

# 复制其余所有源码并执行构建
COPY . .
RUN pnpm build

# 【核心修复】如果打包产物去了 .zeabur/output，确保安全移动
RUN if [ -d ".zeabur/output" ] && [ ! -d ".output" ]; then \
        mkdir -p .output && cp -r .zeabur/output/* .output/; \
    fi

# 3. 运行阶段
FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

# 把构建好的产物和可能的静态资源都同步过来
COPY --from=builder --chown=appuser:nodejs /app/.output ./.output

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

CMD ["node", ".output/server/index.mjs"]