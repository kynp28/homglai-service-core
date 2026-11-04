import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { authenticate, loginRateLimiter } from '../middlewares/auth.middleware';

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

export default router;
