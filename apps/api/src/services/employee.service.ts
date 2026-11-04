import prisma, { EmployeeRole } from '@homglai/db';
import bcrypt from 'bcryptjs';
import { AppError } from '../utils/app-error';
import { AssignmentService } from './assignment.service';

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
        createdAt: true,
        updatedAt: true,
      },
    });

    return employee;
  }

  static async getEmployees() {
    return prisma.employee.findMany({
      select: {
        id: true,
        username: true,
        name: true,
        role: true,
        status: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { id: 'asc' },
    });
  }

  static async updateEmployee(
    id: number,
    data: { name?: string; role?: EmployeeRole; isActive?: boolean }
  ) {
    const employee = await prisma.employee.findUnique({
      where: { id },
    });
    if (!employee) {
      throw new AppError(404, 'Employee not found');
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.role !== undefined) updateData.role = data.role;
    if (data.isActive !== undefined) {
      updateData.isActive = data.isActive;
      // If soft-deleted / deactivated, set status to OFFLINE
      if (data.isActive === false) {
        updateData.status = 'OFFLINE';
      }
    }

    const updated = await prisma.employee.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        username: true,
        name: true,
        role: true,
        status: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

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

    // 3. Update status
    const updatedEmployee = await prisma.employee.update({
      where: { id: employeeId },
      data: { status },
      select: {
        id: true,
        name: true,
        username: true,
        role: true,
        status: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // 4. If technician transitioned to AVAILABLE, trigger assignment queue
    if (status === 'AVAILABLE' && employee.role === 'TECHNICIAN' && employee.isActive) {
      await AssignmentService.processQueue();
    }

    // 5. Check if an order was assigned
    const assignedOrder = await prisma.repairOrder.findFirst({
      where: {
        technicianId: employeeId,
        status: 'INSPECTING',
      },
      include: { customer: true, machine: true },
      orderBy: { updatedAt: 'desc' },
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
        createdAt: true,
        updatedAt: true,
      },
    });

    return { employee: currentEmployee || updatedEmployee, assignedOrder };
  }
}
