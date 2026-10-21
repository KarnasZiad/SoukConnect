# syntax=docker/dockerfile:1.7
# Build context: repository root (docker build -f services/notifications/Dockerfile .)

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
COPY packages/messaging/package.json packages/messaging/
COPY packages/service-kit/package.json packages/service-kit/
COPY services/notifications/package.json services/notifications/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@soukconnect/notifications..."
COPY packages packages
COPY services/notifications services/notifications
RUN pnpm --filter "@soukconnect/notifications..." build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @soukconnect/notifications deploy --prod /out

# ---- Runtime: compiled JavaScript and production dependencies only, unprivileged user.
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4400/health/live || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
