import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, requireRole } from '../middlewares/auth.middleware';
import { PartService } from '../services/part.service';
import { AppError } from '../utils/app-error';

const router = Router();

const wrap =
  (handler: (req: Request, res: Response) => Promise<unknown>, status = 200) =>
  (req: Request, res: Response, next: NextFunction) =>
    handler(req, res)
      .then((data) => res.status(status).json({ status: 'success', data }))
      .catch(next);

const idParam = (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) throw new AppError(400, 'Invalid part ID');
  return id;
};

const STOCK_ROLES = ['ADMIN', 'RECEPTIONIST'] as const;

/**
 * @openapi
 * /api/parts:
 *   get:
 *     summary: List / search spare parts (any staff role)
 *     description: "Query: search (code, name or machine model), includeInactive, page, limit (max 500). Money values are strings."
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ total, page, limit, totalPages, parts }"
 *   post:
 *     summary: Add a spare part (ADMIN, RECEPTIONIST)
 *     description: "Body { code?, name, category?, machineModels?, unit?, sellPrice?, costPrice?, note?, stockQty? }. Without code a HG00001-style code is generated. 409 when the code exists."
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Created part
 * /api/parts/by-code/{code}:
 *   get:
 *     summary: Find a part by its barcode / code (any staff role)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Part
 *       404:
 *         description: Not found
 * /api/parts/import:
 *   post:
 *     summary: Import parts from a spreadsheet (ADMIN, RECEPTIONIST)
 *     description: "Body { rows: [{ code, name, category?, machineModels?, unit?, sellPrice?, costPrice?, note?, stockQty? }] } — upsert by code; stockQty only for new parts. Returns { created, updated, skipped }."
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Import summary
 * /api/parts/{id}:
 *   patch:
 *     summary: Edit a part (ADMIN, RECEPTIONIST)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Updated part
 * /api/parts/{id}/stock:
 *   post:
 *     summary: Change stock (ADMIN, RECEPTIONIST)
 *     description: "Body { change: +n|-n } or { set: counted }, reason SCAN_IN|ADJUST|COUNT, note. Never below 0 (409). Every change is logged."
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Updated part
 *   get:
 *     summary: Last 100 stock changes of a part (any staff role)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Stock log
 */
router.get('/', authenticate, wrap((req) => PartService.list(req.query)));
router.get('/by-code/:code', authenticate, wrap((req) => PartService.byCode(String(req.params.code))));
router.post('/', authenticate, requireRole(...STOCK_ROLES), wrap((req) => PartService.create(req.body, req.user!.employeeId), 201));
router.post('/import', authenticate, requireRole(...STOCK_ROLES), wrap((req) => PartService.import(req.body, req.user!.employeeId)));
router.patch('/:id', authenticate, requireRole(...STOCK_ROLES), wrap(async (req) => PartService.update(idParam(req), req.body)));
router.post('/:id/stock', authenticate, requireRole(...STOCK_ROLES), wrap(async (req) => PartService.adjustStock(idParam(req), req.body, req.user!.employeeId)));
router.get('/:id/stock', authenticate, wrap(async (req) => PartService.stockLogs(idParam(req))));

export default router;
