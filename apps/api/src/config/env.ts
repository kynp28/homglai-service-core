export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('FATAL: JWT_SECRET must be defined and at least 32 characters long.');
  }
  return secret;
}

export function getCorsOrigins(): string[] {
  const envOrigins = process.env.CORS_ORIGINS;
  if (!envOrigins) {
    return ['http://localhost:3000'];
  }
  return envOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

// ===========================================================================
// Application settings (SRS 3.3, 3.6, 6.3, 6.4)
// Every value has a default; malformed values fail at startup with a clear message.
// ===========================================================================

export type NotifierDriver = 'db';

export interface AppConfig {
  ackTimeoutMinutes: number;
  ackReminderIntervalMinutes: number;
  progressReminderIntervalMinutes: number;
  progressUnansweredAdminThreshold: number;
  /** "HH:MM" as written in the env var (Asia/Bangkok local time) */
  businessHoursStart: string;
  businessHoursEnd: string;
  /** Minutes after local midnight (Asia/Bangkok) */
  businessHoursStartMinute: number;
  businessHoursEndMinute: number;
  imageRetentionDays: number;
  jobWorkerIntervalSeconds: number;
  jobsEnabled: boolean;
  customerLineApprovalEnabled: boolean;
  publicSearchRateLimitMax: number;
  imageStorageDir: string;
  imageMaxBytes: number;
  imageMaxPerKind: number;
  imageMaxLongEdge: number;
  notifierDriver: NotifierDriver;
  /** LINE Login channel ID; LIFF access tokens must have been issued for it (Phase 6 subscribe-line) */
  lineLoginChannelId: string;
  /** 'line' verifies LIFF access tokens with LINE; 'mock' is accepted ONLY when NODE_ENV=test */
  lineIdentityVerifier: 'line' | 'mock';
}

type Env = Record<string, string | undefined>;

class ConfigReader {
  readonly errors: string[] = [];

  constructor(private readonly env: Env) {}

  /** Unset or blank values fall back to the default. */
  private raw(name: string): string | undefined {
    const value = this.env[name];
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  int(name: string, defaultValue: number, min: number, max: number): number {
    const value = this.raw(name);
    if (value === undefined) return defaultValue;
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      this.errors.push(`${name}="${value}" must be a whole number between ${min} and ${max}`);
      return defaultValue;
    }
    return Number(value);
  }

  bool(name: string, defaultValue: boolean): boolean {
    const value = this.raw(name);
    if (value === undefined) return defaultValue;
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    this.errors.push(`${name}="${value}" must be "true" or "false"`);
    return defaultValue;
  }

  /** Returns [text, minutesAfterMidnight]. Format HH:MM, 00:00-23:59. */
  time(name: string, defaultValue: string): [string, number] {
    const value = this.raw(name) ?? defaultValue;
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    if (!match) {
      this.errors.push(`${name}="${value}" must be a time in HH:MM format (00:00-23:59)`);
      const [h, m] = defaultValue.split(':').map(Number);
      return [defaultValue, h * 60 + m];
    }
    return [value, Number(match[1]) * 60 + Number(match[2])];
  }

  text(name: string, defaultValue: string): string {
    return this.raw(name) ?? defaultValue;
  }

  oneOf<T extends string>(name: string, defaultValue: T, allowed: readonly T[]): T {
    const value = this.raw(name);
    if (value === undefined) return defaultValue;
    if (!(allowed as readonly string[]).includes(value)) {
      this.errors.push(`${name}="${value}" must be one of: ${allowed.join(', ')}`);
      return defaultValue;
    }
    return value as T;
  }
}

/**
 * Parses and validates the application settings from an env object (pure: no caching, no side effects).
 * Throws one Error listing every invalid variable.
 */
export function loadAppConfig(env: Env = process.env): AppConfig {
  const r = new ConfigReader(env);
  const [businessHoursStart, businessHoursStartMinute] = r.time('BUSINESS_HOURS_START', '08:00');
  const [businessHoursEnd, businessHoursEndMinute] = r.time('BUSINESS_HOURS_END', '17:30');

  const config: AppConfig = {
    ackTimeoutMinutes: r.int('ACK_TIMEOUT_MINUTES', 60, 1, 10080),
    ackReminderIntervalMinutes: r.int('ACK_REMINDER_INTERVAL_MINUTES', 60, 1, 10080),
    progressReminderIntervalMinutes: r.int('PROGRESS_REMINDER_INTERVAL_MINUTES', 60, 1, 10080),
    progressUnansweredAdminThreshold: r.int('PROGRESS_UNANSWERED_ADMIN_THRESHOLD', 3, 1, 100),
    businessHoursStart,
    businessHoursEnd,
    businessHoursStartMinute,
    businessHoursEndMinute,
    imageRetentionDays: r.int('IMAGE_RETENTION_DAYS', 30, 1, 3650),
    jobWorkerIntervalSeconds: r.int('JOB_WORKER_INTERVAL_SECONDS', 60, 5, 86400),
    jobsEnabled: r.bool('JOBS_ENABLED', true),
    customerLineApprovalEnabled: r.bool('CUSTOMER_LINE_APPROVAL_ENABLED', false),
    publicSearchRateLimitMax: r.int('PUBLIC_SEARCH_RATE_LIMIT_MAX', 30, 1, 10000),
    imageStorageDir: r.text('IMAGE_STORAGE_DIR', './data/uploads'),
    imageMaxBytes: r.int('IMAGE_MAX_BYTES', 5242880, 1024, 52428800),
    imageMaxPerKind: r.int('IMAGE_MAX_PER_KIND', 10, 1, 100),
    imageMaxLongEdge: r.int('IMAGE_MAX_LONG_EDGE', 1600, 100, 10000),
    notifierDriver: r.oneOf('NOTIFIER_DRIVER', 'db', ['db'] as const),
    lineLoginChannelId: r.text('LINE_LOGIN_CHANNEL_ID', ''),
    lineIdentityVerifier: r.oneOf('LINE_IDENTITY_VERIFIER', 'line', ['line', 'mock'] as const),
  };

  // The mock LINE identity verifier trusts any "mock:<userId>" token: never allowed outside tests.
  if (config.lineIdentityVerifier === 'mock' && env.NODE_ENV !== 'test') {
    r.errors.push('LINE_IDENTITY_VERIFIER="mock" is only allowed when NODE_ENV=test');
  }

  if (businessHoursStartMinute >= businessHoursEndMinute) {
    r.errors.push(
      `BUSINESS_HOURS_START (${businessHoursStart}) must be earlier than BUSINESS_HOURS_END (${businessHoursEnd})`
    );
  }

  if (r.errors.length > 0) {
    throw new Error(`FATAL: Invalid configuration:\n  - ${r.errors.join('\n  - ')}`);
  }
  return Object.freeze(config);
}

let cachedConfig: AppConfig | null = null;

/** Validated settings from process.env, parsed once. Call at startup to fail fast. */
export function getAppConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = loadAppConfig(process.env);
  }
  return cachedConfig;
}
