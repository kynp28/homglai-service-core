import { Prisma } from '@homglai/db';

/**
 * Customer fields loaded for API responses. lineUserId is loaded only to derive
 * `lineLinked` and is removed by toPublicCustomer() before any response is sent.
 */
export const customerResponseSelect = {
  id: true,
  name: true,
  phone: true,
  address: true,
  createdAt: true,
  lineUserId: true,
} satisfies Prisma.CustomerSelect;

type WithLineUserId = { lineUserId: string | null };

export type PublicCustomer<T extends WithLineUserId> = Omit<T, 'lineUserId'> & { lineLinked: boolean };

export function toPublicCustomer<T extends WithLineUserId>(customer: T): PublicCustomer<T> {
  const { lineUserId, ...rest } = customer;
  return { ...rest, lineLinked: lineUserId !== null };
}

export function withPublicCustomer<T extends { customer: WithLineUserId }>(
  order: T
): Omit<T, 'customer'> & { customer: PublicCustomer<T['customer']> } {
  return { ...order, customer: toPublicCustomer(order.customer) };
}
