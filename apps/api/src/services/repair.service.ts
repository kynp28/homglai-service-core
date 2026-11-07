import crypto from 'crypto';
import { lockOrderRow } from '../utils/order-lock';
import prisma, { Prisma, RepairStatus } from '@homglai/db';
import { OrderEvents } from './order-events';
import { AppError } from '../utils/app-error';
import { resolveAcceptTarget, validateStatusTransition } from '../config/repair-status';
import { getBangkokDateOnly, dateOnlyToDate } from '../utils/date';
import { ACCEPTED_WORK_STATUSES, AssignmentService } from './assignment.service';
import { LineWebhookService } from './line-webhook.service';
import { customerResponseSelect, lineLinkCountInclude, withPublicCustomer } from '../utils/customer-view';
import { computePayableAmount, computeTotalAmount, itemAmount, paymentSummary, toRepairItemView } from '../utils/repair-item-view';
import { activityFields, recordActivity } from '../utils/activity';
import { allocateJobNumber, resyncJobNumberCounter } from '../utils/job-number';
import { computeAllowedActions } from '../utils/allowed-actions';
import { businessMinutesBetween } from '../utils/business-hours';
import { ShopCalendarService } from './shop-calendar.service';
import { getAppConfig } from '../config/env';
import { notifySafely } from '../notifications';
import {
  AddRepairItemInput,
  CreateRepairOrderInput,
  PaymentInput,
  UpdateRepairOrderInput,
  warrantyConsistencyError,
} from '../validators/repair.validator';

/** Who is calling a service method (role decides ownership checks inside transactions). */
export interface Actor {
  id: number;
  role: string;
}

/** Orders in these states are closed: intake data can no longer be edited. */
const CLOSED_STATUSES: RepairStatus[] = ['DELIVERED', 'CANCELLED'];

const MAX_HELPERS = 10;

const PAYMENT_METHOD_TH: Record<PaymentInput['method'], string> = { CASH: 'เงินสด', TRANSFER: 'โอน', OTHER: 'อื่นๆ' };

/** Stores (or replaces) the payment record and logs it. Record only: never blocks anything. */
async function writePayment(tx: Prisma.TransactionClient, orderId: number, payment: PaymentInput, actor: Actor, now: Date) {
  const order = await tx.repairOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, paidAmount: true } });
  const amount = new Prisma.Decimal(payment.amount).toFixed(2);
  await tx.repairOrder.update({
    where: { id: orderId },
    data: {
      paidAmount: amount,
      paymentMethod: payment.method,
      paymentNote: payment.note ? payment.note : null,
      paidAt: now,
      paymentRecordedById: actor.id,
    },
  });
  const recorder = await tx.employee.findUnique({ where: { id: actor.id }, select: { name: true } });
  await tx.statusLog.create({
    data: {
      repairOrderId: orderId,
      status: order.status,
      changedById: actor.id,
      note:
        `${order.paidAmount === null ? 'บันทึกการรับเงิน' : 'แก้ไขการรับเงิน'} ${amount} บาท (${PAYMENT_METHOD_TH[payment.method]}) ` +
        `โดย ${recorder?.name ?? `#${actor.id}`} / Payment ${order.paidAmount === null ? 'recorded' : 'updated'}: ${amount} ${payment.method}` +
        (payment.note ? ` (${payment.note})` : ''),
    },
  });
}

/**
 * Frees a technician (BUSY/RESERVED -> AVAILABLE, availableSince = now) when they hold no other job
 * (reserved NEW or accepted work). Never touches OFFLINE or deactivated staff. Returns true if freed.
 */
async function releaseTechnicianIfIdle(
  tx: Prisma.TransactionClient,
  technicianId: number,
  excludeOrderId: number,
  now: Date
): Promise<boolean> {
  const remaining = await tx.repairOrder.count({
    where: {
      technicianId,
      id: { not: excludeOrderId },
      status: { in: ['NEW', ...ACCEPTED_WORK_STATUSES] },
    },
  });
  if (remaining > 0) return false;
  const freed = await tx.employee.updateMany({
    where: { id: technicianId, status: { in: ['BUSY', 'RESERVED'] }, isActive: true },
    data: { status: 'AVAILABLE', availableSince: now },
  });
  return freed.count > 0;
}

/** Helper technicians must be distinct active technicians other than the job owner. */
async function validateHelperIds(
  tx: Prisma.TransactionClient,
  ids: number[],
  ownerTechnicianId: number | null
): Promise<number[]> {
  const unique = Array.from(new Set(ids));
  if (unique.length > MAX_HELPERS) {
    throw new AppError(400, `At most ${MAX_HELPERS} helper technicians are allowed`);
  }
  if (ownerTechnicianId !== null && unique.includes(ownerTechnicianId)) {
    throw new AppError(400, 'The technician who owns the job cannot also be listed as a helper');
  }
  if (unique.length === 0) return [];
  const found = await tx.employee.count({
    where: { id: { in: unique }, role: 'TECHNICIAN', isActive: true },
  });
  if (found !== unique.length) {
    throw new AppError(400, 'Helper technicians must be active employees with the TECHNICIAN role');
  }
  return unique;
}

/** Makes the helper list exactly `ids`; existing rows keep who added them. */
async function replaceHelpers(
  tx: Prisma.TransactionClient,
  repairOrderId: number,
  ids: number[],
  addedById: number
): Promise<boolean> {
  const existing = await tx.repairOrderHelper.findMany({ where: { repairOrderId }, select: { technicianId: true } });
  const current = new Set(existing.map((h) => h.technicianId));
  const next = new Set(ids);
  const toRemove = [...current].filter((id) => !next.has(id));
  const toAdd = [...next].filter((id) => !current.has(id));
  if (toRemove.length > 0) {
    await tx.repairOrderHelper.deleteMany({ where: { repairOrderId, technicianId: { in: toRemove } } });
  }
  if (toAdd.length > 0) {
    await tx.repairOrderHelper.createMany({
      data: toAdd.map((technicianId) => ({ repairOrderId, technicianId, addedById })),
    });
  }
  return toRemove.length > 0 || toAdd.length > 0;
}

/** Returns true when a Prisma P2002 error was raised by the given unique field. */
function isUniqueViolationOn(err: any, field: string): boolean {
  if (err?.code !== 'P2002') return false;
  const target = err?.meta?.target;
  const targetText = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return targetText.includes(field) || String(err?.message ?? '').includes(field);
}

function paperReceiptConflict(paperReceiptNo: string): AppError {
  return new AppError(409, `Paper receipt number ${paperReceiptNo} is already used by another repair order`);
}

/** JSON comparison that ignores key order (MySQL JSON columns do not preserve it). */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as any)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function dateOnlyString(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** Nullable JSON input -> Prisma write value (explicit null must be written as DbNull). */
function jsonWrite(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

export class RepairService {
  static async createRepairOrder(data: CreateRepairOrderInput & { receptionistId: number }) {
    // 1. Verify all symptom IDs exist in database
    if (data.symptomIds && data.symptomIds.length > 0) {
      const existingSymptoms = await prisma.symptom.findMany({
        where: { id: { in: data.symptomIds } },
        select: { id: true },
      });
      if (existingSymptoms.length !== data.symptomIds.length) {
        throw new AppError(400, 'One or more symptom IDs do not exist in the database');
      }
    }

    // 2. Friendly early check for a duplicate paper receipt number (the unique index is the real guard)
    if (data.paperReceiptNo) {
      const duplicate = await prisma.repairOrder.findUnique({
        where: { paperReceiptNo: data.paperReceiptNo },
        select: { id: true },
      });
      if (duplicate) {
        throw paperReceiptConflict(data.paperReceiptNo);
      }
    }

    const maxRetries = 3;
    let createdOrder: any = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        createdOrder = await prisma.$transaction(async (tx) => {
          // 1. Upsert Customer (address is only overwritten when a new value is provided)
          const customer = await tx.customer.upsert({
            where: { phone: data.customer.phone },
            update: {
              name: data.customer.name,
              ...(data.customer.address ? { address: data.customer.address } : {}),
            },
            create: {
              name: data.customer.name,
              phone: data.customer.phone,
              address: data.customer.address ?? null,
            },
          });

          // 2. Machine Deduplication: Reuse if same serialNumber exists for this customer
          let machineId: number;
          const trimmedSerial = data.machine.serialNumber ? data.machine.serialNumber.trim() : null;

          if (trimmedSerial) {
            const existingMachine = await tx.machine.findFirst({
              where: {
                customerId: customer.id,
                serialNumber: trimmedSerial,
              },
            });

            if (existingMachine) {
              machineId = existingMachine.id;
            } else {
              const newMachine = await tx.machine.create({
                data: {
                  brand: data.machine.brand.trim(),
                  model: data.machine.model.trim(),
                  serialNumber: trimmedSerial,
                  customerId: customer.id,
                },
              });
              machineId = newMachine.id;
            }
          } else {
            const newMachine = await tx.machine.create({
              data: {
                brand: data.machine.brand.trim(),
                model: data.machine.model.trim(),
                serialNumber: null,
                customerId: customer.id,
              },
            });
            machineId = newMachine.id;
          }

          // 3. Job number from the counter table (Bangkok month). Serialised by the counter row lock,
          //    so concurrent intakes never collide. After an unexpected collision the counter is
          //    first moved past the stored maximum.
          if (attempt > 0) {
            await resyncJobNumberCounter(tx);
          }
          const jobNumber = await allocateJobNumber(tx);

          const trackingToken = crypto.randomBytes(24).toString('base64url');
          const now = new Date();

          // 4. Create Repair Order with Symptoms and initial StatusLog
          const repairOrder = await tx.repairOrder.create({
            data: {
              jobNumber,
              trackingToken,
              customerId: customer.id,
              machineId,
              otherSymptom: data.otherSymptom || null,
              status: 'NEW',
              receivedDate: data.receivedDate ? dateOnlyToDate(data.receivedDate) : getBangkokDateOnly(now),
              workType: 'REPAIR',
              paperBookNo: data.paperBookNo ?? null,
              paperReceiptNo: data.paperReceiptNo ?? null,
              warrantyStatus: data.warrantyStatus ?? null,
              warrantyExpiryDate: data.warrantyExpiryDate ? dateOnlyToDate(data.warrantyExpiryDate) : null,
              billingType: data.billingType ?? null,
              loanerMachine: data.loanerMachine ?? false,
              loanerNote: data.loanerNote ?? null,
              accessories: jsonWrite(data.accessories),
              careAdvice: jsonWrite(data.careAdvice),
              warningNote: data.warningNote ?? null,
              lastActivityAt: now,
              symptoms: {
                create: data.symptomIds.map((id) => ({ symptomId: id })),
              },
              statusLogs: {
                create: {
                  status: 'NEW',
                  changedById: data.receptionistId,
                  note: 'Opened new repair order',
                },
              },
            },
            include: {
              customer: { select: customerResponseSelect },
        ...lineLinkCountInclude,
              machine: true,
              symptoms: { include: { symptom: true } },
            },
          });

          return repairOrder;
        });

        break;
      } catch (err: any) {
        // A duplicate paper receipt number is a user error: never retry it (the retry loop is for jobNumber races)
        if (data.paperReceiptNo && isUniqueViolationOn(err, 'paperReceiptNo')) {
          throw paperReceiptConflict(data.paperReceiptNo);
        }
        // Only a jobNumber collision is retried (counter behind hand-inserted data); it resyncs first.
        if (isUniqueViolationOn(err, 'jobNumber') && attempt < maxRetries - 1) {
          continue;
        }
        throw err;
      }
    }

    if (!createdOrder) {
      throw new AppError(500, 'Failed to generate unique job number after multiple retries');
    }

    // Trigger auto-queue matching post-commit
    await AssignmentService.processQueue();

    // Re-fetch to return latest assigned state if matched immediately
    const finalOrder = await prisma.repairOrder.findUnique({
      where: { id: createdOrder.id },
      include: {
        customer: { select: customerResponseSelect },
        ...lineLinkCountInclude,
        machine: true,
        symptoms: { include: { symptom: true } },
        technician: {
          select: { id: true, name: true, status: true },
        },
      },
    });

    return withPublicCustomer(finalOrder ?? createdOrder);
  }

  /**
   * PATCH /api/repairs/:id — edit intake data only (paper form, customer name/address, machine,
   * symptoms, warranty, accessories, loaner, billing, care advice, warning note).
   * status / technicianId / jobNumber are rejected by the validator. Closed orders cannot be edited.
   * A StatusLog (current status) records who changed which fields (names only, no values).
   */
  static async updateRepairOrderIntake(
    id: number,
    input: UpdateRepairOrderInput,
    user: { id: number; role: string }
  ) {
    if (input.symptomIds) {
      const uniqueIds = Array.from(new Set(input.symptomIds));
      const existing = await prisma.symptom.count({ where: { id: { in: uniqueIds } } });
      if (existing !== uniqueIds.length) {
        throw new AppError(400, 'One or more symptom IDs do not exist in the database');
      }
    }

    if (input.paperReceiptNo) {
      const duplicate = await prisma.repairOrder.findFirst({
        where: { paperReceiptNo: input.paperReceiptNo, id: { not: id } },
        select: { id: true },
      });
      if (duplicate) {
        throw paperReceiptConflict(input.paperReceiptNo);
      }
    }

    try {
      await prisma.$transaction(async (tx) => {
        const order = await tx.repairOrder.findUnique({
          where: { id },
          include: { customer: true, machine: true, symptoms: true },
        });

        if (!order) {
          throw new AppError(404, 'Repair order not found');
        }
        if (CLOSED_STATUSES.includes(order.status)) {
          throw new AppError(409, `Cannot edit intake data of a ${order.status} repair order`);
        }

        const changedFields: string[] = [];
        const orderData: Prisma.RepairOrderUpdateManyMutationInput = {};

        // --- Simple scalar fields
        const scalarFields = [
          'paperBookNo',
          'paperReceiptNo',
          'otherSymptom',
          'warrantyStatus',
          'billingType',
          'loanerMachine',
          'loanerNote',
          'warningNote',
        ] as const;
        for (const field of scalarFields) {
          if (!(field in input)) continue;
          const next = (input as any)[field] ?? null;
          if (next !== ((order as any)[field] ?? null)) {
            (orderData as any)[field] = next;
            changedFields.push(field);
          }
        }

        // --- Date-only fields
        for (const field of ['receivedDate', 'warrantyExpiryDate'] as const) {
          if (!(field in input)) continue;
          const next = (input as any)[field] as string | null;
          if (field === 'receivedDate' && next === null) continue; // receivedDate is NOT NULL
          if (next !== dateOnlyString((order as any)[field])) {
            (orderData as any)[field] = next ? dateOnlyToDate(next) : null;
            changedFields.push(field);
          }
        }

        // --- JSON fields
        for (const field of ['accessories', 'careAdvice'] as const) {
          if (!(field in input)) continue;
          const next = (input as any)[field];
          if (canonicalJson(next) !== canonicalJson((order as any)[field])) {
            (orderData as any)[field] = jsonWrite(next);
            changedFields.push(field);
          }
        }

        // --- Warranty consistency is checked on the merged (stored + edited) values
        const mergedWarrantyStatus = 'warrantyStatus' in input ? input.warrantyStatus : order.warrantyStatus;
        const mergedExpiry = 'warrantyExpiryDate' in input ? input.warrantyExpiryDate : order.warrantyExpiryDate;
        const warrantyError = warrantyConsistencyError(mergedWarrantyStatus, mergedExpiry);
        if (warrantyError) {
          throw new AppError(400, warrantyError);
        }

        // --- Customer (name / address only; phone is the customer identity and cannot change here)
        const customerData: Prisma.CustomerUpdateInput = {};
        if (input.customer) {
          if (input.customer.name !== undefined && input.customer.name !== order.customer.name) {
            customerData.name = input.customer.name;
            changedFields.push('customer.name');
          }
          if ('address' in input.customer && (input.customer.address ?? null) !== (order.customer.address ?? null)) {
            customerData.address = input.customer.address ?? null;
            changedFields.push('customer.address');
          }
        }

        // --- Machine
        const machineData: Prisma.MachineUpdateInput = {};
        if (input.machine) {
          for (const field of ['brand', 'model', 'serialNumber'] as const) {
            if (!(field in input.machine)) continue;
            const next = (input.machine as any)[field] ?? null;
            if (next !== ((order.machine as any)[field] ?? null)) {
              (machineData as any)[field] = next;
              changedFields.push(`machine.${field}`);
            }
          }
        }

        // --- Symptoms
        let nextSymptomIds: number[] | null = null;
        if (input.symptomIds) {
          const next = Array.from(new Set(input.symptomIds)).sort((a, b) => a - b);
          const current = order.symptoms.map((s) => s.symptomId).sort((a, b) => a - b);
          if (next.join(',') !== current.join(',')) {
            nextSymptomIds = next;
            changedFields.push('symptomIds');
          }
        }

        if (changedFields.length === 0) {
          return; // nothing to change: no writes, no log
        }

        // Conditional write: fails if the order was closed concurrently
        const guarded = await tx.repairOrder.updateMany({
          where: { id, status: { notIn: CLOSED_STATUSES } },
          data: { ...orderData, updatedAt: new Date() },
        });
        if (guarded.count === 0) {
          throw new AppError(409, 'Repair order was closed or changed concurrently; intake data was not updated');
        }

        if (Object.keys(customerData).length > 0) {
          await tx.customer.update({ where: { id: order.customerId }, data: customerData });
        }
        if (Object.keys(machineData).length > 0) {
          await tx.machine.update({ where: { id: order.machineId }, data: machineData });
        }
        if (nextSymptomIds) {
          await tx.repairOrderSymptom.deleteMany({ where: { repairOrderId: id } });
          await tx.repairOrderSymptom.createMany({
            data: nextSymptomIds.map((symptomId) => ({ repairOrderId: id, symptomId })),
          });
        }

        await tx.statusLog.create({
          data: {
            repairOrderId: id,
            status: order.status,
            changedById: user.id,
            note: `Intake data edited by ${user.role}. Changed fields: ${changedFields.join(', ')}`,
          },
        });
      });
    } catch (err: any) {
      if (input.paperReceiptNo && isUniqueViolationOn(err, 'paperReceiptNo')) {
        throw paperReceiptConflict(input.paperReceiptNo);
      }
      throw err;
    }

    return RepairService.getRepairOrderById(id, user);
  }

  static async addRepairItem(
    repairOrderId: number,
    data: AddRepairItemInput & { technicianId: number; actorRole?: string }
  ) {
    const unitPrice = new Prisma.Decimal(data.unitPrice.toFixed(2));

    const threshold = getAppConfig().priceApprovalThreshold;

    const { order, item, previousStatus, autoApproved } = await prisma.$transaction(async (tx) => {
      // Row lock: the order total used for the approval threshold must not change under us
      const locked = await lockOrderRow(tx, repairOrderId);
      if (!locked) {
        throw new AppError(404, 'Repair order not found');
      }
      const existingOrder = await tx.repairOrder.findUnique({
        where: { id: repairOrderId },
      });

      if (!existingOrder) {
        throw new AppError(404, 'Repair order not found');
      }

      // Ownership is re-checked inside the transaction: the order may have been returned to the
      // pool (technician deactivated) after the controller's check.
      if (data.actorRole === 'TECHNICIAN' && existingOrder.technicianId !== data.technicianId) {
        throw new AppError(403, 'Forbidden: Only the assigned technician or an admin can add items');
      }

      // Items can only be added during active inspection or repair phases
      if (!['INSPECTING', 'WAITING_APPROVAL', 'REPAIRING'].includes(existingOrder.status)) {
        throw new AppError(
          409,
          `Cannot add repair items when order is in ${existingOrder.status} status`
        );
      }

      // Price confirmation threshold (owner decision 2026-11-07): the customer is called only when the
      // order total (all item types, REJECTED excluded, this item included) reaches the threshold.
      // While another item is still PENDING the order is already waiting, so the new item waits too.
      const now = new Date();
      const currentItems = await tx.repairItem.findMany({
        where: { repairOrderId, status: { in: ['PENDING', 'APPROVED', 'COMPLETED'] } },
        select: { quantity: true, unitPrice: true, status: true },
      });
      const newAmount = unitPrice.mul(data.quantity);
      const orderTotal = currentItems.reduce((sum, i) => sum.add(itemAmount(i)), newAmount);
      const autoApprove =
        threshold > 0 &&
        orderTotal.lt(threshold) &&
        !currentItems.some((i) => i.status === 'PENDING') &&
        existingOrder.status !== 'WAITING_APPROVAL';

      // 1. Create the item (PENDING, or APPROVED by the system below the threshold)
      const createdItem = await tx.repairItem.create({
        data: {
          repairOrderId,
          name: data.name.trim(),
          quantity: data.quantity,
          unitPrice,
          barcode: data.barcode ?? null,
          itemType: data.itemType,
          status: autoApprove ? 'APPROVED' : 'PENDING',
          ...(autoApprove
            ? {
                resolvedAt: now,
                resolutionNote: `อนุมัติอัตโนมัติ: ยอดรวมใบงาน ${orderTotal.toFixed(2)} บาท ต่ำกว่า ${threshold} บาท`,
              }
            : {}),
        },
      });

      // 2. Order status: WAITING_APPROVAL when the customer must confirm, otherwise REPAIRING
      //    (adding an item counts as activity, SRS 3.6).
      //    Conditional: fails if the order changed status or technician concurrently.
      const target: RepairStatus = autoApprove ? 'REPAIRING' : 'WAITING_APPROVAL';
      const guarded = await tx.repairOrder.updateMany({
        where: { id: repairOrderId, status: existingOrder.status, technicianId: existingOrder.technicianId },
        data: { status: target, ...activityFields(now) },
      });
      if (guarded.count === 0) {
        throw new AppError(409, 'Repair order changed concurrently; item was not added');
      }
      const updatedOrder = await tx.repairOrder.findUniqueOrThrow({ where: { id: repairOrderId } });

      // 3. Log the item (and status transition)
      const itemText = `(${data.itemType}): ${data.name.trim()} x${data.quantity} @ ${unitPrice.toFixed(2)} THB`;
      await tx.statusLog.create({
        data: {
          repairOrderId,
          status: target,
          changedById: data.technicianId,
          note: autoApprove
            ? `Added item ${itemText} — auto-approved (order total ${orderTotal.toFixed(2)} THB below ${threshold} THB)`
            : `Added quotation item ${itemText}`,
        },
      });

      return { order: updatedOrder, item: createdItem, previousStatus: existingOrder.status, autoApproved: autoApprove };
    });

    const itemView = toRepairItemView(item);

    // Broadcast SSE strictly post-commit (exclude sensitive technician/customer IDs)
    // Public SSE carries { status, updatedAt } only; customers get a LINE status message when it changed
    if (previousStatus !== order.status) {
      OrderEvents.statusChanged(order);
    } else {
      OrderEvents.touched(order);
    }

    // Send push notification to LINE customer with approval actions (only when confirmation is needed)
    if (!autoApproved) {
      LineWebhookService.notifyCustomerNewItem(repairOrderId, {
        id: item.id,
        name: item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name,
        price: itemView.amount,
      }).catch(() => {});
    }

    return { order, item: itemView, autoApproved };
  }

  static async completeRepairItem(repairOrderId: number, itemId: number, actor: Actor) {
    const userId = actor.id;
    const { order, item } = await prisma.$transaction(async (tx) => {
      // Row lock first: ownership and the item status are checked against the latest data, and two
      // presses on the same item (or a requeue of the job) run one after the other
      const locked = await lockOrderRow(tx, repairOrderId);
      if (!locked) {
        throw new AppError(404, 'Repair order not found');
      }
      if (actor.role === 'RECEPTIONIST') {
        throw new AppError(403, 'Forbidden: Receptionists cannot complete repair items');
      }
      if (actor.role === 'TECHNICIAN' && locked.technicianId !== actor.id) {
        throw new AppError(403, 'Forbidden: Only the assigned technician or an admin can complete items');
      }
      const existingOrder = await tx.repairOrder.findUnique({
        where: { id: repairOrderId },
      });

      if (!existingOrder) {
        throw new AppError(404, 'Repair order not found');
      }

      const existingItem = await tx.repairItem.findFirst({
        where: { id: itemId, repairOrderId },
      });

      if (!existingItem) {
        throw new AppError(404, 'Repair item not found for this order');
      }

      if (existingItem.status !== 'APPROVED') {
        throw new AppError(
          409,
          `Cannot mark item as COMPLETED. Current status is ${existingItem.status} (must be APPROVED)`
        );
      }

      const updatedItem = await tx.repairItem.update({
        where: { id: itemId },
        data: { status: 'COMPLETED' },
      });
      await recordActivity(tx, repairOrderId);

      await tx.statusLog.create({
        data: {
          repairOrderId,
          status: existingOrder.status,
          changedById: userId,
          note: `Quotation item "${updatedItem.name}" completed`,
        },
      });

      return { order: existingOrder, item: updatedItem };
    });

    // Broadcast SSE post-commit
    OrderEvents.touched({ trackingToken: order.trackingToken, status: order.status });

    return { order, item: toRepairItemView(item) };
  }

  /**
   * Records the customer's decision on one quotation item (SRS 3.4).
   * PHONE: staff (the assigned TECHNICIAN, RECEPTIONIST or ADMIN) record the result of a phone call;
   *        resolvedById / resolvedAt / resolutionChannel / resolutionNote are stored as evidence.
   * LINE:  the customer pressed approve/reject in LINE (only when CUSTOMER_LINE_APPROVAL_ENABLED);
   *        resolvedById stays null.
   * When every item is decided: at least one approved -> REPAIRING, all rejected -> INSPECTING.
   */
  static async resolveRepairItem(
    repairOrderId: number,
    itemId: number,
    status: 'APPROVED' | 'REJECTED',
    resolution: { channel: 'PHONE' | 'LINE'; actor?: Actor | null; note?: string | null } = { channel: 'PHONE' }
  ) {
    const actor = resolution.actor ?? null;

    const { item, order, pendingCount } = await prisma.$transaction(async (tx) => {
      const existingOrder = await tx.repairOrder.findUnique({
        where: { id: repairOrderId },
      });

      if (!existingOrder) {
        throw new AppError(404, 'Repair order not found');
      }

      if (actor?.role === 'TECHNICIAN' && existingOrder.technicianId !== actor.id) {
        throw new AppError(403, 'Forbidden: Only the assigned technician can record the price confirmation for this order');
      }

      if (existingOrder.status !== 'WAITING_APPROVAL') {
        throw new AppError(
          409,
          `Cannot resolve quotation items when order status is ${existingOrder.status}`
        );
      }

      const now = new Date();

      // Atomically update only if item belongs to this order and is currently PENDING
      const updateRes = await tx.repairItem.updateMany({
        where: { id: itemId, repairOrderId, status: 'PENDING' },
        data: {
          status,
          resolvedById: resolution.channel === 'PHONE' ? actor?.id ?? null : null,
          resolvedAt: now,
          resolutionChannel: resolution.channel,
          resolutionNote: resolution.note ?? null,
        },
      });

      if (updateRes.count === 0) {
        throw new AppError(
          409,
          'Quotation item not found or has already been resolved'
        );
      }

      const updatedItem = await tx.repairItem.findUniqueOrThrow({
        where: { id: itemId },
      });

      // Recording a result counts as activity (SRS 3.6)
      await recordActivity(tx, repairOrderId, now);

      // Check remaining pending items
      const remainingPending = await tx.repairItem.count({
        where: { repairOrderId, status: 'PENDING' },
      });

      if (remainingPending === 0) {
        const approvedCount = await tx.repairItem.count({
          where: { repairOrderId, status: 'APPROVED' },
        });

        // If at least one item was approved, resume repair; if all rejected, return to INSPECTING
        const target: RepairStatus = approvedCount > 0 ? 'REPAIRING' : 'INSPECTING';

        const guarded = await tx.repairOrder.updateMany({
          where: { id: repairOrderId, status: 'WAITING_APPROVAL' },
          data: { status: target, ...activityFields(now) },
        });
        if (guarded.count === 0) {
          throw new AppError(409, 'Repair order changed concurrently; please retry');
        }

        const note =
          resolution.channel === 'PHONE'
            ? `All quotation items resolved by phone confirmation (${approvedCount} approved), recorded by ${actor?.role ?? 'staff'}. Auto-transitioned to ${target}.`
            : `All quotation items resolved by the customer via LINE (${approvedCount} approved). Auto-transitioned to ${target}.`;

        await tx.statusLog.create({
          data: {
            repairOrderId,
            status: target,
            changedById: resolution.channel === 'PHONE' ? actor?.id ?? null : null,
            note,
          },
        });
      }

      const updatedOrder = await tx.repairOrder.findUniqueOrThrow({ where: { id: repairOrderId } });

      return {
        item: updatedItem,
        order: updatedOrder,
        pendingCount: remainingPending,
      };
    });

    // Broadcast SSE strictly post-commit
    if (pendingCount === 0) {
      OrderEvents.statusChanged(order); // every item decided -> REPAIRING or INSPECTING
    } else {
      OrderEvents.touched(order);
    }

    return { item: toRepairItemView(item), order };
  }

  static async updateStatus(id: number, status: RepairStatus, actor: Actor, note?: string, payment?: PaymentInput) {
    if (payment && status !== 'DELIVERED') {
      throw new AppError(400, 'payment can only be sent with status DELIVERED');
    }
    // Completing goes through the single completion path (same rules as POST /complete)
    if (status === 'COMPLETED') {
      return RepairService.completeOrder(id, actor, { note });
    }
    const userId = actor.id;
    const { updatedOrder, freedTechnicianId, requeuedForRework, reworkReservedFor } = await prisma.$transaction(async (tx) => {
      const order = await tx.repairOrder.findUnique({
        where: { id },
      });

      if (!order) {
        throw new AppError(404, 'Repair order not found');
      }

      // Ownership re-checked inside the transaction (the order may have been returned to the pool)
      if (actor.role === 'TECHNICIAN' && order.technicianId !== actor.id) {
        throw new AppError(403, 'Forbidden: You are not the assigned technician for this order');
      }

      // Enforce state transition rules (matrix, same status 409, manual INSPECTING/WAITING_APPROVAL prohibition)
      validateStatusTransition(order.status, status);

      // D.1(a): Cannot leave WAITING_APPROVAL unless 0 PENDING items remain or target is CANCELLED
      if (order.status === 'WAITING_APPROVAL' && status !== 'CANCELLED') {
        const pendingCount = await tx.repairItem.count({
          where: { repairOrderId: id, status: 'PENDING' },
        });
        if (pendingCount > 0) {
          throw new AppError(
            409,
            `Cannot leave WAITING_APPROVAL: ${pendingCount} quotation item(s) are still PENDING approval`
          );
        }
      }

      // D.3: COMPLETED -> REPAIRING (rework). Owner decision 2026-11-05: a rework is always offered
      // like a new job — reserved, notified (JOB_RESERVED) and accepted — never handed over silently.
      //  - original technician AVAILABLE -> reserved for them
      //  - otherwise -> head of the job pool (queuePriority 1); processQueue reserves it for whoever is free
      // On accept the job resumes at REPAIRING (or INSPECTING when no item was approved).
      const currentTechId = order.technicianId;
      if (order.status === 'COMPLETED' && status === 'REPAIRING') {
        const now = new Date();
        let reservedFor: { id: number; name: string } | null = null;
        if (order.technicianId) {
          const claimed = await tx.employee.updateMany({
            where: { id: order.technicianId, role: 'TECHNICIAN', status: 'AVAILABLE', isActive: true },
            data: { status: 'RESERVED' },
          });
          if (claimed.count > 0) {
            reservedFor = await tx.employee.findUniqueOrThrow({
              where: { id: order.technicianId },
              select: { id: true, name: true },
            });
          }
        }

        const moved = await tx.repairOrder.updateMany({
          where: { id, status: 'COMPLETED', technicianId: order.technicianId },
          data: {
            status: 'NEW',
            technicianId: reservedFor ? reservedFor.id : null,
            assignedAt: reservedFor ? now : null,
            acknowledgedAt: null,
            ackReminderCount: 0,
            lastAckReminderAt: null,
            queuePriority: 1,
            repairOutcome: null,
            ...activityFields(now),
          },
        });
        if (moved.count === 0) {
          throw new AppError(409, 'Repair order changed concurrently; status was not updated');
        }
        await tx.statusLog.create({
          data: {
            repairOrderId: id,
            status: 'NEW',
            changedById: userId,
            note:
              (reservedFor
                ? `ตีกลับซ่อมใหม่ จองให้ช่างเดิม ${reservedFor.name} รอกดรับ / ` +
                  `Rework requested; reserved for the original technician ${reservedFor.name}, waiting for acceptance`
                : 'ตีกลับซ่อมใหม่ ช่างเดิมไม่ว่าง ส่งเข้าคิวลำดับแรก / ' +
                  'Rework requested; original technician not AVAILABLE, returned to the head of the job pool') +
              (note ? ` (${note})` : ''),
          },
        });
        const reworkOrder = await tx.repairOrder.findUniqueOrThrow({
          where: { id },
          include: { customer: { select: customerResponseSelect },
        ...lineLinkCountInclude, machine: true },
        });
        return {
          updatedOrder: reworkOrder,
          freedTechnicianId: null,
          requeuedForRework: true,
          reworkReservedFor: reservedFor ? reservedFor.id : null,
        };
      }

      // 1. Update repair order status (conditional: fails if changed concurrently)
      const now = new Date();
      const guarded = await tx.repairOrder.updateMany({
        where: { id, status: order.status, technicianId: order.technicianId },
        data: {
          status,
          technicianId: currentTechId,
          ...(status === 'DELIVERED' || status === 'CANCELLED' ? { closedAt: now } : {}),
          ...(order.status === 'COMPLETED' && status === 'REPAIRING' ? { repairOutcome: null } : {}),
          ...activityFields(now),
        },
      });
      if (guarded.count === 0) {
        throw new AppError(409, 'Repair order changed concurrently; status was not updated');
      }
      // Status log first, then the payment log, so the history reads in order
      await tx.statusLog.create({
        data: {
          repairOrderId: id,
          status,
          changedById: userId,
          note: note || `Status updated to ${status}`,
        },
      });
      if (payment) {
        await writePayment(tx, id, payment, actor, now);
      }
      const updated = await tx.repairOrder.findUniqueOrThrow({
        where: { id },
        include: { customer: { select: customerResponseSelect },
        ...lineLinkCountInclude, machine: true },
      });


      let technicianFreed: number | null = null;

      // 3. Free the technician when the order reaches COMPLETED / DELIVERED / CANCELLED and they hold
      //    nothing else. Covers cancelling a reserved (not yet accepted) order: RESERVED -> AVAILABLE.
      //    Only BUSY/RESERVED active technicians are freed (never flips OFFLINE or deactivated staff).
      if (['DELIVERED', 'CANCELLED'].includes(status) && order.technicianId) {
        if (await releaseTechnicianIfIdle(tx, order.technicianId, order.id, now)) {
          technicianFreed = order.technicianId;
        }
      }

      return { updatedOrder: updated, freedTechnicianId: technicianFreed, requeuedForRework: false, reworkReservedFor: null };
    });

    // Broadcast SSE strictly post-commit
    OrderEvents.statusChanged(updatedOrder);


    // Rework reserved for the original technician: same notification as any reserved job
    if (reworkReservedFor !== null) {
      await notifySafely({
        type: 'JOB_RESERVED',
        technicianId: reworkReservedFor,
        repairOrderId: updatedOrder.id,
        jobNumber: updatedOrder.jobNumber,
        machine: { brand: updatedOrder.machine.brand, model: updatedOrder.machine.model },
        rework: true,
      });
    }

    // If technician was freed (or a rework was pooled), attempt to match next pending job
    if (freedTechnicianId || requeuedForRework) {
      await AssignmentService.processQueue();
    }

    if (status === 'DELIVERED') {
      // Delivery never waits for payment; staff get the payment check (and a Thai warning) back
      const items = await prisma.repairItem.findMany({
        where: { repairOrderId: id },
        select: { quantity: true, unitPrice: true, status: true },
      });
      const { paidAmount, ...rest } = updatedOrder;
      return withPublicCustomer({
        ...rest,
        payment: {
          ...paymentSummary(paidAmount, computePayableAmount(items)),
          method: updatedOrder.paymentMethod,
          note: updatedOrder.paymentNote,
          paidAt: updatedOrder.paidAt,
        },
      });
    }
    return withPublicCustomer(updatedOrder);
  }

  /**
   * POST /api/repairs/:id/complete (and PATCH /status -> COMPLETED for ADMIN/RECEPTIONIST).
   * REPAIRING -> COMPLETED. Every APPROVED item must already be COMPLETED (409 with the count).
   * Optional completionSummary and helper technicians (owner request). The technician becomes
   * AVAILABLE if they hold no other job, and the queue runs again.
   */
  static async completeOrder(
    id: number,
    actor: Actor,
    input: {
      completionSummary?: string | null;
      helperTechnicianIds?: number[];
      note?: string;
      outcome?: 'REPAIRED' | 'NOT_REPAIRED';
    }
  ) {
    const outcome = input.outcome ?? 'REPAIRED';
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.repairOrder.findUnique({ where: { id } });
      if (!order) {
        throw new AppError(404, 'Repair order not found');
      }
      if (actor.role === 'TECHNICIAN' && order.technicianId !== actor.id) {
        throw new AppError(403, 'Forbidden: You are not the assigned technician for this order');
      }
      if (order.status === 'COMPLETED') {
        throw new AppError(409, 'Repair order is already in status COMPLETED');
      }
      // REPAIRED needs REPAIRING. NOT_REPAIRED (customer declined) may also close an INSPECTING order,
      // e.g. after every quoted item was rejected; an approved inspection fee is closed from REPAIRING.
      const allowedFrom: RepairStatus[] = outcome === 'NOT_REPAIRED' ? ['INSPECTING', 'REPAIRING'] : ['REPAIRING'];
      if (!allowedFrom.includes(order.status)) {
        throw new AppError(
          409,
          outcome === 'NOT_REPAIRED'
            ? `Only an INSPECTING or REPAIRING order can be closed as NOT_REPAIRED (current status ${order.status})`
            : `Only a REPAIRING order can be completed (current status ${order.status})`
        );
      }

      // D.4: approved items must all be marked COMPLETED first
      const approvedNotCompleted = await tx.repairItem.count({
        where: { repairOrderId: id, status: 'APPROVED' },
      });
      if (approvedNotCompleted > 0) {
        throw new AppError(
          409,
          `Cannot complete repair order: ${approvedNotCompleted} approved item(s) must be marked as COMPLETED first`,
          { approvedItemsNotCompleted: approvedNotCompleted }
        );
      }

      const helperIds =
        input.helperTechnicianIds !== undefined
          ? await validateHelperIds(tx, input.helperTechnicianIds, order.technicianId)
          : null;

      const now = new Date();
      const guarded = await tx.repairOrder.updateMany({
        where: { id, status: order.status, technicianId: order.technicianId },
        data: {
          status: 'COMPLETED',
          repairOutcome: outcome,
          ...(input.completionSummary !== undefined ? { completionSummary: input.completionSummary } : {}),
          ...activityFields(now),
        },
      });
      if (guarded.count === 0) {
        throw new AppError(409, 'Repair order changed concurrently; it was not completed');
      }

      if (helperIds) {
        await replaceHelpers(tx, id, helperIds, actor.id);
      }

      await tx.statusLog.create({
        data: {
          repairOrderId: id,
          status: 'COMPLETED',
          changedById: actor.id,
          note:
            input.note ||
            (outcome === 'NOT_REPAIRED' ? 'ปิดงานแบบไม่ซ่อม (ลูกค้าไม่ซ่อม) / Closed without repair (customer declined)' : 'Repair completed') +
              (helperIds && helperIds.length > 0 ? ` with ${helperIds.length} helper technician(s)` : ''),
        },
      });

      const freed = order.technicianId
        ? await releaseTechnicianIfIdle(tx, order.technicianId, id, now)
        : false;

      return { trackingToken: order.trackingToken, jobNumber: order.jobNumber, freed };
    });

    // Post-commit: status-only SSE, customer notification, next job for the freed technician
    OrderEvents.statusChanged({ id, trackingToken: result.trackingToken, status: 'COMPLETED' });
    if (result.freed) {
      await AssignmentService.processQueue();
    }

    return RepairService.getRepairOrderById(id, actor);
  }

  /**
   * POST /api/repairs/:id/still-working — "ยังซ่อมอยู่" (SRS 3.6). Restarts the progress timer and
   * clears the unanswered-reminder counter. Only for INSPECTING / WAITING_APPROVAL / REPAIRING.
   */
  static async stillWorking(id: number, actor: Actor) {
    await prisma.$transaction(async (tx) => {
      const order = await tx.repairOrder.findUnique({ where: { id } });
      if (!order) {
        throw new AppError(404, 'Repair order not found');
      }
      if (actor.role === 'TECHNICIAN' && order.technicianId !== actor.id) {
        throw new AppError(403, 'Forbidden: You are not the assigned technician for this order');
      }
      if (!ACCEPTED_WORK_STATUSES.includes(order.status)) {
        throw new AppError(409, `"Still working" is only available while inspecting, waiting for approval or repairing (status ${order.status})`);
      }
      const guarded = await tx.repairOrder.updateMany({
        where: { id, status: order.status, technicianId: order.technicianId },
        data: activityFields(new Date()),
      });
      if (guarded.count === 0) {
        throw new AppError(409, 'Repair order changed concurrently; please retry');
      }
      await tx.statusLog.create({
        data: { repairOrderId: id, status: order.status, changedById: actor.id, note: 'Still working (progress confirmed)' },
      });
    });
    return RepairService.getRepairOrderById(id, actor);
  }

  /**
   * PUT /api/repairs/:id/helpers — ADMIN/RECEPTIONIST set the helper technicians of a job
   * (informational only) until it is DELIVERED or CANCELLED.
   */
  static async setHelpers(id: number, actor: Actor, technicianIds: number[]) {
    await prisma.$transaction(async (tx) => {
      // Row lock: two edits at the same moment run one after the other (the later one wins, both logged)
      if (!(await lockOrderRow(tx, id))) {
        throw new AppError(404, 'Repair order not found');
      }
      const order = await tx.repairOrder.findUnique({ where: { id } });
      if (!order) {
        throw new AppError(404, 'Repair order not found');
      }
      if (CLOSED_STATUSES.includes(order.status)) {
        throw new AppError(409, `Cannot change helper technicians of a ${order.status} repair order`);
      }
      const ids = await validateHelperIds(tx, technicianIds, order.technicianId);
      const changed = await replaceHelpers(tx, id, ids, actor.id);
      if (changed) {
        const names = ids.length
          ? (await tx.employee.findMany({ where: { id: { in: ids } }, select: { name: true }, orderBy: { id: 'asc' } }))
              .map((e) => e.name)
              .join(', ')
          : 'none';
        await tx.statusLog.create({
          data: {
            repairOrderId: id,
            status: order.status,
            changedById: actor.id,
            note: `Helper technicians updated by ${actor.role}: ${names}`,
          },
        });
      }
    });
    return RepairService.getRepairOrderById(id, actor);
  }

  /**
   * POST /api/repairs/:id/accept — the assigned TECHNICIAN (or an ADMIN on their behalf) accepts a
   * reserved job. NEW -> INSPECTING for a normal job; a job returned from a deactivated technician
   * resumes at WAITING_APPROVAL / REPAIRING / INSPECTING depending on its items. Technician RESERVED -> BUSY.
   */
  static async acceptOrder(id: number, actor: Actor) {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.repairOrder.findUnique({
        where: { id },
        include: {
          technician: { select: { id: true, name: true } },
          repairItems: { select: { status: true } },
        },
      });
      if (!order) {
        throw new AppError(404, 'Repair order not found');
      }
      if (actor.role === 'TECHNICIAN' && order.technicianId !== actor.id) {
        throw new AppError(403, 'Forbidden: This job is not assigned to you');
      }
      if (order.status !== 'NEW' || order.technicianId === null || order.acknowledgedAt !== null) {
        throw new AppError(409, `Repair order is not waiting for acceptance (status ${order.status})`);
      }

      const target = resolveAcceptTarget(order.repairItems.map((i) => i.status));
      const now = new Date();

      const claimed = await tx.repairOrder.updateMany({
        where: { id, status: 'NEW', technicianId: order.technicianId, acknowledgedAt: null },
        data: {
          status: target,
          acknowledgedAt: now,
          ackReminderCount: 0,
          lastAckReminderAt: null,
          queuePriority: 0,
          ...activityFields(now),
        },
      });
      if (claimed.count === 0) {
        throw new AppError(409, 'Repair order was already accepted or changed concurrently');
      }

      const techUpdate = await tx.employee.updateMany({
        where: { id: order.technicianId, status: 'RESERVED' },
        data: { status: 'BUSY' },
      });
      if (techUpdate.count === 0) {
        throw new AppError(409, 'Assigned technician is not RESERVED; ask an ADMIN to release the job');
      }

      let note: string;
      if (actor.role === 'TECHNICIAN') {
        note = 'Accepted by technician';
      } else {
        const actorEmployee = await tx.employee.findUnique({ where: { id: actor.id }, select: { name: true } });
        note = `Accepted by ${actor.role} ${actorEmployee?.name ?? `#${actor.id}`} on behalf of ${order.technician?.name ?? `#${order.technicianId}`}`;
      }
      if (target !== 'INSPECTING') {
        note += ` (resumed at ${target})`;
      }

      await tx.statusLog.create({
        data: { repairOrderId: id, status: target, changedById: actor.id, note },
      });

      return { trackingToken: order.trackingToken, jobNumber: order.jobNumber, status: target };
    });

    // Status-only SSE strictly post-commit
    OrderEvents.statusChanged({ id, trackingToken: result.trackingToken, status: result.status });

    return RepairService.getRepairOrderById(id, actor);
  }

  /**
   * POST /api/repairs/:id/release — ADMIN returns a reserved (not yet accepted) job to the pool.
   * The technician goes RESERVED -> AVAILABLE (availableSince = now), then the queue runs again.
   */
  static async releaseOrder(id: number, actor: Actor) {
    await prisma.$transaction(async (tx) => {
      const order = await tx.repairOrder.findUnique({
        where: { id },
        include: { technician: { select: { id: true, name: true } } },
      });
      if (!order) {
        throw new AppError(404, 'Repair order not found');
      }
      if (order.status !== 'NEW' || order.technicianId === null || order.acknowledgedAt !== null) {
        throw new AppError(409, `Only a reserved job that has not been accepted can be released (status ${order.status})`);
      }

      const released = await tx.repairOrder.updateMany({
        where: { id, status: 'NEW', technicianId: order.technicianId, acknowledgedAt: null },
        data: { technicianId: null, assignedAt: null, ackReminderCount: 0, lastAckReminderAt: null },
      });
      if (released.count === 0) {
        throw new AppError(409, 'Repair order was accepted or changed concurrently');
      }

      await tx.employee.updateMany({
        where: { id: order.technicianId, status: 'RESERVED' },
        data: { status: 'AVAILABLE', availableSince: new Date() },
      });

      const admin = await tx.employee.findUnique({ where: { id: actor.id }, select: { name: true } });
      await tx.statusLog.create({
        data: {
          repairOrderId: id,
          status: 'NEW',
          changedById: actor.id,
          note: `Released back to job pool by ${actor.role} ${admin?.name ?? `#${actor.id}`} (was reserved for ${order.technician?.name ?? `#${order.technicianId}`})`,
        },
      });
    });

    await AssignmentService.processQueue();
    return RepairService.getRepairOrderById(id, actor);
  }

  static async getRepairOrders(params: {
    role: string;
    userId: number;
    status?: RepairStatus;
    technicianId?: number;
    search?: string;
    awaitingAck?: boolean;
    needsProgressUpdate?: boolean;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 20));
    const skip = (page - 1) * limit;

    const conditions: Prisma.RepairOrderWhereInput[] = [];

    // Technician role visibility (SRS 4): only orders assigned to this technician
    // (including ones still waiting to be accepted). Unassigned NEW orders are NOT visible.
    if (params.role === 'TECHNICIAN') {
      conditions.push({ technicianId: params.userId });
    }

    if (params.status) {
      conditions.push({ status: params.status });
    }

    if (params.technicianId) {
      conditions.push({ technicianId: params.technicianId });
    }

    // Reserved for a technician but not yet accepted (SRS 6.2 awaitingAck)
    if (params.awaitingAck) {
      conditions.push({ status: 'NEW', technicianId: { not: null }, acknowledgedAt: null });
    }

    if (params.search && params.search.trim().length > 0) {
      const term = params.search.trim().slice(0, 100);
      conditions.push({
        OR: [
          { jobNumber: { contains: term } },
          { paperReceiptNo: { contains: term } },
          { paperBookNo: { contains: term } },
          { customer: { phone: { contains: term } } },
          { customer: { name: { contains: term } } },
        ],
      });
    }

    // "Jobs that need an update" (SRS 3.6): open work idle for >= PROGRESS_REMINDER_INTERVAL_MINUTES
    // counted in business hours only. Business-minute arithmetic is done in code, then applied as an id filter.
    let idleMinutes: Map<number, number> | null = null;
    if (params.needsProgressUpdate) {
      const threshold = getAppConfig().progressReminderIntervalMinutes;
      const now = new Date();
      const candidates = await prisma.repairOrder.findMany({
        where: { AND: [...conditions, { status: { in: ACCEPTED_WORK_STATUSES } }] },
        select: { id: true, lastActivityAt: true, updatedAt: true, technician: { select: { weeklyDayOff: true } } },
      });
      idleMinutes = new Map();
      // Shop holidays and the assigned technician's weekly day off do not count as idle time
      const since = candidates.reduce<Date>((min, c) => {
        const at = c.lastActivityAt ?? c.updatedAt;
        return at < min ? at : min;
      }, now);
      const holidays = await ShopCalendarService.holidayDatesSince(since);
      for (const c of candidates) {
        const minutes = businessMinutesBetween(
          c.lastActivityAt ?? c.updatedAt,
          now,
          undefined,
          ShopCalendarService.closedDaysFor(holidays, c.technician?.weeklyDayOff)
        );
        if (minutes >= threshold) idleMinutes.set(c.id, minutes);
      }
      conditions.push({ id: { in: [...idleMinutes.keys()] } });
    }

    const where: Prisma.RepairOrderWhereInput = conditions.length > 0 ? { AND: conditions } : {};

    const [total, orders] = await Promise.all([
      prisma.repairOrder.count({ where }),
      prisma.repairOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          jobNumber: true,
          status: true,
          workType: true,
          paperBookNo: true,
          paperReceiptNo: true,
          receivedDate: true,
          warrantyStatus: true,
          assignedAt: true,
          acknowledgedAt: true,
          queuePriority: true,
          lastActivityAt: true,
          createdAt: true,
          updatedAt: true,
          otherSymptom: true,
          technicianId: true,
          customer: {
            select: { id: true, name: true, phone: true },
          },
          machine: {
            select: { id: true, brand: true, model: true, serialNumber: true },
          },
          technician: {
            select: { id: true, name: true, role: true, status: true },
          },
          symptoms: {
            include: { symptom: true },
          },
        },
      }),
    ]);

    const now = Date.now();
    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      orders: orders.map((o) => ({
        ...o,
        // Wall-clock minutes a reserved job has been waiting for acceptance (null otherwise)
        waitingMinutes:
          o.status === 'NEW' && o.technicianId !== null && o.acknowledgedAt === null && o.assignedAt
            ? Math.max(0, Math.floor((now - o.assignedAt.getTime()) / 60000))
            : null,
        ...(idleMinutes ? { idleBusinessMinutes: idleMinutes.get(o.id) ?? null } : {}),
      })),
    };
  }

  static async getRepairOrderById(id: number, user: { id: number; role: string }) {
    const order = await prisma.repairOrder.findUnique({
      where: { id },
      include: {
        customer: {
          select: customerResponseSelect,
        },
        ...lineLinkCountInclude,
        machine: {
          select: { id: true, brand: true, model: true, serialNumber: true },
        },
        technician: {
          select: { id: true, name: true, role: true, status: true },
        },
        symptoms: {
          include: { symptom: { include: { category: true } } },
        },
        repairItems: {
          orderBy: { id: 'asc' },
        },
        paymentRecordedBy: { select: { id: true, name: true, role: true } },
        helpers: {
          select: {
            createdAt: true,
            technician: { select: { id: true, name: true } },
            addedBy: { select: { id: true, name: true, role: true } },
          },
          orderBy: { id: 'asc' },
        },
        statusLogs: {
          include: {
            changedBy: {
              select: { id: true, name: true, role: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!order) {
      throw new AppError(404, 'Repair order not found');
    }

    // Role visibility check for technician (SRS 4): only their own assigned orders
    if (user.role === 'TECHNICIAN' && order.technicianId !== user.id) {
      throw new AppError(403, 'Forbidden: You do not have permission to view this repair order');
    }

    // trackingToken redaction for TECHNICIAN is applied centrally in the controller (sanitizeForRole)
    const { paidAmount, ...rest } = order;
    return withPublicCustomer({
      ...rest,
      repairItems: order.repairItems.map(toRepairItemView),
      totalAmount: computeTotalAmount(order.repairItems),
      payment: {
        ...paymentSummary(paidAmount, computePayableAmount(order.repairItems)),
        method: order.paymentMethod,
        note: order.paymentNote,
        paidAt: order.paidAt,
        recordedBy: order.paymentRecordedBy,
      },
      // Buttons this caller may use on this order (the web app hides everything else)
      allowedActions: computeAllowedActions(user, {
        status: order.status,
        technicianId: order.technicianId,
        acknowledgedAt: order.acknowledgedAt,
        itemStatuses: order.repairItems.map((i) => i.status),
      }),
    });
  }

  /**
   * PUT /api/repairs/:id/payment — RECEPTIONIST/ADMIN record or correct the payment of a COMPLETED or
   * DELIVERED order (e.g. the customer pays later). Record only; the log keeps every change.
   */
  static async setPayment(id: number, actor: Actor, payment: PaymentInput) {
    await prisma.$transaction(async (tx) => {
      // Row lock: a rework / status change pressed at the same moment waits for this payment, or
      // this payment sees the new status and is refused
      const order = await lockOrderRow(tx, id);
      if (!order) {
        throw new AppError(404, 'Repair order not found');
      }
      if (order.status !== 'COMPLETED' && order.status !== 'DELIVERED') {
        throw new AppError(409, `Payment can only be recorded for a COMPLETED or DELIVERED order (current status ${order.status})`);
      }
      await writePayment(tx, id, payment, actor, new Date());
    });
    return RepairService.getRepairOrderById(id, actor);
  }
}
