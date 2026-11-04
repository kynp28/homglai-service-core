import { NextFunction, Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { changePasswordSchema } from '../validators/employee.validator';

export class AuthController {
  static async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await AuthService.login(req.body);
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validatedData = changePasswordSchema.parse(req.body);
      const employeeId = req.user!.employeeId;
      const result = await AuthService.changePassword(employeeId, validatedData);
      res.status(200).json({ status: 'success', ...result });
    } catch (error) {
      next(error);
    }
  }
}
