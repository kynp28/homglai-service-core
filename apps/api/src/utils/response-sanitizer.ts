/**
 * Single point for role-based response redaction.
 *
 * TECHNICIAN callers must never receive `trackingToken` anywhere in a response
 * payload (top-level or nested). ADMIN and RECEPTIONIST responses are returned
 * unchanged.
 */
const TECHNICIAN_HIDDEN_KEYS = new Set<string>(['trackingToken']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Recurses only into arrays and plain objects so Date and Prisma Decimal
// instances keep their prototypes (and therefore their JSON serialization).
function omitKeysDeep(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => omitKeysDeep(entry, keys));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (keys.has(key)) continue;
      result[key] = omitKeysDeep(entry, keys);
    }
    return result;
  }
  return value;
}

export function sanitizeForRole<T>(data: T, role: string): T {
  if (role !== 'TECHNICIAN') return data;
  return omitKeysDeep(data, TECHNICIAN_HIDDEN_KEYS) as T;
}
