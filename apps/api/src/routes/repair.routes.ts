import { Router } from 'express';
import { RepairController } from '../controllers/repair.controller';
import { authenticate, requireRole } from '../middlewares/auth.middleware';
import { uploadImages } from '../middlewares/upload.middleware';
import { ImageController } from '../controllers/image.controller';

const router = Router();

/**
 * @openapi
 * /api/repairs:
 *   post:
 *     summary: Create a new repair order
 *     security:
 *       - bearerAuth: []
 *     description: |
 *       Registers or updates customer, registers machine, links symptoms, and opens a repair order with NEW status
 *       using the fields of the paper intake form (SRS 2). Accessible by RECEPTIONIST and ADMIN.
 *       Required minimum: customer name + phone, machine brand + model, at least one symptom.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RepairIntakeCreate'
 *     responses:
 *       201:
 *         description: Repair order created successfully.
 *       400:
 *         description: Validation failed (e.g. unknown accessories key, IN_WARRANTY without warrantyExpiryDate, receivedDate in the future).
 *       401:
 *         description: Unauthorized.
 *       403:
 *         description: Forbidden.
 *       409:
 *         description: paperReceiptNo is already used by another repair order.
 *
 * components:
 *   schemas:
 *     Accessories:
 *       type: object
 *       additionalProperties: false
 *       description: Accessories received with the machine (SRS 2.1). Unknown keys are rejected.
 *       properties:
 *         drainTray: { type: boolean, default: false }
 *         portafilter: { type: boolean, default: false }
 *         basket1Shot: { type: boolean, default: false }
 *         basket2Shot: { type: boolean, default: false }
 *         powerCord: { type: boolean, default: false }
 *         waterTank: { type: boolean, default: false }
 *         tamper: { type: boolean, default: false }
 *         steamWandCover: { type: boolean, default: false }
 *         other: { type: string, nullable: true, maxLength: 100 }
 *     CareAdvice:
 *       type: object
 *       additionalProperties: false
 *       properties:
 *         cleanAfterUse: { type: boolean, default: false }
 *         noOverload: { type: boolean, default: false }
 *     RepairIntakeFields:
 *       type: object
 *       properties:
 *         paperBookNo: { type: string, maxLength: 20, nullable: true, example: "112" }
 *         paperReceiptNo: { type: string, pattern: '^\d{1,10}$', nullable: true, example: "5595", description: "Digits only, unique" }
 *         receivedDate: { type: string, format: date, example: "2026-11-05", description: "Default = today (Asia/Bangkok). Max 1 day in the future." }
 *         warrantyStatus: { type: string, enum: [IN_WARRANTY, OUT_OF_WARRANTY], nullable: true }
 *         warrantyExpiryDate: { type: string, format: date, nullable: true, description: Required when IN_WARRANTY; not allowed otherwise }
 *         billingType: { type: string, enum: [CHARGE_OUT_OF_WARRANTY, NO_CHARGE_IN_WARRANTY, CHARGE_IN_WARRANTY], nullable: true }
 *         accessories: { $ref: '#/components/schemas/Accessories' }
 *         loanerMachine: { type: boolean, default: false }
 *         loanerNote: { type: string, maxLength: 500, nullable: true }
 *         careAdvice: { $ref: '#/components/schemas/CareAdvice' }
 *         warningNote: { type: string, maxLength: 2000, nullable: true }
 *         otherSymptom: { type: string, nullable: true }
 *     RepairIntakeCreate:
 *       allOf:
 *         - $ref: '#/components/schemas/RepairIntakeFields'
 *         - type: object
 *           required: [customer, machine, symptomIds]
 *           properties:
 *             workType: { type: string, enum: [REPAIR], default: REPAIR }
 *             customer:
 *               type: object
 *               required: [name, phone]
 *               properties:
 *                 name: { type: string, example: "บจก. ชวัลชา" }
 *                 phone: { type: string, example: "0812345678" }
 *                 address: { type: string, nullable: true }
 *             machine:
 *               type: object
 *               required: [brand, model]
 *               properties:
 *                 brand: { type: string, example: GEF }
 *                 model: { type: string, example: "Aa+" }
 *                 serialNumber: { type: string }
 *             symptomIds:
 *               type: array
 *               minItems: 1
 *               items: { type: integer }
 *               example: [1, 2]
 *     RepairIntakeUpdate:
 *       allOf:
 *         - $ref: '#/components/schemas/RepairIntakeFields'
 *         - type: object
 *           additionalProperties: false
 *           description: Partial update. status, technicianId, jobNumber and customer.phone are rejected (400).
 *           properties:
 *             customer:
 *               type: object
 *               additionalProperties: false
 *               properties:
 *                 name: { type: string }
 *                 address: { type: string, nullable: true }
 *             machine:
 *               type: object
 *               additionalProperties: false
 *               properties:
 *                 brand: { type: string }
 *                 model: { type: string }
 *                 serialNumber: { type: string, nullable: true }
 *             symptomIds:
 *               type: array
 *               minItems: 1
 *               items: { type: integer }
 *     RepairItemCreate:
 *       type: object
 *       required: [name]
 *       properties:
 *         name: { type: string, example: "ปั๊มน้ำ" }
 *         quantity: { type: integer, minimum: 1, maximum: 999, default: 1, description: "Hours for LABOR_HOURS" }
 *         unitPrice: { type: number, example: 250, description: "> 0 (0 allowed for LABOR_HOURS), max 2 decimals" }
 *         price: { type: number, deprecated: true, description: "Legacy alias of unitPrice" }
 *         barcode: { type: string, maxLength: 64, nullable: true, example: "1681573" }
 *         itemType: { type: string, enum: [PART, TRAVEL_FEE, LABOR_HOURS, SERVICE_FEE], default: PART }
 */
router.post('/', authenticate, requireRole('RECEPTIONIST', 'ADMIN'), RepairController.createRepair);

/**
 * @openapi
 * /api/repairs:
 *   get:
 *     summary: List repair orders with filtering and pagination
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: technicianId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         description: Matches jobNumber, paperReceiptNo, paperBookNo, customer phone or customer name (max 100 chars)
 *         schema: { type: string }
 *       - in: query
 *         name: needsProgressUpdate
 *         description: "true = active jobs (INSPECTING / WAITING_APPROVAL / REPAIRING) idle for at least PROGRESS_REMINDER_INTERVAL_MINUTES of business time; rows include idleBusinessMinutes (TECHNICIAN own, ADMIN all)"
 *         schema: { type: string, enum: ['true', 'false'] }
 *       - in: query
 *         name: awaitingAck
 *         description: "true = only jobs reserved for a technician but not yet accepted (ADMIN sees all, TECHNICIAN sees own)"
 *         schema: { type: string, enum: ['true', 'false'] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     description: TECHNICIAN sees only orders assigned to them (including ones awaiting acceptance); unassigned NEW orders are not listed. Each row includes assignedAt and waitingMinutes (minutes a reserved job has waited for acceptance, null otherwise).
 *     responses:
 *       200:
 *         description: List of repair orders (summary incl. paperReceiptNo, paperBookNo, receivedDate, warrantyStatus)
 *       401:
 *         description: Unauthorized
 */
router.get('/', authenticate, RepairController.getRepairs);

/**
 * @openapi
 * /api/repairs/{id}:
 *   get:
 *     summary: Get repair order details by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     description: |
 *       Full intake data (paper form fields, warranty, accessories, careAdvice, ...), items with
 *       quantity / unitPrice / amount / itemType / barcode / resolution fields, and totalAmount
 *       (sum of the amounts of all items, no VAT/discount). TECHNICIAN may only view orders assigned to them.
 *       Also returns payment (see PUT /payment) and allowedActions: the buttons the caller may use on this order —
 *       ACCEPT, RELEASE, ADD_ITEM, RESOLVE_ITEM, COMPLETE_ITEM, START_REPAIR, STILL_WORKING, COMPLETE,
 *       COMPLETE_NOT_REPAIRED, REWORK, DELIVER, RECORD_PAYMENT, EDIT_HELPERS, EDIT_INTAKE, CANCEL. The web app shows a
 *       button only when its action is listed; the endpoints enforce the same rules.
 *     responses:
 *       200:
 *         description: Repair order details
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (Technician viewing an order not assigned to them, including unassigned NEW orders)
 *       404:
 *         description: Not found
 */
router.get('/:id', authenticate, RepairController.getRepairById);

/**
 * @openapi
 * /api/repairs/{id}:
 *   patch:
 *     summary: Edit intake data of a repair order
 *     security:
 *       - bearerAuth: []
 *     description: |
 *       RECEPTIONIST/ADMIN only. Edits paper-form / customer (name, address) / machine / symptoms / warranty /
 *       accessories / loaner / billingType / careAdvice / warningNote / receivedDate / paperBookNo / paperReceiptNo.
 *       Cannot change status, technicianId or jobNumber. Not allowed on DELIVERED or CANCELLED orders.
 *       A StatusLog entry records who edited which fields (field names only).
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RepairIntakeUpdate'
 *     responses:
 *       200:
 *         description: Updated repair order details (same shape as GET /api/repairs/{id})
 *       400:
 *         description: Validation failed or forbidden field (status/technicianId/jobNumber)
 *       403:
 *         description: Forbidden (TECHNICIAN)
 *       404:
 *         description: Not found
 *       409:
 *         description: Order is DELIVERED/CANCELLED, or paperReceiptNo already used
 */
router.patch('/:id', authenticate, requireRole('RECEPTIONIST', 'ADMIN'), RepairController.updateRepair);

/**
 * @openapi
 * /api/repairs/{id}/accept:
 *   post:
 *     summary: Accept a reserved job (technician "รับงานนี้")
 *     security:
 *       - bearerAuth: []
 *     description: |
 *       The assigned TECHNICIAN accepts the job reserved for them, or an ADMIN accepts on their behalf
 *       (logged as such). NEW -> INSPECTING and technician RESERVED -> BUSY. A job that was returned to
 *       the pool from a deactivated technician resumes at WAITING_APPROVAL (PENDING items), REPAIRING
 *       (APPROVED/COMPLETED items) or INSPECTING.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Accepted; returns the repair order details
 *       403:
 *         description: RECEPTIONIST, or a technician the job is not reserved for
 *       404:
 *         description: Not found
 *       409:
 *         description: Not waiting for acceptance (already accepted, unassigned, or other status)
 */
router.post('/:id/accept', authenticate, requireRole('TECHNICIAN', 'ADMIN'), RepairController.accept);

/**
 * @openapi
 * /api/repairs/{id}/release:
 *   post:
 *     summary: Release a reserved job back to the pool (ADMIN)
 *     security:
 *       - bearerAuth: []
 *     description: |
 *       Only for a job reserved for a technician that has not been accepted yet. The order goes back to
 *       the pool (technicianId cleared), the technician returns to AVAILABLE, and the queue runs again.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Released; returns the repair order details (it may already be reserved for another technician)
 *       403:
 *         description: Not an ADMIN
 *       404:
 *         description: Not found
 *       409:
 *         description: Not a reserved, unaccepted job
 */
router.post('/:id/release', authenticate, requireRole('ADMIN'), RepairController.release);

/**
 * @openapi
 * /api/repairs/{id}/items:
 *   post:
 *     summary: Add a repair item (auto-approved below PRICE_APPROVAL_THRESHOLD, otherwise starts the approval loop)
 *     security:
 *       - bearerAuth: []
 *     description: |
 *       Adds an item (PART / TRAVEL_FEE / LABOR_HOURS / SERVICE_FEE) to the repair order. Accessible by the assigned
 *       TECHNICIAN or ADMIN. Response item includes quantity, unitPrice, amount (= quantity x unitPrice), itemType,
 *       barcode and the legacy `price` alias (= unitPrice, kept temporarily).
 *       Price confirmation threshold (PRICE_APPROVAL_THRESHOLD, THB): when the order total (all item types,
 *       REJECTED excluded, this item included) stays below it and no other item is PENDING, the item is created
 *       APPROVED automatically and the order moves to REPAIRING (no customer call, no LINE quotation). Otherwise the
 *       item is PENDING and the order moves to WAITING_APPROVAL. 0 (default) = every item needs confirmation.
 *       Response data includes `autoApproved`.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RepairItemCreate'
 *     responses:
 *       201:
 *         description: Item added and status updated.
 *       401:
 *         description: Unauthorized.
 *       403:
 *         description: Forbidden.
 *       404:
 *         description: Order not found.
 */
router.post('/:id/items', authenticate, RepairController.addItem);

/**
 * @openapi
 * /api/repairs/{id}/items/{itemId}/status:
 *   patch:
 *     summary: Record the customer's price decision for an item (phone confirmation)
 *     security:
 *       - bearerAuth: []
 *     description: |
 *       SRS 3.4: the shop confirms prices with the customer by phone and records the result per item.
 *       Allowed: RECEPTIONIST, ADMIN, and the TECHNICIAN assigned to the order (other technicians 403).
 *       Stores resolvedById, resolvedAt, resolutionChannel = PHONE and the optional note. When every item is
 *       decided the order moves to REPAIRING (at least one approved) or back to INSPECTING (all rejected).
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [APPROVED, REJECTED]
 *               note:
 *                 type: string
 *                 maxLength: 500
 *                 example: "โทรคุยกับเจ้าของร้าน 14:20"
 *     responses:
 *       200:
 *         description: Item resolved successfully.
 *       401:
 *         description: Unauthorized.
 *       403:
 *         description: Forbidden.
 */
router.patch(
  '/:id/items/:itemId/status',
  authenticate,
  requireRole('RECEPTIONIST', 'ADMIN', 'TECHNICIAN'),
  RepairController.resolveItem
);

/**
 * @openapi
 * /api/repairs/{id}/complete:
 *   post:
 *     summary: Submit finished repair work ("ส่งงานซ่อม")
 *     security:
 *       - bearerAuth: []
 *     description: |
 *       The assigned TECHNICIAN (or an ADMIN) completes a REPAIRING order with a summary. Every APPROVED item must be
 *       COMPLETED first (409 with the count). Optional helperTechnicianIds records technicians who helped
 *       (informational only, active technicians other than the owner). The technician becomes AVAILABLE when they
 *       hold no other job and is immediately offered the next job in the queue.
 *       outcome NOT_REPAIRED ("ลูกค้าไม่ซ่อม") closes an INSPECTING or REPAIRING order without repair; the machine is
 *       then handed back through DELIVERED as usual and the customer LINE message says it was not repaired.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [completionSummary]
 *             properties:
 *               completionSummary: { type: string, minLength: 1, maxLength: 2000 }
 *               helperTechnicianIds:
 *                 type: array
 *                 maxItems: 10
 *                 items: { type: integer }
 *               outcome: { type: string, enum: [REPAIRED, NOT_REPAIRED], default: REPAIRED }
 *     responses:
 *       200:
 *         description: Completed; returns the repair order details
 *       400:
 *         description: Invalid summary or helper technicians
 *       403:
 *         description: Not the assigned technician / not allowed
 *       409:
 *         description: Not REPAIRING, or approved items not yet completed
 */
router.post('/:id/complete', authenticate, requireRole('TECHNICIAN', 'ADMIN'), RepairController.complete);

/**
 * @openapi
 * /api/repairs/{id}/still-working:
 *   post:
 *     summary: '"ยังซ่อมอยู่" — confirm the job is still in progress'
 *     security:
 *       - bearerAuth: []
 *     description: Restarts the progress-reminder timer (lastActivityAt) and clears the unanswered counter. Assigned TECHNICIAN or ADMIN; only while INSPECTING / WAITING_APPROVAL / REPAIRING.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Timer reset; returns the repair order details
 *       403:
 *         description: Not the assigned technician / not allowed
 *       409:
 *         description: Order is not in an active work status
 */
router.post('/:id/still-working', authenticate, requireRole('TECHNICIAN', 'ADMIN'), RepairController.stillWorking);

/**
 * @openapi
 * /api/repairs/{id}/helpers:
 *   put:
 *     summary: Set the helper technicians of a job
 *     security:
 *       - bearerAuth: []
 *     description: RECEPTIONIST / ADMIN replace the list of helper technicians (informational only) until the order is DELIVERED or CANCELLED. An empty list clears it.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [technicianIds]
 *             properties:
 *               technicianIds:
 *                 type: array
 *                 maxItems: 10
 *                 items: { type: integer }
 *     responses:
 *       200:
 *         description: Updated; returns the repair order details (helpers listed)
 *       400:
 *         description: Invalid technician ids (owner, inactive, not a technician)
 *       403:
 *         description: TECHNICIAN
 *       409:
 *         description: Order is DELIVERED or CANCELLED
 */
router.put('/:id/helpers', authenticate, requireRole('RECEPTIONIST', 'ADMIN'), RepairController.setHelpers);

/**
 * @openapi
 * /api/repairs/{id}/payment:
 *   put:
 *     summary: Record or correct the payment of a COMPLETED / DELIVERED order (RECEPTIONIST, ADMIN)
 *     security:
 *       - bearerAuth: []
 *     description: |
 *       Record only, never blocks delivery. The detail response has payment { payableAmount (APPROVED + COMPLETED
 *       items), paidAmount, status NOT_RECORDED | MATCHED | DIFFERENT, warning { code, message } | null, method, note,
 *       paidAt, recordedBy }. Every change is written to the status log.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, method]
 *             properties:
 *               amount: { type: number, minimum: 0 }
 *               method: { type: string, enum: [CASH, TRANSFER, OTHER] }
 *               note: { type: string, maxLength: 500 }
 *     responses:
 *       200:
 *         description: Recorded; returns the repair order details
 *       400:
 *         description: Invalid amount / method
 *       403:
 *         description: Not RECEPTIONIST / ADMIN
 *       409:
 *         description: Order is not COMPLETED or DELIVERED
 */
router.put('/:id/payment', authenticate, requireRole('RECEPTIONIST', 'ADMIN'), RepairController.setPayment);

/**
 * @openapi
 * /api/repairs/{id}/images:
 *   post:
 *     summary: Upload photos of a repair order (multipart)
 *     security:
 *       - bearerAuth: []
 *     description: |
 *       multipart/form-data: field "files" (1..IMAGE_MAX_PER_KIND files) and field "kind".
 *       INTAKE / RECEIPT_PAPER: RECEPTIONIST, ADMIN. DELIVERY / OTHER: the assigned TECHNICIAN, RECEPTIONIST, ADMIN.
 *       The file content is checked (JPEG, PNG or WebP only; HEIC/HEIF -> 415), auto-rotated, all EXIF/GPS metadata
 *       removed, shrunk to IMAGE_MAX_LONG_EDGE and stored as JPEG. At most IMAGE_MAX_PER_KIND images per kind per order
 *       (409). Not allowed on DELIVERED/CANCELLED orders (409). Images are never public. Returns the image list.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [files, kind]
 *             properties:
 *               kind: { type: string, enum: [INTAKE, RECEIPT_PAPER, DELIVERY, OTHER] }
 *               files:
 *                 type: array
 *                 items: { type: string, format: binary }
 *     responses:
 *       201:
 *         description: "[{ id, kind, createdAt, uploadedBy: { id, name } }]"
 *       400:
 *         description: Missing files / invalid kind / too many files in one request
 *       403:
 *         description: Not allowed for this kind or not the assigned technician
 *       409:
 *         description: Per-kind limit reached or order closed
 *       413:
 *         description: A file is larger than IMAGE_MAX_BYTES
 *       415:
 *         description: Not a JPEG / PNG / WebP image
 *   get:
 *     summary: List photo metadata of a repair order
 *     security:
 *       - bearerAuth: []
 *     description: ADMIN / RECEPTIONIST any order; TECHNICIAN only their own. No storage paths are returned.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: "[{ id, kind, createdAt, uploadedBy: { id, name } }]"
 */
router.post('/:id/images', authenticate, uploadImages, ImageController.upload);
router.get('/:id/images', authenticate, ImageController.list);

/**
 * @openapi
 * /api/repairs/{id}/images/{imageId}:
 *   get:
 *     summary: Download one photo (image/jpeg)
 *     security:
 *       - bearerAuth: []
 *     description: Same visibility as the list. The image must belong to this order. Cache-Control private, no-store.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: imageId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: JPEG bytes
 *         content:
 *           image/jpeg:
 *             schema: { type: string, format: binary }
 *       404:
 *         description: Not found, not of this order, or the file is gone
 */
router.get('/:id/images/:imageId', authenticate, ImageController.download);

/**
 * @openapi
 * /api/repairs/{id}/items/{itemId}/complete:
 *   patch:
 *     summary: Mark an approved item as completed
 *     security:
 *       - bearerAuth: []
 *     description: Sets status of an approved item to COMPLETED. Accessible by assigned technician or ADMIN.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Item marked as COMPLETED
 *       403:
 *         description: Forbidden
 *       409:
 *         description: Item not in APPROVED status
 */
router.patch(
  '/:id/items/:itemId/complete',
  authenticate,
  RepairController.completeItem
);

/**
 * @openapi
 * /api/repairs/{id}/status:
 *   patch:
 *     summary: Update repair order status
 *     security:
 *       - bearerAuth: []
 *     description: Updates repair order status. Accessible by all authenticated roles (TECHNICIAN must be assigned technician). COMPLETED uses the same rules as POST /complete; technicians must use POST /complete (403 here).
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status: 
 *                 type: string
 *                 enum: [NEW, INSPECTING, WAITING_APPROVAL, REPAIRING, COMPLETED, DELIVERED, CANCELLED]
 *               note: { type: string }
 *               payment:
 *                 type: object
 *                 description: Only with status DELIVERED. Payment received at handover (record only, never required).
 *                 required: [amount, method]
 *                 properties:
 *                   amount: { type: number, minimum: 0, example: 845.3 }
 *                   method: { type: string, enum: [CASH, TRANSFER, OTHER] }
 *                   note: { type: string, maxLength: 500 }
 *     responses:
 *       200:
 *         description: Status updated successfully.
 *       401:
 *         description: Unauthorized.
 *       403:
 *         description: Forbidden.
 *       404:
 *         description: Order not found.
 */
router.patch('/:id/status', authenticate, RepairController.updateStatus);

export default router;
