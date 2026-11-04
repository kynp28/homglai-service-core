import { Request, Response } from 'express';
import crypto from 'crypto';
import { LineWebhookService } from '../services/line-webhook.service';

export class WebhookController {
  static async lineWebhook(req: Request, res: Response): Promise<void> {
    try {
      const lineChannelSecret = process.env.LINE_CHANNEL_SECRET;
      const signature = req.headers['x-line-signature'] as string | undefined;

      // 1. Signature must be present and LINE_CHANNEL_SECRET configured
      if (!signature || !lineChannelSecret) {
        res.status(401).json({ status: 'error', message: 'Signature missing or secret unconfigured' });
        return;
      }

      // 2. Validate raw body Buffer
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

      const computedHash = crypto
        .createHmac('sha256', lineChannelSecret)
        .update(rawBody)
        .digest('base64');

      const signatureBuffer = Buffer.from(signature, 'utf8');
      const hashBuffer = Buffer.from(computedHash, 'utf8');

      if (signatureBuffer.length !== hashBuffer.length || !crypto.timingSafeEqual(signatureBuffer, hashBuffer)) {
        res.status(401).json({ status: 'error', message: 'Invalid webhook signature' });
        return;
      }

      // 3. Parse JSON body
      let parsedBody: any;
      try {
        parsedBody = JSON.parse(rawBody.toString('utf8'));
      } catch (parseErr) {
        res.status(400).json({ status: 'error', message: 'Invalid JSON payload' });
        return;
      }

      // 4. Respond 200 OK immediately to LINE
      res.status(200).send('OK');

      // 5. Asynchronously process events with error safety
      if (parsedBody?.events && Array.isArray(parsedBody.events)) {
        LineWebhookService.processEvents(parsedBody.events).catch((err) => {
          console.error('[LINE Webhook Background Processing Error]:', err.message || err);
        });
      }
    } catch (error: any) {
      console.error('[Webhook Controller Error]:', error.message || error);
      if (!res.headersSent) {
        res.status(500).send('Internal Webhook Error');
      }
    }
  }
}
