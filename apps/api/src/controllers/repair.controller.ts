import { NextFunction, Request, Response } from 'express';
import prisma from '@homglai/db';
import { RepairService } from '../services/repair.service';
import {
  createRepairOrderSchema,
  updateRepairOrderSchema,
  addRepairItemSchema,
  resolveRepairItemSchema,
  completeRepairSchema,
  paymentSchema,
  setHelpersSchema,
  updateRepairStatusSchema,
  getRepairsQuerySchema,
} from '../validators/repair.validator';
import { AppError } from '../utils/app-error';
import { sanitizeForRole } from '../utils/response-sanitizer';

export class RepairController {
  static async createRepair(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const receptionistId = req.user!.employeeId;
      const validatedData = createRepairOrderSchema.parse(req.body);

      const repairOrder = await RepairService.createRepairOrder({
        ...validatedData,
        receptionistId,
      });

      res.status(201).json({ status: 'success', data: sanitizeForRole(repairOrder, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }

  static create = RepairController.createRepair;

  /** PATCH /api/repairs/:id — edit intake data (RECEPTIONIST/ADMIN, enforced by route). */
  static async updateRepair(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        throw new AppError(400, 'Invalid repair order ID');
      }

      const validatedData = updateRepairOrderSchema.parse(req.body);
      const order = await RepairService.updateRepairOrderIntake(id, validatedData, {
        id: req.user!.employeeId,
        role: req.user!.role,
      });

      res.status(200).json({ status: 'success', data: sanitizeForRole(order, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }

  static async addItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const repairOrderId = parseInt(req.params.id as string, 10);
      if (isNaN(repairOrderId)) {
        throw new AppError(400, 'Invalid repair order ID');
      }

      if (req.user!.role === 'RECEPTIONIST') {
        throw new AppError(403, 'Forbidden: Receptionists cannot add quotation items');
      }

      const validatedData = addRepairItemSchema.parse(req.body);
      const technicianId = req.user!.employeeId;

      const order = await prisma.repairOrder.findUnique({
        where: { id: repairOrderId },
      });

      if (!order) {
        throw new AppError(404, 'Repair order not found');
      }

      if (req.user!.role === 'TECHNICIAN' && order.technicianId !== technicianId) {
        throw new AppError(403, 'Forbidden: Only the assigned technician or an admin can add items');
      }

      const result = await RepairService.addRepairItem(repairOrderId, {
        ...validatedData,
        technicianId,
        actorRole: req.user!.role,
      });

      res.status(201).json({ status: 'success', data: sanitizeForRole(result, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }

  static async completeItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const repairOrderId = parseInt(req.params.id as string, 10);
      const itemId = parseInt(req.params.itemId as string, 10);
      if (isNaN(repairOrderId) || isNaN(itemId)) {
        throw new AppError(400, 'Invalid repair order or item ID');
      }

      const order = await prisma.repairOrder.findUnique({
        where: { id: repairOrderId },
      });

      if (!order) {
        throw new AppError(404, 'Repair order not found');
      }

      const userId = req.user!.employeeId;
      if (req.user!.role === 'RECEPTIONIST') {
        throw new AppError(403, 'Forbidden: Receptionists cannot complete repair items');
      }
      if (req.user!.role === 'TECHNICIAN' && order.technicianId !== userId) {
        throw new AppError(403, 'Forbidden: Only the assigned technician or an admin can complete items');
      }

      const result = await RepairService.completeRepairItem(repairOrderId, itemId, { id: userId, role: req.user!.role });
      res.status(200).json({ status: 'success', data: sanitizeForRole(result, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }

  static async resolveItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const repairOrderId = parseInt(req.params.id as string, 10);
      const itemId = parseInt(req.params.itemId as string, 10);
      if (isNaN(repairOrderId) || isNaN(itemId)) {
        throw new AppError(400, 'Invalid repair order or item ID');
      }

      const { status, note } = resolveRepairItemSchema.parse(req.body);

      // Price confirmed by phone (SRS 3.4); ownership for TECHNICIAN is checked inside the service
      const result = await RepairService.resolveRepairItem(repairOrderId, itemId, status, {
        channel: 'PHONE',
        actor: { id: req.user!.employeeId, role: req.user!.role },
        note: note ?? null,
      });
      res.status(200).json({ status: 'success', data: sanitizeForRole(result, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }

  static async updateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        throw new AppError(400, 'Invalid repair order ID');
      }

      const { status, note, payment } = updateRepairStatusSchema.parse(req.body);
      const userId = req.user!.employeeId;

      const order = await prisma.repairOrder.findUnique({
        where: { id },
      });

      if (!order) {
        throw new AppError(404, 'Repair order not found');
      }

      // Role permission checks (D.2)
      if (req.user!.role === 'RECEPTIONIST') {
        const isCompletedToDelivered = order.status === 'COMPLETED' && status === 'DELIVERED';
        // Rework is requested at the front desk when the customer reports the machine is still faulty
        const isRework = order.status === 'COMPLETED' && status === 'REPAIRING';
        const isCancelling = status === 'CANCELLED';
        if (!isCompletedToDelivered && !isRework && !isCancelling) {
          throw new AppError(
            403,
            'Forbidden: Receptionists can only transition orders from COMPLETED to DELIVERED or REPAIRING (rework), or CANCELLED'
          );
        }
      } else if (req.user!.role === 'TECHNICIAN') {
        if (order.technicianId !== userId) {
          throw new AppError(403, 'Forbidden: You are not the assigned technician for this order');
        }
        if (order.status === 'COMPLETED' && status === 'REPAIRING') {
          throw new AppError(403, 'Forbidden: Rework is requested by RECEPTIONIST or ADMIN');
        }
        // Handing the machine back and cancelling are front-desk decisions (same rule as allowedActions)
        if (status === 'DELIVERED' || status === 'CANCELLED') {
          throw new AppError(403, `Forbidden: ${status} is set by RECEPTIONIST or ADMIN`);
        }
        if (status === 'COMPLETED') {
          throw new AppError(403, 'Forbidden: Technicians submit finished work with POST /api/repairs/:id/complete');
        }
      }

      const updatedOrder = await RepairService.updateStatus(id, status, { id: userId, role: req.user!.role }, note, payment);
      res.status(200).json({ status: 'success', data: sanitizeForRole(updatedOrder, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }

  static async getRepairs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = getRepairsQuerySchema.parse(req.query);

      const result = await RepairService.getRepairOrders({
        role: req.user!.role,
        userId: req.user!.employeeId,
        status: query.status,
        technicianId: query.technicianId,
        search: query.search,
        awaitingAck: query.awaitingAck,
        needsProgressUpdate: query.needsProgressUpdate,
        page: query.page,
        limit: query.limit,
      });

      res.status(200).json({ status: 'success', data: sanitizeForRole(result, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/repairs/:id/accept — assigned TECHNICIAN, or ADMIN on their behalf (route enforces roles). */
  static async accept(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        throw new AppError(400, 'Invalid repair order ID');
      }
      const order = await RepairService.acceptOrder(id, { id: req.user!.employeeId, role: req.user!.role });
      res.status(200).json({ status: 'success', data: sanitizeForRole(order, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/repairs/:id/complete — assigned TECHNICIAN or ADMIN (route enforces roles). */
  static async complete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        throw new AppError(400, 'Invalid repair order ID');
      }
      const body = completeRepairSchema.parse(req.body);
      const order = await RepairService.completeOrder(id, { id: req.user!.employeeId, role: req.user!.role }, body);
      res.status(200).json({ status: 'success', data: sanitizeForRole(order, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/repairs/:id/still-working — assigned TECHNICIAN or ADMIN (route enforces roles). */
  static async stillWorking(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        throw new AppError(400, 'Invalid repair order ID');
      }
      const order = await RepairService.stillWorking(id, { id: req.user!.employeeId, role: req.user!.role });
      res.status(200).json({ status: 'success', data: sanitizeForRole(order, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /api/repairs/:id/payment — RECEPTIONIST or ADMIN (route enforces roles). */
  static async setPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        throw new AppError(400, 'Invalid repair order ID');
      }
      const payment = paymentSchema.parse(req.body);
      const order = await RepairService.setPayment(id, { id: req.user!.employeeId, role: req.user!.role }, payment);
      res.status(200).json({ status: 'success', data: sanitizeForRole(order, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /api/repairs/:id/helpers — RECEPTIONIST or ADMIN (route enforces roles). */
  static async setHelpers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        throw new AppError(400, 'Invalid repair order ID');
      }
      const { technicianIds } = setHelpersSchema.parse(req.body);
      const order = await RepairService.setHelpers(id, { id: req.user!.employeeId, role: req.user!.role }, technicianIds);
      res.status(200).json({ status: 'success', data: sanitizeForRole(order, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/repairs/:id/release — ADMIN only (route enforces role). */
  static async release(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        throw new AppError(400, 'Invalid repair order ID');
      }
      const order = await RepairService.releaseOrder(id, { id: req.user!.employeeId, role: req.user!.role });
      res.status(200).json({ status: 'success', data: sanitizeForRole(order, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }

  static async getRepairById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        throw new AppError(400, 'Invalid repair order ID');
      }

      const order = await RepairService.getRepairOrderById(id, {
        id: req.user!.employeeId,
        role: req.user!.role,
      });

      res.status(200).json({ status: 'success', data: sanitizeForRole(order, req.user!.role) });
    } catch (error) {
      next(error);
    }
  }
}
