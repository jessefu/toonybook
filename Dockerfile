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

# Zeabur 的「环境变量」面板要传进多阶段构建，必须先用 ARG 接住。
# VITE_* 是构建期被内联进客户端 bundle 的，所以公开地址和应用名必须在这一步
# 就存在 —— 只在运行时设置的话，客户端 bundle 里的 app_url 是空的，
# canonical / OG 链接和鉴权重定向都会指向错误地址。
ARG VITE_APP_URL
ARG VITE_APP_NAME
ENV VITE_APP_URL=${VITE_APP_URL}
ENV VITE_APP_NAME=${VITE_APP_NAME}

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

# 8080 是 Zeabur 对 Git 部署服务的默认端口，也是它面板上「容器端口」的默认值：
# 网关按这个端口找上游，找不到就直接由它自己返回 404（请求根本到不了这里）。
# 之前写死 3000 就是首页 404 的原因 —— 应用起来了、日志正常，但没人把请求转给它。
EXPOSE 8080

ENV NODE_ENV=production
# 默认 8080；Zeabur 若在运行时注入自己的 PORT，会覆盖这个镜像里的值（运行时
# 环境变量优先于镜像 ENV），所以两种机制下都能对上网关期望的端口。
ENV PORT=8080

# 强制注入最高优先级环境变量
ENV HOST=0.0.0.0
ENV NITRO_HOST=0.0.0.0
ENV VINXI_HOST=0.0.0.0

CMD ["node", ".output/server/index.mjs"]
