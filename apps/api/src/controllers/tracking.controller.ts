import { Request, Response } from 'express';
import { SseService } from '../services/sse.service';

export class TrackingController {
  static streamTrackingUpdates(req: Request, res: Response): void {
    const { jobNumber } = req.params;

    if (!jobNumber || typeof jobNumber !== 'string') {
      res.status(400).json({ error: 'jobNumber is required' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Register client for this specific job number
    SseService.addClient(jobNumber, res);
  }
}
