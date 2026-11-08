import prisma, { EmployeeRole, Prisma } from '@homglai/db';
import bcrypt from 'bcryptjs';
import { AppError } from '../utils/app-error';
import { AssignmentService, heldOrdersWhere, RequeuedOrder } from './assignment.service';
import { customerResponseSelect, lineLinkCountInclude, withPublicCustomer } from '../utils/customer-view';

export class EmployeeService {
  static async createEmployee(data: {
    username: string;
    name: string;
    password: string;
    role: EmployeeRole;
  }) {
    const existing = await prisma.employee.findUnique({
      where: { username: data.username },
    });
    if (existing) {
      throw new AppError(409, `Username "${data.username}" is already taken`);
    }

    const passwordHash = await bcrypt.hash(data.password, 10);

    const employee = await prisma.employee.create({
      data: {
        username: data.username,
        name: data.name,
        role: data.role,
        status: 'AVAILABLE',
        availableSince: new Date(),
        isActive: true,
        passwordHash,
      },
      select: {
        id: true,
        username: true,
        name: true,
        role: true,
        status: true,
        isActive: true,
        weeklyDayOff: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return employee;
  }

  static async getEmployees() {
    const employees = await prisma.employee.findMany({
      select: {
        id: true,
        username: true,
        name: true,
        role: true,
        status: true,
        isActive: true,
        weeklyDayOff: true,
        createdAt: true,
        updatedAt: true,
        lineUserId: true,
      },
      orderBy: { id: 'asc' },
    });
    // lineUserId itself is never returned; ADMIN only sees whether LINE is linked
    return employees.map(({ lineUserId, ...e }) => ({ ...e, lineLinked: lineUserId !== null }));
  }

  /**
   * PATCH /api/employees/:id (ADMIN). Deactivating a technician, or moving them out of the TECHNICIAN
   * role, returns every job they hold to the pool in the SAME transaction
   * (AssignmentService.requeueOrdersOfTechnician); after commit the ADMINs get one summary and the
   * queue runs again. Customers get no LINE push for this internal event.
   */
  static async updateEmployee(
    id: number,
    data: { name?: string; role?: EmployeeRole; isActive?: boolean; weeklyDayOff?: number | null },
    actorId: number
  ) {
    const employee = await prisma.employee.findUnique({
      where: { id },
    });
    if (!employee) {
      throw new AppError(404, 'Employee not found');
    }

    const deactivating = data.isActive === false;
    const leavingTechnicianRole = data.role !== undefined && data.role !== 'TECHNICIAN';
    const releasesJobs = employee.role === 'TECHNICIAN' && (deactivating || leavingTechnicianRole);
    const reason = deactivating ? 'DEACTIVATED' : 'ROLE_CHANGED';

    const updateData: Prisma.EmployeeUpdateInput = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.role !== undefined) updateData.role = data.role;
    if (data.weeklyDayOff !== undefined) updateData.weeklyDayOff = data.weeklyDayOff;
    if (data.isActive !== undefined) {
      updateData.isActive = data.isActive;
    }
    if (deactivating || (employee.role === 'TECHNICIAN' && leavingTechnicianRole)) {
      // Deactivated / no longer a technician: out of the queue until they set themselves AVAILABLE again
      updateData.status = 'OFFLINE';
    } else if (
      data.role === 'TECHNICIAN' &&
      employee.role !== 'TECHNICIAN' &&
      employee.status === 'AVAILABLE'
    ) {
      // Joins the technician queue now (not ahead of technicians who were already waiting)
      updateData.availableSince = new Date();
    }

    const { updated, requeued } = await prisma.$transaction(async (tx) => {
      const updatedEmployee = await tx.employee.update({
        where: { id },
        data: updateData,
        select: {
          id: true,
          username: true,
          name: true,
          role: true,
          status: true,
          isActive: true,
          weeklyDayOff: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const returned: RequeuedOrder[] = releasesJobs
        ? await AssignmentService.requeueOrdersOfTechnician(tx, id, actorId, reason)
        : [];

      return { updated: updatedEmployee, requeued: returned };
    });

    if (releasesJobs) {
      await AssignmentService.afterRequeue(requeued, employee.name, reason);
    }

    return updated;
  }

  static async resetPassword(id: number, newPassword: string) {
    const employee = await prisma.employee.findUnique({
      where: { id },
    });
    if (!employee) {
      throw new AppError(404, 'Employee not found');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.employee.update({
      where: { id },
      data: { passwordHash },
    });

    return { message: 'Password reset successfully' };
  }

  static async changePassword(employeeId: number, oldPassword: string, newPassword: string) {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new AppError(404, 'Employee not found');
    }

    const isValid = await bcrypt.compare(oldPassword, employee.passwordHash);
    if (!isValid) {
      throw new AppError(401, 'Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.employee.update({
      where: { id: employeeId },
      data: { passwordHash },
    });

    return { message: 'Password changed successfully' };
  }

  static async updateStatusAndAssignWork(employeeId: number, status: 'AVAILABLE' | 'BUSY' | 'OFFLINE') {
    const reservedMessage =
      'Cannot change status while a job is reserved for you. Accept the job first, or ask an ADMIN to release it.';
    // 1. Verify employee exists and is active
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new AppError(404, 'Employee not found');
    }
    if (!employee.isActive) {
      throw new AppError(403, 'Deactivated employees cannot change status');
    }

    // SRS 3.3 (5): a RESERVED technician cannot change their own status
    if (employee.status === 'RESERVED') {
      throw new AppError(409, reservedMessage);
    }

    // 2. Prevent transitioning to OFFLINE or AVAILABLE if holding active orders
    if (status === 'OFFLINE' || status === 'AVAILABLE') {
      const activeOrdersCount = await prisma.repairOrder.count({
        where: {
          technicianId: employeeId,
          status: { in: ['INSPECTING', 'WAITING_APPROVAL', 'REPAIRING'] },
        },
      });

      if (activeOrdersCount > 0) {
        throw new AppError(
          409,
          `Cannot change status to ${status} while having ${activeOrdersCount} active repair order(s) in progress`
        );
      }
    }

    // 3. Update status (conditional: a job may have been reserved for them in the meantime).
    //    availableSince is set only when the employee becomes AVAILABLE, so repeating AVAILABLE
    //    does not move a waiting technician to the back of the queue.
    const changed = await prisma.employee.updateMany({
      where: { id: employeeId, status: { not: 'RESERVED' } },
      data: {
        status,
        ...(status === 'AVAILABLE' && employee.status !== 'AVAILABLE' ? { availableSince: new Date() } : {}),
      },
    });
    if (changed.count === 0) {
      throw new AppError(409, reservedMessage);
    }
    const updatedEmployee = await prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: {
        id: true,
        name: true,
        username: true,
        role: true,
        status: true,
        isActive: true,
        weeklyDayOff: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // 4. If technician transitioned to AVAILABLE, trigger assignment queue
    if (status === 'AVAILABLE' && employee.role === 'TECHNICIAN' && employee.isActive) {
      await AssignmentService.processQueue();
    }

    // 5. The job this technician currently holds (a reserved job awaiting acceptance included)
    const assignedOrder = await prisma.repairOrder.findFirst({
      where: heldOrdersWhere(employeeId),
      include: { customer: { select: customerResponseSelect },
        ...lineLinkCountInclude, machine: true },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    });

    const currentEmployee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        name: true,
        username: true,
        role: true,
        status: true,
        isActive: true,
        weeklyDayOff: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      employee: currentEmployee || updatedEmployee,
      assignedOrder: assignedOrder ? withPublicCustomer(assignedOrder) : null,
    };
  }
}
