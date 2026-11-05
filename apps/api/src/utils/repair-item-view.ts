import { Prisma } from '@homglai/db';

/**
 * Item response shape (Phase 2).
 *
 * - Money values are returned as strings with exactly 2 decimals.
 * - `amount` = quantity × unitPrice, computed with Prisma.Decimal (never JS floats).
 * - `price` is a temporary alias of `unitPrice` kept for one more phase so existing clients do not break.
 */
type ItemLike = {
  quantity: number;
  unitPrice: Prisma.Decimal;
  status: string;
};

export function itemAmount(item: { quantity: number; unitPrice: Prisma.Decimal }): Prisma.Decimal {
  return new Prisma.Decimal(item.unitPrice).mul(item.quantity);
}

export function toRepairItemView<T extends ItemLike>(item: T) {
  const unitPrice = new Prisma.Decimal(item.unitPrice).toFixed(2);
  return {
    ...item,
    unitPrice,
    price: unitPrice,
    amount: itemAmount(item).toFixed(2),
  };
}

/** Sum of item amounts excluding REJECTED items (no VAT / discount). */
export function computeTotalAmount(items: ItemLike[]): string {
  return items
    .filter((item) => item.status !== 'REJECTED')
    .reduce((sum, item) => sum.add(itemAmount(item)), new Prisma.Decimal(0))
    .toFixed(2);
}
