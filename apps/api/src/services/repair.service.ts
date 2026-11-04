import { PrismaClient } from '@homglai/db';
import { SseService } from './sse.service';

const prisma = new PrismaClient();

export class RepairService {
  static async createRepairOrder(data: {
    customer: { name: string; phone: string };
    machine: { brand: string; model: string; serialNumber?: string };
    symptomIds: number[];
    otherSymptom?: string;
    receptionistId: number;
  }) {
    const maxRetries = 10;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await prisma.$transaction(async (tx) => {
          // 1. Find or create customer
          const customer = await tx.customer.upsert({
            where: { phone: data.customer.phone },
            update: { name: data.customer.name },
            create: { name: data.customer.name, phone: data.customer.phone }
          });

          // 2. Create machine record
          const machine = await tx.machine.create({
            data: {
              brand: data.machine.brand,
              model: data.machine.model,
              serialNumber: data.machine.serialNumber,
              customerId: customer.id
            }
          });

          // 3. Generate Job Number (e.g., REP-2611-0001)
          const date = new Date();
          const prefix = `REP-${date.getFullYear().toString().slice(2)}${(date.getMonth() + 1).toString().padStart(2, '0')}`;
          
          const latestOrder = await tx.repairOrder.findFirst({
            where: { jobNumber: { startsWith: prefix } },
            orderBy: { id: 'desc' },
            select: { jobNumber: true }
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

          // 4. Create Repair Order with Symptoms and initial StatusLog
          const repairOrder = await tx.repairOrder.create({
            data: {
              jobNumber,
              customerId: customer.id,
              machineId: machine.id,
              otherSymptom: data.otherSymptom,
              status: 'NEW',
              symptoms: {
                create: data.symptomIds.map(id => ({ symptomId: id }))
              },
              statusLogs: {
                create: {
                  status: 'NEW',
                  changedById: data.receptionistId,
                  note: 'Opened new repair order'
                }
              }
            },
            include: {
              customer: true,
              machine: true,
              symptoms: { include: { symptom: true } }
            }
          });

          return repairOrder;
        });
      } catch (err: any) {
        if (err.code === 'P2002' && attempt < maxRetries - 1) {
          await new Promise((res) => setTimeout(res, 30 * (attempt + 1) + Math.random() * 50));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Failed to generate unique job number after retries');
  }

  static async addRepairItem(repairOrderId: number, data: { name: string; price: number; technicianId: number }) {
    return prisma.$transaction(async (tx) => {
      // 1. Create the pending repair item
      const item = await tx.repairItem.create({
        data: {
          repairOrderId,
          name: data.name,
          price: data.price,
          status: 'PENDING'
        }
      });

      // 2. Update order status to WAITING_APPROVAL
      const order = await tx.repairOrder.update({
        where: { id: repairOrderId },
        data: { status: 'WAITING_APPROVAL' },
        include: { customer: true }
      });

      // 3. Log the status change
      await tx.statusLog.create({
        data: {
          repairOrderId,
          status: 'WAITING_APPROVAL',
          changedById: data.technicianId,
          note: `Added pending item: ${data.name} (${data.price} THB)`
        }
      });

      // 4. Broadcast SSE
      SseService.broadcastUpdate(order.jobNumber, {
        jobNumber: order.jobNumber,
        status: 'WAITING_APPROVAL',
        newItem: item,
        updatedAt: order.updatedAt
      });

      return { order, item };
    });
  }

  static async resolveRepairItem(repairOrderId: number, itemId: number, status: 'APPROVED' | 'REJECTED') {
    return prisma.$transaction(async (tx) => {
      // 1. Update the specific item status
      const item = await tx.repairItem.update({
        where: { id: itemId },
        data: { status }
      });

      // 2. Check if there are any remaining PENDING items for this order
      const pendingCount = await tx.repairItem.count({
        where: { repairOrderId, status: 'PENDING' }
      });

      let order = await tx.repairOrder.findUniqueOrThrow({ 
        where: { id: repairOrderId } 
      });

      // 3. If no pending items remain, auto-resume the repair process
      if (pendingCount === 0 && order.status === 'WAITING_APPROVAL') {
        order = await tx.repairOrder.update({
          where: { id: repairOrderId },
          data: { status: 'REPAIRING' }
        });

        // Log the auto-resume status change (Fallback to ID 1 if technicianId is null)
        await tx.statusLog.create({
          data: {
            repairOrderId,
            status: 'REPAIRING',
            changedById: order.technicianId || 1, 
            note: `Customer ${status.toLowerCase()} item: ${item.name}. Auto-resuming repair.`
          }
        });
      }

      // 4. Broadcast SSE to notify the technician
      SseService.broadcastUpdate(order.jobNumber, {
        jobNumber: order.jobNumber,
        status: order.status,
        resolvedItem: item,
        updatedAt: new Date()
      });

      return { item, order };
    });
  }

  static async updateStatus(id: number, status: any, userId: number, note?: string) {
    return prisma.$transaction(async (tx) => {
      // 1. Update repair order status
      const updatedOrder = await tx.repairOrder.update({
        where: { id },
        data: { status },
        include: { customer: true, machine: true }
      });

      // 2. Create status log
      await tx.statusLog.create({
        data: {
          repairOrderId: id,
          status,
          changedById: userId,
          note: note || `Status updated to ${status}`
        }
      });

      // 3. Broadcast real-time update via SSE
      SseService.broadcastUpdate(updatedOrder.jobNumber, {
        jobNumber: updatedOrder.jobNumber,
        status: updatedOrder.status,
        updatedAt: updatedOrder.updatedAt
      });

      return updatedOrder;
    });
  }
}
