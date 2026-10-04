# syntax=docker/dockerfile:1.7
# FirstDayFirstShow API + UI. Multi-stage: build with dev deps, ship only production deps, the
# server bundle and the static UI (dist/web, served under /app/).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: nothing here needs install hooks (esbuild resolves its platform binary).
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY server ./server
COPY web ./web
RUN npm run build

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:22-alpine AS runtime
# tini: PID 1 that forwards SIGTERM to node, so the graceful drain actually runs on deploys.
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY db/migrations ./db/migrations
COPY package.json ./
USER node
EXPOSE 8080
# Liveness only (no DB): mirrors Render's healthCheckPath.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Heap capped below the 512 MB free-tier limit, leaving room for buffers and native memory.
# Capping the heap also shrinks V8's young generation, and request garbage then triggers a
# scavenge every few requests: a 16 MB semi-space cut server CPU per reserve by ~35% at 0.1 CPU
# (Phase 8 tuning; 64 MB bought nothing more and cost ~55 MB of RSS).
CMD ["node", "--enable-source-maps", "--max-old-space-size=384", "--max-semi-space-size=16", "dist/server.js"]
