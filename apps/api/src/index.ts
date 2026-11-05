import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger';
import prisma from '@homglai/db';
import { getAppConfig, getCorsOrigins, getJwtSecret } from './config/env';
import authRoutes from './routes/auth.routes';
import repairRoutes from './routes/repair.routes';
import trackingRoutes from './routes/tracking.routes';
import employeeRoutes from './routes/employee.routes';
import webhookRoutes from './routes/webhook.routes';
import symptomRoutes from './routes/symptom.routes';
import notificationRoutes from './routes/notification.routes';
import holidayRoutes from './routes/holiday.routes';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';

dotenv.config();

// Enforce JWT_SECRET requirement on startup
getJwtSecret();

// Validate all application settings on startup (fails fast with a list of invalid variables)
getAppConfig();

const app = express();
const port = process.env.PORT || 4000;

// Configure trust proxy according to TRUST_PROXY env (default: false / untrusted)
const trustProxyEnv = process.env.TRUST_PROXY;
if (trustProxyEnv === 'true') {
  app.set('trust proxy', true);
} else if (trustProxyEnv && !isNaN(Number(trustProxyEnv))) {
  app.set('trust proxy', Number(trustProxyEnv));
} else if (trustProxyEnv && trustProxyEnv !== 'false') {
  app.set('trust proxy', trustProxyEnv);
} else {
  app.set('trust proxy', false);
}

app.use(helmet());

const allowedOrigins = getCorsOrigins();
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        return callback(null, true);
      }
      return callback(new Error('Blocked by CORS whitelist'));
    },
    credentials: true,
  })
);

// Capture raw body for LINE webhook signature verification before global JSON parser
app.use('/api/webhook/line', express.raw({ type: '*/*' }));

app.use(express.json());

// Swagger API Documentation (Disabled in production mode)
if (process.env.NODE_ENV !== 'production') {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

/**
 * @openapi
 * /api/health:
 *   get:
 *     summary: Health check endpoint
 *     responses:
 *       200:
 *         description: Returns server status and database connection state.
 *       500:
 *         description: Database disconnected.
 */
app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', database: 'disconnected' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/repairs', repairRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/symptoms', symptomRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/holidays', holidayRoutes);

// Catch 404 for any unhandled routes
app.use(notFoundHandler);

// Centralized error handling
app.use(errorHandler);

app.listen(port, () => {
  console.log(`[server]: API Server is running at http://localhost:${port}`);
  console.log(`[server]: Swagger Docs available at http://localhost:${port}/api-docs`);
});
