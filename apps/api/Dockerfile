# API image (build context = repository root):
#   docker build -f apps/api/Dockerfile -t homglai-api .
# On Railway set the service variable RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile.
FROM node:22-bookworm-slim

# Prisma needs OpenSSL; CA certificates for calls to LINE
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm version comes from "packageManager" in package.json
RUN corepack enable
WORKDIR /app

# 1. Dependencies (cached while package files do not change)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/typescript-config packages/typescript-config
COPY packages/db/package.json packages/db/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# Dev dependencies are kept on purpose: create-admin and seed:demo run with tsx inside the container
RUN pnpm install --frozen-lockfile --filter "@homglai/api..."

# 2. Source + build
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter @homglai/db run db:generate \
  && pnpm --filter @homglai/db run build \
  && pnpm --filter @homglai/api run build

ENV NODE_ENV=production
# Photos go to a persistent volume mounted here (Railway volume / docker volume)
ENV IMAGE_STORAGE_DIR=/data/uploads
WORKDIR /app/apps/api

# Apply pending migrations (safe, additive), then start the API (it reads PORT from the platform)
CMD ["sh", "-c", "pnpm --filter @homglai/db run db:deploy && node dist/index.js"]
