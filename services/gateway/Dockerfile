# syntax=docker/dockerfile:1.7
# Build context: repository root (docker build -f services/gateway/Dockerfile .)

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    HUSKY=0
RUN corepack enable
WORKDIR /repo

# ---- Build: lockfile install, shared packages then the service, production-only bundle.
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json turbo.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/service-kit/package.json packages/service-kit/
COPY services/gateway/package.json services/gateway/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@soukconnect/gateway..."
COPY packages packages
COPY services/gateway services/gateway
RUN pnpm --filter "@soukconnect/gateway..." build
# The SQL migrations ship with the bundle ("files" of the package): the service applies them at
# startup under an advisory lock.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @soukconnect/gateway deploy --prod /out

# ---- Runtime: compiled JavaScript, migrations and production dependencies, unprivileged user.
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
