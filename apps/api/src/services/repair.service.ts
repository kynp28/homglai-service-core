import crypto from 'crypto';
import prisma, { Prisma, RepairStatus } from '@homglai/db';
import { SseService } from './sse.service';
import { AppError } from '../utils/app-error';
import { resolveAcceptTarget, validateStatusTransition } from '../config/repair-status';
import { getBangkokYearMonth, getBangkokDateOnly, dateOnlyToDate } from '../utils/date';
import { ACCEPTED_WORK_STATUSES, AssignmentService } from './assignment.service';
import { LineWebhookService } from './line-webhook.service';
import { customerResponseSelect, withPublicCustomer } from '../utils/customer-view';
import { computeTotalAmount, toRepairItemView } from '../utils/repair-item-view';
import {
  AddRepairItemInput,
  CreateRepairOrderInput,
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

    const maxRetries = 10;
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

          // 3. Generate Job Number using Bangkok (UTC+7) timezone
          const yymm = getBangkokYearMonth(new Date());
          const prefix = `REP-${yymm}`;

          const latestOrder = await tx.repairOrder.findFirst({
            where: { jobNumber: { startsWith: prefix } },
            orderBy: { id: 'desc' },
            select: { jobNumber: true },
          });

          let nextSeq = 1;
          if (latestOrder) {
            const parts = latestOrder.jobNumber.split('-');
            const lastNum = parseInt(parts[parts.length - 1], 10);
            if (!isNaN(lastNum)) {
              nextSeq = lastNum + 1;
            }
          }
          if (attempt > 0) {
            nextSeq += Math.floor(Math.random() * 5);
          }
          const jobNumber = `${prefix}-${nextSeq.toString().padStart(4, '0')}`;

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
        if (err.code === 'P2002' && attempt < maxRetries - 1) {
          await new Promise((res) => setTimeout(res, 30 * (attempt + 1) + Math.random() * 50));
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

    const { order, item } = await prisma.$transaction(async (tx) => {
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

      // 1. Create the pending repair item using precise Decimal representation
      const createdItem = await tx.repairItem.create({
        data: {
          repairOrderId,
          name: data.name.trim(),
          quantity: data.quantity,
          unitPrice,
          barcode: data.barcode ?? null,
          itemType: data.itemType,
          status: 'PENDING',
        },
      });

      // 2. Set order status to WAITING_APPROVAL (adding an item counts as activity, SRS 3.6).
      //    Conditional: fails if the order changed status or technician concurrently.
      const guarded = await tx.repairOrder.updateMany({
        where: { id: repairOrderId, status: existingOrder.status, technicianId: existingOrder.technicianId },
        data: { status: 'WAITING_APPROVAL', lastActivityAt: new Date() },
      });
      if (guarded.count === 0) {
        throw new AppError(409, 'Repair order changed concurrently; item was not added');
      }
      const updatedOrder = await tx.repairOrder.findUniqueOrThrow({ where: { id: repairOrderId } });

      // 3. Log the status transition
      await tx.statusLog.create({
        data: {
          repairOrderId,
          status: 'WAITING_APPROVAL',
          changedById: data.technicianId,
          note: `Added quotation item (${data.itemType}): ${data.name.trim()} x${data.quantity} @ ${unitPrice.toFixed(2)} THB`,
        },
      });

      return { order: updatedOrder, item: createdItem };
    });

    const itemView = toRepairItemView(item);

    // Broadcast SSE strictly post-commit (exclude sensitive technician/customer IDs)
    SseService.broadcastUpdate(order.trackingToken, {
      trackingToken: order.trackingToken,
      jobNumber: order.jobNumber,
      status: 'WAITING_APPROVAL',
      newItem: {
        id: item.id,
        name: item.name,
        price: itemView.unitPrice,
        status: item.status,
      },
      updatedAt: order.updatedAt.toISOString(),
    });

    // Send push notification to LINE customer with approval actions
    LineWebhookService.notifyCustomerNewItem(repairOrderId, {
      id: item.id,
      name: item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name,
      price: itemView.amount,
    }).catch(() => {});

    return { order, item: itemView };
  }

  static async completeRepairItem(repairOrderId: number, itemId: number, userId: number) {
    const { order, item } = await prisma.$transaction(async (tx) => {
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
    SseService.broadcastUpdate(order.trackingToken, {
      trackingToken: order.trackingToken,
      jobNumber: order.jobNumber,
      status: order.status,
      completedItem: {
        id: item.id,
        name: item.name,
        price: item.unitPrice.toString(),
        status: item.status,
      },
      updatedAt: new Date().toISOString(),
    });

    return { order, item: toRepairItemView(item) };
  }

  static async resolveRepairItem(
    repairOrderId: number,
    itemId: number,
    status: 'APPROVED' | 'REJECTED'
  ) {
    const { item, order, pendingCount, targetStatus } = await prisma.$transaction(async (tx) => {
      const existingOrder = await tx.repairOrder.findUnique({
        where: { id: repairOrderId },
      });

      if (!existingOrder) {
        throw new AppError(404, 'Repair order not found');
      }

      if (existingOrder.status !== 'WAITING_APPROVAL') {
        throw new AppError(
          409,
          `Cannot resolve quotation items when order status is ${existingOrder.status}`
        );
      }

      // Atomically update only if item belongs to this order and is currently PENDING
      const updateRes = await tx.repairItem.updateMany({
        where: { id: itemId, repairOrderId, status: 'PENDING' },
        data: { status },
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

      // Check remaining pending items
      const remainingPending = await tx.repairItem.count({
        where: { repairOrderId, status: 'PENDING' },
      });

      let updatedOrder = existingOrder;
      let calculatedTargetStatus: RepairStatus | null = null;

      if (remainingPending === 0) {
        const approvedCount = await tx.repairItem.count({
          where: { repairOrderId, status: 'APPROVED' },
        });

        // If at least one item was approved, resume repair; if all rejected, return to INSPECTING
        calculatedTargetStatus = approvedCount > 0 ? 'REPAIRING' : 'INSPECTING';

        const guarded = await tx.repairOrder.updateMany({
          where: { id: repairOrderId, status: 'WAITING_APPROVAL' },
          data: { status: calculatedTargetStatus },
        });
        if (guarded.count === 0) {
          throw new AppError(409, 'Repair order changed concurrently; please retry');
        }
        updatedOrder = await tx.repairOrder.findUniqueOrThrow({ where: { id: repairOrderId } });

        await tx.statusLog.create({
          data: {
            repairOrderId,
            status: calculatedTargetStatus,
            changedById: null, // Customer resolution has no employee ID
            note: `All quotation items resolved (${approvedCount} approved). Auto-transitioned to ${calculatedTargetStatus}.`,
          },
        });
      }

      return {
        item: updatedItem,
        order: updatedOrder,
        pendingCount: remainingPending,
        targetStatus: calculatedTargetStatus,
      };
    });

    // Broadcast SSE strictly post-commit
    SseService.broadcastUpdate(order.trackingToken, {
      trackingToken: order.trackingToken,
      jobNumber: order.jobNumber,
      status: order.status,
      resolvedItem: {
        id: item.id,
        name: item.name,
        price: item.unitPrice.toString(),
        status: item.status,
      },
      pendingItemsRemaining: pendingCount,
      updatedAt: order.updatedAt.toISOString(),
    });

    return { item: toRepairItemView(item), order };
  }

  static async updateStatus(id: number, status: RepairStatus, actor: Actor, note?: string) {
    const userId = actor.id;
    const { updatedOrder, freedTechnicianId } = await prisma.$transaction(async (tx) => {
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

      // D.4: Cannot complete repair order while there are approved items not yet marked COMPLETED
      if (status === 'COMPLETED') {
        const approvedItemCount = await tx.repairItem.count({
          where: { repairOrderId: id, status: 'APPROVED' },
        });
        if (approvedItemCount > 0) {
          throw new AppError(
            409,
            `Cannot complete repair order: ${approvedItemCount} approved item(s) must be marked as COMPLETED first`
          );
        }
      }

      // D.3: COMPLETED -> REPAIRING (rework assignment)
      let currentTechId = order.technicianId;
      if (order.status === 'COMPLETED' && status === 'REPAIRING') {
        let techAcquired = false;

        // Try original technician first if available and active
        if (currentTechId) {
          const origTechUpdate = await tx.employee.updateMany({
            where: { id: currentTechId, role: 'TECHNICIAN', status: 'AVAILABLE', isActive: true },
            data: { status: 'BUSY' },
          });
          if (origTechUpdate.count > 0) {
            techAcquired = true;
          }
        }

        // If original tech unavailable, assign another available technician
        if (!techAcquired) {
          const nextTech = await tx.employee.findFirst({
            where: { role: 'TECHNICIAN', status: 'AVAILABLE', isActive: true },
            orderBy: [{ availableSince: 'asc' }, { id: 'asc' }],
          });

          if (!nextTech) {
            throw new AppError(
              409,
              'Cannot reopen repair: No technician is currently AVAILABLE to take rework'
            );
          }

          const nextTechUpdate = await tx.employee.updateMany({
            where: { id: nextTech.id, role: 'TECHNICIAN', status: 'AVAILABLE', isActive: true },
            data: { status: 'BUSY' },
          });

          if (nextTechUpdate.count === 0) {
            throw new AppError(
              409,
              'Contention allocating technician for rework, please retry'
            );
          }

          currentTechId = nextTech.id;
        }
      }

      // 1. Update repair order status (conditional: fails if changed concurrently)
      const now = new Date();
      const guarded = await tx.repairOrder.updateMany({
        where: { id, status: order.status, technicianId: order.technicianId },
        data: {
          status,
          technicianId: currentTechId,
          ...(status === 'DELIVERED' || status === 'CANCELLED' ? { closedAt: now } : {}),
          ...(order.status === 'COMPLETED' && status === 'REPAIRING' ? { lastActivityAt: now } : {}),
        },
      });
      if (guarded.count === 0) {
        throw new AppError(409, 'Repair order changed concurrently; status was not updated');
      }
      const updated = await tx.repairOrder.findUniqueOrThrow({
        where: { id },
        include: { customer: { select: customerResponseSelect }, machine: true },
      });

      // 2. Create status log
      await tx.statusLog.create({
        data: {
          repairOrderId: id,
          status,
          changedById: userId,
          note: note || `Status updated to ${status}`,
        },
      });

      let technicianFreed: number | null = null;

      // 3. Free the technician when the order reaches COMPLETED / DELIVERED / CANCELLED and they hold
      //    nothing else. Covers cancelling a reserved (not yet accepted) order: RESERVED -> AVAILABLE.
      //    Only BUSY/RESERVED active technicians are freed (never flips OFFLINE or deactivated staff).
      if (['COMPLETED', 'DELIVERED', 'CANCELLED'].includes(status) && order.technicianId) {
        const remainingHeldOrders = await tx.repairOrder.count({
          where: {
            technicianId: order.technicianId,
            id: { not: order.id },
            status: { in: ['NEW', ...ACCEPTED_WORK_STATUSES] },
          },
        });

        if (remainingHeldOrders === 0) {
          const freed = await tx.employee.updateMany({
            where: { id: order.technicianId, status: { in: ['BUSY', 'RESERVED'] }, isActive: true },
            data: { status: 'AVAILABLE', availableSince: now },
          });
          if (freed.count > 0) {
            technicianFreed = order.technicianId;
          }
        }
      }

      return { updatedOrder: updated, freedTechnicianId: technicianFreed };
    });

    // Broadcast SSE strictly post-commit
    SseService.broadcastUpdate(updatedOrder.trackingToken, {
      trackingToken: updatedOrder.trackingToken,
      jobNumber: updatedOrder.jobNumber,
      status: updatedOrder.status,
      updatedAt: updatedOrder.updatedAt.toISOString(),
    });

    // Send push notification to customer on COMPLETED or DELIVERED
    if (status === 'COMPLETED' || status === 'DELIVERED') {
      LineWebhookService.notifyCustomerStatusChange(updatedOrder.id, status).catch(() => {});
    }

    // If technician was freed, attempt to match next pending job
    if (freedTechnicianId) {
      await AssignmentService.processQueue();
    }

    return withPublicCustomer(updatedOrder);
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
          lastActivityAt: now,
          ackReminderCount: 0,
          lastAckReminderAt: null,
          progressReminderCount: 0,
          lastProgressReminderAt: null,
          queuePriority: 0,
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
    SseService.broadcastUpdate(result.trackingToken, {
      trackingToken: result.trackingToken,
      jobNumber: result.jobNumber,
      status: result.status,
      updatedAt: new Date().toISOString(),
    });

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
    return withPublicCustomer({
      ...order,
      repairItems: order.repairItems.map(toRepairItemView),
      totalAmount: computeTotalAmount(order.repairItems),
    });
  }
}
