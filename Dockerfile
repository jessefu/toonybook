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
# 同时在编译时就强行注入 0.0.0.0，防止打包期默认回退
ENV HOST=0.0.0.0
ENV NITRO_HOST=0.0.0.0
ENV VINXI_HOST=0.0.0.0

RUN pnpm i --frozen-lockfile

# 【关键改动 1】：先复制全部源码
COPY . .

# 【关键改动 2】：在打包（pnpm build）正要执行的前一刻，物理毁灭所有带 .env 的内鬼文件！
RUN rm -f .env .env.local .env.development .env.production .env.example || true

# 此时编译，框架因为找不到任何本地环境文件，只能乖乖使用上面的 ENV HOST=0.0.0.0 写入产物
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

ENV NODE_ENV=production
ENV PORT=3000

# 声明运行时的最高优先级变量
ENV HOST=0.0.0.0
ENV NITRO_HOST=0.0.0.0
ENV VINXI_HOST=0.0.0.0

CMD ["sh", "-c", "HOST=0.0.0.0 PORT=3000 NITRO_HOST=0.0.0.0 VINXI_HOST=0.0.0.0 node .output/server/index.mjs"]
