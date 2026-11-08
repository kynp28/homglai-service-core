import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import rateLimit from 'express-rate-limit';
import { authenticate, loginRateLimiter } from '../middlewares/auth.middleware';
import { LineStaffService } from '../services/line-staff.service';

const router = Router();

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     summary: Employee login
 *     description: Authenticates an employee by username and password. Returns a 12-hour JWT token.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *                 example: admin
 *               password:
 *                 type: string
 *                 example: SecretPassword123!
 *     responses:
 *       200:
 *         description: Login successful.
 *       401:
 *         description: Invalid username or password.
 *       429:
 *         description: Too many login attempts.
 */
router.post('/login', loginRateLimiter, AuthController.login);

/**
 * @openapi
 * /api/auth/change-password:
 *   post:
 *     summary: Change self password
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [oldPassword, newPassword]
 *             properties:
 *               oldPassword: { type: string }
 *               newPassword: { type: string, minLength: 12 }
 *     responses:
 *       200:
 *         description: Password changed successfully
 *       401:
 *         description: Current password incorrect
 */
router.post('/change-password', authenticate, AuthController.changePassword);

/** Opening the LIFF app signs in every time, so this allows more attempts than the password login. */
const lineLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many login attempts. Please try again later.' },
});

/**
 * @openapi
 * /api/auth/line:
 *   post:
 *     summary: Sign in with LINE (technicians' LIFF)
 *     description: |
 *       Body { lineAccessToken } from liff.getAccessToken() of the technicians' LIFF. The token is verified with LINE
 *       (LINE_TECH_LOGIN_CHANNEL_ID) and must belong to a LINE account already linked to an active employee
 *       (POST /api/employees/me/line). Returns the same { token, employee } as /api/auth/login.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [lineAccessToken]
 *             properties:
 *               lineAccessToken: { type: string }
 *     responses:
 *       200:
 *         description: "{ token, employee }"
 *       401:
 *         description: Invalid LINE token
 *       404:
 *         description: LINE account not linked to an active employee (message LINE_NOT_LINKED)
 */
router.post('/line', lineLoginLimiter, async (req, res, next) => {
  try {
    const result = await LineStaffService.loginWithLine(req.body?.lineAccessToken);
    res.status(200).json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
});

export default router;
