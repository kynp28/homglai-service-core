import { Request, Response } from 'express';
import { RepairService } from '../services/repair.service';

export class RepairController {
  static async createRepair(req: Request, res: Response): Promise<void> {
    try {
      // Validate minimal required payload
      const { customer, machine, symptomIds, receptionistId, otherSymptom } = req.body;
      if (!customer?.name || !customer?.phone || !machine?.brand || !machine?.model || !receptionistId) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
      }

      const repairOrder = await RepairService.createRepairOrder({
        customer,
        machine,
        symptomIds: symptomIds || [],
        otherSymptom,
        receptionistId
      });

      res.status(201).json({ status: 'success', data: repairOrder });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }

  static create = RepairController.createRepair;

  static async addItem(req: Request, res: Response): Promise<void> {
    try {
      const repairOrderId = parseInt(req.params.id as string, 10);
      const { name, price, technicianId } = req.body;

      if (!name || price === undefined || !technicianId) {
        res.status(400).json({ error: 'Missing required fields: name, price, technicianId' });
        return;
      }

      const result = await RepairService.addRepairItem(repairOrderId, {
        name,
        price: parseFloat(price),
        technicianId
      });

      res.status(201).json({ status: 'success', data: result });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }

  static async resolveItem(req: Request, res: Response): Promise<void> {
    try {
      const repairOrderId = parseInt(req.params.id as string, 10);
      const itemId = parseInt(req.params.itemId as string, 10);
      const { status } = req.body;

      if (!['APPROVED', 'REJECTED'].includes(status)) {
        res.status(400).json({ error: 'Invalid status. Must be APPROVED or REJECTED' });
        return;
      }

      const result = await RepairService.resolveRepairItem(repairOrderId, itemId, status);
      res.status(200).json({ status: 'success', data: result });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }

  static async updateStatus(req: Request, res: Response): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      const { status, userId, note } = req.body;
      const updatedOrder = await RepairService.updateStatus(id, status, userId, note);
      res.status(200).json({ status: 'success', data: updatedOrder });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }
}
