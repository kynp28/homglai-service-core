/**
 * Transitional view helper (Phase 1).
 * The database column `price` is now exposed by Prisma as `unitPrice`.
 * Existing clients and tests still read `price`, so responses carry both keys until Phase 2
 * introduces the final item shape (quantity / amount).
 */
export function withLegacyPrice<T extends { unitPrice: unknown }>(item: T): T & { price: T['unitPrice'] } {
  return { ...item, price: item.unitPrice };
}
