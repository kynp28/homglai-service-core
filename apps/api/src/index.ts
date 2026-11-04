import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger';
import { PrismaClient } from '@homglai/db';
import repairRoutes from './routes/repair.routes';
import trackingRoutes from './routes/tracking.routes';
import employeeRoutes from './routes/employee.routes';
import webhookRoutes from './routes/webhook.routes';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// Swagger API Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/**
 * @openapi
 * /api/health:
 *   get:
 *     description: Server health check endpoint
 *     responses:
 *       200:
 *         description: Returns server status and database connection state.
 */
app.get('/api/health', async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ status: 'error', database: 'disconnected', timestamp: new Date().toISOString() });
  }
});

app.use('/api/repairs', repairRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/webhook', webhookRoutes);

app.listen(port, () => {
  console.log(`[server]: API Server is running at http://localhost:${port}`);
  console.log(`[server]: Swagger Docs available at http://localhost:${port}/api-docs`);
});
