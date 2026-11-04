import crypto from 'crypto';
import prisma, { Prisma, RepairStatus } from '@homglai/db';
import { SseService } from './sse.service';
import { AppError } from '../utils/app-error';
import { validateStatusTransition } from '../config/repair-status';
import { getBangkokYearMonth } from '../utils/date';
import { AssignmentService } from './assignment.service';
import { LineWebhookService } from './line-webhook.service';

export class RepairService {
  static async createRepairOrder(data: {
    customer: { name: string; phone: string };
    machine: { brand: string; model: string; serialNumber?: string | null };
    symptomIds: number[];
    otherSymptom?: string | null;
    receptionistId: number;
  }) {
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

    const maxRetries = 10;
    let createdOrder: any = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        createdOrder = await prisma.$transaction(async (tx) => {
          // 1. Upsert Customer
          const customer = await tx.customer.upsert({
            where: { phone: data.customer.phone },
            update: { name: data.customer.name },
            create: { name: data.customer.name, phone: data.customer.phone },
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

          // 4. Create Repair Order with Symptoms and initial StatusLog
          const repairOrder = await tx.repairOrder.create({
            data: {
              jobNumber,
              trackingToken,
              customerId: customer.id,
              machineId,
              otherSymptom: data.otherSymptom || null,
              status: 'NEW',
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
              customer: true,
              machine: true,
              symptoms: { include: { symptom: true } },
            },
          });

          return repairOrder;
        });

        break;
      } catch (err: any) {
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
        customer: true,
        machine: true,
        symptoms: { include: { symptom: true } },
        technician: {
          select: { id: true, name: true, status: true },
        },
      },
    });

    return finalOrder || createdOrder;
  }

  static async addRepairItem(
    repairOrderId: number,
    data: { name: string; price: number; technicianId: number }
  ) {
    const { order, item } = await prisma.$transaction(async (tx) => {
      const existingOrder = await tx.repairOrder.findUnique({
        where: { id: repairOrderId },
      });

      if (!existingOrder) {
        throw new AppError(404, 'Repair order not found');
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
          price: new Prisma.Decimal(data.price.toFixed(2)),
          status: 'PENDING',
        },
      });

      // 2. Set order status to WAITING_APPROVAL
      const updatedOrder = await tx.repairOrder.update({
        where: { id: repairOrderId },
        data: { status: 'WAITING_APPROVAL' },
      });

      // 3. Log the status transition
      await tx.statusLog.create({
        data: {
          repairOrderId,
          status: 'WAITING_APPROVAL',
          changedById: data.technicianId,
          note: `Added quotation item: ${data.name.trim()} (${data.price.toFixed(2)} THB)`,
        },
      });

      return { order: updatedOrder, item: createdItem };
    });

    // Broadcast SSE strictly post-commit (exclude sensitive technician/customer IDs)
    SseService.broadcastUpdate(order.trackingToken, {
      trackingToken: order.trackingToken,
      jobNumber: order.jobNumber,
      status: 'WAITING_APPROVAL',
      newItem: {
        id: item.id,
        name: item.name,
        price: item.price.toString(),
        status: item.status,
      },
      updatedAt: order.updatedAt.toISOString(),
    });

    // Send push notification to LINE customer with approval actions
    LineWebhookService.notifyCustomerNewItem(repairOrderId, {
      id: item.id,
      name: item.name,
      price: item.price.toString(),
    }).catch(() => {});

    return { order, item };
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
        price: item.price.toString(),
        status: item.status,
      },
      updatedAt: new Date().toISOString(),
    });

    return { order, item };
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

        updatedOrder = await tx.repairOrder.update({
          where: { id: repairOrderId },
          data: { status: calculatedTargetStatus },
        });

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
        price: item.price.toString(),
        status: item.status,
      },
      pendingItemsRemaining: pendingCount,
      updatedAt: order.updatedAt.toISOString(),
    });

    return { item, order };
  }

  static async updateStatus(id: number, status: RepairStatus, userId: number, note?: string) {
    const { updatedOrder, freedTechnicianId } = await prisma.$transaction(async (tx) => {
      const order = await tx.repairOrder.findUnique({
        where: { id },
      });

      if (!order) {
        throw new AppError(404, 'Repair order not found');
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
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
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

      // 1. Update repair order status
      const updated = await tx.repairOrder.update({
        where: { id },
        data: {
          status,
          technicianId: currentTechId,
        },
        include: { customer: true, machine: true },
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

      // 3. Free technician if order reached terminal or completed state
      if (['COMPLETED', 'DELIVERED', 'CANCELLED'].includes(status) && order.technicianId) {
        const remainingActiveOrders = await tx.repairOrder.count({
          where: {
            technicianId: order.technicianId,
            id: { not: order.id },
            status: { in: ['INSPECTING', 'WAITING_APPROVAL', 'REPAIRING'] },
          },
        });

        if (remainingActiveOrders === 0) {
          await tx.employee.update({
            where: { id: order.technicianId },
            data: { status: 'AVAILABLE' },
          });
          technicianFreed = order.technicianId;
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

    return updatedOrder;
  }

  static async getRepairOrders(params: {
    role: string;
    userId: number;
    status?: RepairStatus;
    technicianId?: number;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 20));
    const skip = (page - 1) * limit;

    const conditions: Prisma.RepairOrderWhereInput[] = [];

    // Technician role visibility constraint
    if (params.role === 'TECHNICIAN') {
      conditions.push({
        OR: [
          { technicianId: params.userId },
          { status: 'NEW', technicianId: null },
        ],
      });
    }

    if (params.status) {
      conditions.push({ status: params.status });
    }

    if (params.technicianId) {
      conditions.push({ technicianId: params.technicianId });
    }

    if (params.search && params.search.trim().length > 0) {
      const term = params.search.trim();
      conditions.push({
        OR: [
          { jobNumber: { contains: term } },
          { customer: { phone: { contains: term } } },
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

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      orders,
    };
  }

  static async getRepairOrderById(id: number, user: { id: number; role: string }) {
    const order = await prisma.repairOrder.findUnique({
      where: { id },
      include: {
        customer: {
          select: { id: true, name: true, phone: true, lineUserId: true, createdAt: true },
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

    // Role visibility check for technician
    if (user.role === 'TECHNICIAN') {
      const isAssigned = order.technicianId === user.id;
      const isUnassignedNew = order.status === 'NEW' && order.technicianId === null;
      if (!isAssigned && !isUnassignedNew) {
        throw new AppError(403, 'Forbidden: You do not have permission to view this repair order');
      }
    }

    // Never leak trackingToken to technician; only expose to Receptionist/Admin
    const { trackingToken, ...sanitizedOrder } = order;
    return {
      ...sanitizedOrder,
      ...(user.role !== 'TECHNICIAN' ? { trackingToken } : {}),
    };
  }
}
