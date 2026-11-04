import { Request, Response } from 'express';
import { EmployeeService } from '../services/employee.service';

export class EmployeeController {
  static async updateStatus(req: Request, res: Response): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      const { status } = req.body;
      
      if (!['AVAILABLE', 'BUSY', 'OFFLINE'].includes(status)) {
        res.status(400).json({ error: 'Invalid status' });
        return;
      }

      const result = await EmployeeService.updateStatusAndAssignWork(id, status);
      res.status(200).json({ status: 'success', data: result });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }
}
