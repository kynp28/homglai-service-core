import { Request, Response } from 'express';
import prisma from '@homglai/db';
import { SseService } from '../services/sse.service';

export class TrackingController {
  static async streamTrackingUpdates(req: Request, res: Response): Promise<void> {
    const { trackingToken } = req.params;

    if (!trackingToken || typeof trackingToken !== 'string') {
      res.status(400).json({ error: 'trackingToken is required' });
      return;
    }

    const order = await prisma.repairOrder.findUnique({
      where: { trackingToken },
      select: { id: true, trackingToken: true },
    });

    if (!order) {
      res.status(404).json({ error: 'Invalid tracking token' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    SseService.addClient(trackingToken, res);
  }
}
