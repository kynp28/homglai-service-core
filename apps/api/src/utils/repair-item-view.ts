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

/**
 * Sum of the amounts of ALL items (SRS 2: "ผลรวมของทุกรายการ"; owner confirmed REJECTED items are
 * included). No VAT / discount; the same value is shown as Sub Total and Grand Total.
 */
export function computeTotalAmount(items: ItemLike[]): string {
  return items.reduce((sum, item) => sum.add(itemAmount(item)), new Prisma.Decimal(0)).toFixed(2);
}

/** What the customer agreed to pay: APPROVED + COMPLETED items only (REJECTED/PENDING excluded). */
export function computePayableAmount(items: ItemLike[]): string {
  return items
    .filter((item) => item.status === 'APPROVED' || item.status === 'COMPLETED')
    .reduce((sum, item) => sum.add(itemAmount(item)), new Prisma.Decimal(0))
    .toFixed(2);
}

export type PaymentCheckStatus = 'NOT_RECORDED' | 'MATCHED' | 'DIFFERENT';

/**
 * Payment summary (record only — never blocks delivery). `warning` is a Thai message for staff when
 * a payable order has no payment recorded or the recorded amount differs from the payable amount.
 */
export function paymentSummary(paidAmount: Prisma.Decimal | null, payableAmount: string) {
  const payable = new Prisma.Decimal(payableAmount);
  let status: PaymentCheckStatus;
  let warning: { code: string; message: string } | null = null;
  if (paidAmount === null) {
    status = 'NOT_RECORDED';
    if (payable.gt(0)) {
      warning = { code: 'PAYMENT_NOT_RECORDED', message: `ยังไม่ได้บันทึกการรับเงิน (ยอดที่ต้องชำระ ${payableAmount} บาท)` };
    }
  } else if (new Prisma.Decimal(paidAmount).eq(payable)) {
    status = 'MATCHED';
  } else {
    status = 'DIFFERENT';
    warning = {
      code: 'PAYMENT_AMOUNT_DIFFERS',
      message: `ยอดที่รับ ${new Prisma.Decimal(paidAmount).toFixed(2)} บาท ไม่ตรงกับยอดที่ต้องชำระ ${payableAmount} บาท`,
    };
  }
  return {
    payableAmount,
    paidAmount: paidAmount === null ? null : new Prisma.Decimal(paidAmount).toFixed(2),
    status,
    warning,
  };
}
