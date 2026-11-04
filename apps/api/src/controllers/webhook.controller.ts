import { Request, Response } from 'express';
import { LineWebhookService } from '../services/line-webhook.service';

export class WebhookController {
  static async lineWebhook(req: Request, res: Response): Promise<void> {
    try {
      const events = req.body.events;
      if (events && Array.isArray(events)) {
        // Process asynchronously so we can return 200 OK to LINE immediately
        LineWebhookService.processEvents(events);
      }
      res.status(200).send('OK');
    } catch (error: any) {
      res.status(500).send('Error');
    }
  }
}
