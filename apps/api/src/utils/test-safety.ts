/**
 * Safety guard for test scripts performing destructive database operations (deleteMany, reset, seed).
 * Refuses execution if DATABASE_URL does not point to a database ending with '_test',
 * unless ALLOW_DESTRUCTIVE_TESTS=true is explicitly provided.
 */
export function assertSafeDatabaseUrl(databaseUrl?: string): void {
  const url = databaseUrl || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('FATAL: DATABASE_URL is not defined.');
  }

  let dbName = '';
  try {
    const parsed = new URL(url.replace('mysql://', 'http://'));
    dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
  } catch (_) {
    const match = url.match(/\/([^/?]+)(\?|$)/);
    if (match) dbName = match[1];
  }

  const isTestDb = dbName.endsWith('_test');
  const allowDestructive = process.env.ALLOW_DESTRUCTIVE_TESTS === 'true';

  if (!isTestDb && !allowDestructive) {
    throw new Error(
      `FATAL: Refusing to run destructive test on database "${dbName}". ` +
      `Database name must end with "_test" (e.g., homglai_db_test) or ALLOW_DESTRUCTIVE_TESTS=true must be set.`
    );
  }
}
