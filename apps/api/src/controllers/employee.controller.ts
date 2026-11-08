import { NextFunction, Request, Response } from 'express';
import { EmployeeService } from '../services/employee.service';
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  resetEmployeePasswordSchema,
  updateEmployeeStatusSchema,
} from '../validators/employee.validator';
import { AppError } from '../utils/app-error';
import { sanitizeForRole } from '../utils/response-sanitizer';
import { LineStaffService } from '../services/line-staff.service';
import prisma from '@homglai/db';

export class EmployeeController {
  /** GET /api/employees/me — the signed-in employee (current status, whether LINE is linked). */
  static async me(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const employee = await prisma.employee.findUnique({
        where: { id: req.user!.employeeId },
        select: { id: true, username: true, name: true, role: true, status: true, weeklyDayOff: true, lineUserId: true },
      });
      if (!employee) throw new AppError(404, 'Employee not found');
      const { lineUserId, ...rest } = employee;
      res.status(200).json({ status: 'success', data: { ...rest, lineLinked: lineUserId !== null } });
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/employees/me/line — link LINE via a technicians'-LIFF access token. */
  static async linkLine(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await LineStaffService.linkEmployee(req.user!.employeeId, req.body?.lineAccessToken);
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /api/employees/me/line — unlink. */
  static async unlinkLine(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({ status: 'success', data: await LineStaffService.unlinkEmployee(req.user!.employeeId) });
    } catch (error) {
      next(error);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = createEmployeeSchema.parse(req.body);
      const employee = await EmployeeService.createEmployee(data);
      res.status(201).json({ status: 'success', data: employee });
    } catch (error) {
      next(error);
    }
  }

  static async list(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const employees = await EmployeeService.getEmployees();
      res.status(200).json({ status: 'success', data: employees });
    } catch (error) {
      next(error);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        throw new AppError(400, 'Invalid employee ID');
      }

      const data = updateEmployeeSchema.parse(req.body);
      const employee = await EmployeeService.updateEmployee(id, data, req.user!.employeeId);
      res.status(200).json({ status: 'success', data: employee });
    } catch (error) {
      next(error);
    }
  }

  static async resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        throw new AppError(400, 'Invalid employee ID');
      }

      const { newPassword } = resetEmployeePasswordSchema.parse(req.body);
      const result = await EmployeeService.resetPassword(id, newPassword);
      res.status(200).json({ status: 'success', ...result });
    } catch (error) {
      next(error);
    }
  }

  static async updateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        throw new AppError(400, 'Invalid employee ID');
      }

      const { status } = updateEmployeeStatusSchema.parse(req.body);

      if (req.user!.role !== 'ADMIN' && req.user!.employeeId !== id) {
        throw new AppError(403, 'Forbidden: You can only update your own status');
      }

      const result = await EmployeeService.updateStatusAndAssignWork(id, status);
      res.status(200).json({ status: 'success', data: sanitizeForRole(result, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }
}
