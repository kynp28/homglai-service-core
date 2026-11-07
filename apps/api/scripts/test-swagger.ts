/**
 * Phase 9: every Express route has a Swagger (OpenAPI) entry with the same method and path,
 * and Swagger documents no route that does not exist. Pure unit test: no server, no database.
 */
import type { Router } from 'express';
import { swaggerSpec } from '../src/swagger';
import authRoutes from '../src/routes/auth.routes';
import repairRoutes from '../src/routes/repair.routes';
import trackingRoutes from '../src/routes/tracking.routes';
import employeeRoutes from '../src/routes/employee.routes';
import webhookRoutes from '../src/routes/webhook.routes';
import symptomRoutes from '../src/routes/symptom.routes';
import notificationRoutes from '../src/routes/notification.routes';
import holidayRoutes from '../src/routes/holiday.routes';

// Same mount points as src/index.ts
const MOUNTS: Array<[string, Router]> = [
  ['/api/auth', authRoutes],
  ['/api/repairs', repairRoutes],
  ['/api/tracking', trackingRoutes],
  ['/api/employees', employeeRoutes],
  ['/api/webhook', webhookRoutes],
  ['/api/symptoms', symptomRoutes],
  ['/api/notifications', notificationRoutes],
  ['/api/holidays', holidayRoutes],
];
// Routes registered directly on the app in src/index.ts
const APP_ROUTES = ['GET /api/health'];

function expressRoutes(): string[] {
  const out = [...APP_ROUTES];
  for (const [prefix, router] of MOUNTS) {
    for (const layer of (router as any).stack) {
      if (!layer.route) continue;
      const path = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`.replace(/:(\w+)/g, '{$1}');
      for (const method of Object.keys(layer.route.methods)) out.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return out.sort();
}

function swaggerRoutes(): string[] {
  const out: string[] = [];
  const paths = (swaggerSpec as any).paths ?? {};
  for (const [path, ops] of Object.entries<Record<string, unknown>>(paths)) {
    for (const method of Object.keys(ops)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) out.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return out.sort();
}

console.log('==================================================================');
console.log('SWAGGER COVERAGE (every route documented, nothing extra)');
console.log('==================================================================\n');
const actual = expressRoutes();
const documented = swaggerRoutes();
const missing = actual.filter((r) => !documented.includes(r));
const extra = documented.filter((r) => !actual.includes(r));
const dupes = actual.filter((r, i) => actual.indexOf(r) !== i);
for (const r of actual) console.log(`  ${missing.includes(r) ? '[MISSING]' : '[PASS]   '} ${r}`);
if (missing.length || extra.length || dupes.length) {
  console.error(`\nSwagger Test Failed:\n  undocumented: ${JSON.stringify(missing)}\n  documented but not routed: ${JSON.stringify(extra)}\n  duplicate routes: ${JSON.stringify(dupes)}`);
  process.exit(1);
}
console.log(`\nSWAGGER TESTS PASSED (${actual.length} routes)\n`);
process.exit(0);
