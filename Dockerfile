# ─── Base ─────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.6.1 --activate
WORKDIR /app

# ─── Dependencies ─────────────────────────────────────────────────────────────
FROM base AS deps

# Native build tools for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Copy package manifests for all workspaces (for cache-efficient installs)
# ⚠️  Update this list when adding new workspace packages
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY scripts/install-git-hooks.mjs scripts/install-git-hooks.mjs
COPY apps/api/package.json apps/api/package.json
COPY apps/runtime/package.json apps/runtime/package.json
COPY apps/runtime-manager/package.json apps/runtime-manager/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/event-bus/package.json packages/event-bus/package.json
COPY packages/exchange/package.json packages/exchange/package.json

RUN pnpm install --frozen-lockfile

# Ensure all workspace node_modules dirs exist (pnpm may skip empty ones)
RUN mkdir -p apps/api/node_modules apps/runtime/node_modules apps/runtime-manager/node_modules apps/web/node_modules \
    packages/config/node_modules packages/db/node_modules packages/domain/node_modules \
    packages/event-bus/node_modules packages/exchange/node_modules

# ─── Builder ──────────────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/runtime/node_modules ./apps/runtime/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/apps/runtime-manager/node_modules ./apps/runtime-manager/node_modules
COPY --from=deps /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/domain/node_modules ./packages/domain/node_modules
COPY --from=deps /app/packages/event-bus/node_modules ./packages/event-bus/node_modules
COPY --from=deps /app/packages/exchange/node_modules ./packages/exchange/node_modules

# Copy source
COPY . .

# Build everything via turbo
RUN pnpm run build

# ─── Runner ───────────────────────────────────────────────────────────────────
FROM base AS runner

ARG GIT_SHA=unknown
ENV NODE_ENV=production
LABEL org.opencontainers.image.revision="$GIT_SHA"

# Non-root user
RUN groupadd --system --gid 1001 plankton && \
    useradd --system --uid 1001 --gid plankton plankton

# Copy monorepo structure marker
COPY --from=builder /app/pnpm-workspace.yaml ./

# Copy production node_modules (pnpm hoisted structure)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/runtime/node_modules ./apps/runtime/node_modules
COPY --from=deps /app/apps/runtime-manager/node_modules ./apps/runtime-manager/node_modules
COPY --from=deps /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/domain/node_modules ./packages/domain/node_modules
COPY --from=deps /app/packages/event-bus/node_modules ./packages/event-bus/node_modules
COPY --from=deps /app/packages/exchange/node_modules ./packages/exchange/node_modules

# Copy compiled output — preserves monorepo layout
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/runtime/dist ./apps/runtime/dist
COPY --from=builder /app/apps/runtime/package.json ./apps/runtime/package.json
# Step 3 (audit doc §G10) — soft-ranking model artifact lives under
# `dist/data/` after `pnpm run build` (post-tsc copy in scripts/copy-data.mjs).
# It is included in the dist copy above. We intentionally do NOT add a
# separate COPY of `src/data`: when the artifact is rolled back by removing
# `apps/runtime/src/data/soft-ranking-model.v1.json`, that directory may
# vanish entirely. A redundant `COPY src/data` would then break the build
# (or, if the dir still exists, resurrect a stale copy and defeat the
# disabled-no-op contract from §F1 / §F14).
COPY --from=builder /app/apps/runtime-manager/dist ./apps/runtime-manager/dist
COPY --from=builder /app/apps/runtime-manager/package.json ./apps/runtime-manager/package.json
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/packages/config/dist ./packages/config/dist
COPY --from=builder /app/packages/config/package.json ./packages/config/package.json
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/package.json ./packages/db/package.json
COPY --from=builder /app/packages/domain/dist ./packages/domain/dist
COPY --from=builder /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=builder /app/packages/event-bus/dist ./packages/event-bus/dist
COPY --from=builder /app/packages/event-bus/package.json ./packages/event-bus/package.json
COPY --from=builder /app/packages/exchange/dist ./packages/exchange/dist
COPY --from=builder /app/packages/exchange/package.json ./packages/exchange/package.json

# Note: DB migrations (.sql files) are already in packages/db/dist/migrations/
# because the db package build script copies them there (see packages/db/package.json).

# Write deploy SHA for traceability (readable via /api/v1/health or cat /app/GIT_SHA)
RUN echo "$GIT_SHA" > /app/GIT_SHA

# Create data directory for SQLite (will be volume-mounted)
RUN mkdir -p /app/apps/runtime/data && chown plankton:plankton /app/apps/runtime/data

USER plankton

EXPOSE 3100
