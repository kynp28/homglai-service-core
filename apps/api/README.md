# Homglai Service Core - API Server

## Configuration & Environment Variables

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `PORT` | API Server Port | `4000` |
| `DATABASE_URL` | MySQL Connection URL | `mysql://user:pass@localhost:3306/homglai_db` |
| `JWT_SECRET` | Secret key for JWT signing (HS256, minimum 32 characters) | Required |
| `CORS_ORIGINS` | Comma-separated list of allowed CORS origins | `http://localhost:3000` |
| `TRUST_PROXY` | Express `trust proxy` setting for reverse proxies (Nginx, Cloudflare, Traefik). Set to `true`, a hop count integer (e.g., `1`), or a specific IP/CIDR. Default: `false` (untrusted). | `false` |
| `LINE_CHANNEL_SECRET` | LINE Messaging API Channel Secret | Required for LINE Webhook HMAC-SHA256 verification |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API Channel Access Token | Required for LINE Reply and Push APIs |
| `PUBLIC_TRACKING_BASE_URL` | Public base URL used when sending tracking links to customers (if unset, tracking link is omitted) | `https://example.com/tracking/` |
| `MYSQL_ROOT_PASSWORD` | MySQL root password for database service (mandatory in docker-compose) | Required |
| `ALLOW_DESTRUCTIVE_TESTS` | Safety flag to permit destructive test scripts. Must NEVER be true on production | `false` |
| `LINE_LOGIN_CHANNEL_ID` | LINE Login channel of the customer LIFF; access tokens are verified against it (`LINE_IDENTITY_VERIFIER=mock` is accepted only with `NODE_ENV=test`) | Required for `POST /api/tracking/subscribe-line` |
| `JOBS_ENABLED` / `JOB_WORKER_INTERVAL_SECONDS` | Built-in background jobs (unaccepted-job digest, progress reminders, requeue safety net, nightly photo purge) | `true` / `60` |
| `IMAGE_STORAGE_DIR` | Folder for repair photos; mount it as a persistent volume outside the container | `./data/uploads` |

Reminder, business-hours, image and rate-limit settings (all optional, validated at startup) are listed with their defaults in `apps/api/.env.example` and in section 6 of the root `README.md`.

---

## Production Deployment Checklist & Step-by-Step Guide

Follow these sequential steps when deploying or upgrading the system in staging and production environments:

### Step 1: Pre-Migration Database Backup
Always generate a point-in-time snapshot of the database prior to applying schema migrations:
```bash
mysqldump -u <user> -p -h <host> --single-transaction --quick --routines --triggers <database_name> > backup_before_migrate_$(date +%Y%m%d_%H%M%S).sql
```

### Step 2: Configure Production Environment Variables
Create and configure `apps/api/.env` based on `apps/api/.env.example`. Ensure:
- `JWT_SECRET` is a cryptographically strong string of at least 32 characters.
- `NODE_ENV` is set to `production` (this automatically turns off Swagger UI `/api-docs`).
- `TRUST_PROXY` is configured according to your proxy topology (see below).
- `ALLOW_DESTRUCTIVE_TESTS` is left unset or explicitly set to `false`.

### Step 3: Deploy Database Migrations
Apply pending migrations safely using the Prisma deployment command:
```bash
pnpm --filter @homglai/db run db:deploy
```
> [!NOTE]
> All schema modifications follow a safe 3-step strategy (add nullable -> backfill -> enforce constraints) to preserve existing production records.

### Step 4: Bootstrap Initial Administrator
If deploying to a fresh database, create the primary administrator account:
```bash
pnpm --filter @homglai/api create-admin
```
The script will prompt for username, full name, and a password (minimum 12 characters). Alternatively, supply environment variables in automated CI/CD pipelines:
```bash
ADMIN_USERNAME=admin ADMIN_NAME="System Administrator" ADMIN_PASSWORD="SecurePassword123!" pnpm --filter @homglai/api create-admin
```

### Step 5: Reverse Proxy Configuration (`TRUST_PROXY`)
- When deploying behind a reverse proxy (e.g., Nginx, Traefik, AWS ALB, Cloudflare) that terminates TLS and forwards headers (`X-Forwarded-For`, `X-Forwarded-Proto`), set `TRUST_PROXY=1` (or `true`).
- If the server is directly exposed without an upstream proxy, set `TRUST_PROXY=false` to prevent IP spoofing attacks against rate limiting (`express-rate-limit`) and audit logs.

### Step 6: Strict Prohibition on `ALLOW_DESTRUCTIVE_TESTS`
> [!CAUTION]
> **NEVER set `ALLOW_DESTRUCTIVE_TESTS=true` on production or staging environments with live data.**
> The test runner and test scripts (`smoke-test.ts`, `concurrency-test.ts`, `seed-test.ts`) contain automated cleanup routines (`deleteMany`). By default, they will immediately abort execution if `DATABASE_URL` does not point to a database name ending with `_test`. Overriding this guard with `ALLOW_DESTRUCTIVE_TESTS=true` is strictly prohibited on non-test databases.

### Step 7: Build and Start Server
Compile TypeScript and launch the application:
```bash
pnpm --filter @homglai/db build
pnpm --filter @homglai/api build
pnpm --filter @homglai/api start
```
Verify readiness via `GET /api/health` (should respond `{ status: "ok", database: "connected" }`).
