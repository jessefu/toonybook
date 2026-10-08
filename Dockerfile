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

# 显式声明生产打包预设
ENV NITRO_PRESET=node-server
ENV HOST=0.0.0.0
ENV NITRO_HOST=0.0.0.0
ENV VINXI_HOST=0.0.0.0

RUN pnpm i --frozen-lockfile

# 先复制全部源码
COPY . .

# 编译前物理毁灭内鬼本地配置文件
RUN rm -f .env .env.local .env.development .env.production .env.example || true

# 执行完整的 TanStack Start 打包编译，此时会同时产出静态 dist 和标准的 .output
RUN pnpm build

# 3. 运行阶段
FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

# 🔥【核心修复】：不能只复制 .output！必须把构建阶段生成的全部资产，包括代码根目录和 dist 同步复制过来
# 这样 Vinxi 在处理路由和前端 JS 资产静态分发时，才不会找不到物理文件
COPY --from=builder --chown=appuser:nodejs /app /app

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# 强制注入最高优先级环境变量
ENV HOST=0.0.0.0
ENV NITRO_HOST=0.0.0.0
ENV VINXI_HOST=0.0.0.0

CMD ["node", ".output/server/index.mjs"]
