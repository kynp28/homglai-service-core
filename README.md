# Homglai Service Core

Core service backend monorepo for the Homglai coffee machine repair management platform.

## Architecture

- `apps/api`: Express.js + TypeScript REST API Server
- `packages/db`: Prisma Schema, Database Client, and Versioned SQL Migrations
- `packages/typescript-config`: Shared TypeScript configurations

## Quick Start (Development)

1. Start database containers:
   ```bash
   MYSQL_ROOT_PASSWORD=root docker compose up -d
   ```
2. Deploy migrations:
   ```bash
   pnpm --filter @homglai/db run db:deploy
   ```
3. Run test suites:
   ```bash
   pnpm --filter @homglai/api test:all
   ```
4. Start development API server:
   ```bash
   pnpm --filter @homglai/api dev
   ```

For detailed production deployment instructions, environment variables, and security guidelines, see [`apps/api/README.md`](apps/api/README.md).
