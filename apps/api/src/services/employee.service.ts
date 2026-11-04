import prisma from '@homglai/db';
import { SseService } from './sse.service';

export class EmployeeService {
  static async updateStatusAndAssignWork(employeeId: number, status: 'AVAILABLE' | 'BUSY' | 'OFFLINE') {
    return prisma.$transaction(async (tx) => {
      // 1. Update employee status
      const employee = await tx.employee.update({
        where: { id: employeeId },
        data: { status }
      });

      let assignedOrder = null;

      // 2. Auto-assign logic if technician becomes AVAILABLE
      if (status === 'AVAILABLE' && employee.role === 'TECHNICIAN') {
        const pendingOrder = await tx.repairOrder.findFirst({
          where: { status: 'NEW', technicianId: null },
          orderBy: { createdAt: 'asc' }
        });

        if (pendingOrder) {
          // Assign the order and mark technician as BUSY
          assignedOrder = await tx.repairOrder.update({
            where: { id: pendingOrder.id },
            data: { 
              technicianId: employee.id,
              status: 'INSPECTING' 
            },
            include: { customer: true, machine: true }
          });

          await tx.employee.update({
            where: { id: employee.id },
            data: { status: 'BUSY' }
          });

          // Log the status change
          await tx.statusLog.create({
            data: {
              repairOrderId: pendingOrder.id,
              status: 'INSPECTING',
              changedById: employee.id,
              note: 'Auto-assigned from queue'
            }
          });

          // Broadcast SSE for the specific job
          SseService.broadcastUpdate(pendingOrder.jobNumber, {
            jobNumber: pendingOrder.jobNumber,
            status: 'INSPECTING',
            technicianId: employee.id,
            updatedAt: assignedOrder.updatedAt
          });
        }
      }

      return { employee, assignedOrder };
    });
  }
}
