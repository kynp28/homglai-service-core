import { Request, Response } from 'express';
import crypto from 'crypto';
import { LineWebhookService } from '../services/line-webhook.service';
import { LineStaffService } from '../services/line-staff.service';

/** Verifies X-Line-Signature against the raw body; returns the parsed events or null (response already sent). */
function verifiedEvents(req: Request, res: Response, channelSecret: string | undefined): any[] | null {
  const signature = req.headers['x-line-signature'] as string | undefined;
  if (!signature || !channelSecret) {
    res.status(401).json({ status: 'error', message: 'Signature missing or secret unconfigured' });
    return null;
  }
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
  const computed = Buffer.from(crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64'), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (given.length !== computed.length || !crypto.timingSafeEqual(given, computed)) {
    res.status(401).json({ status: 'error', message: 'Invalid webhook signature' });
    return null;
  }
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    return Array.isArray(parsed?.events) ? parsed.events : [];
  } catch {
    res.status(400).json({ status: 'error', message: 'Invalid JSON payload' });
    return null;
  }
}

export class WebhookController {
  /** POST /api/webhook/line/tech — technicians' Messaging API channel (LINE_TECH_CHANNEL_SECRET). */
  static async lineTechWebhook(req: Request, res: Response): Promise<void> {
    try {
      const events = verifiedEvents(req, res, process.env.LINE_TECH_CHANNEL_SECRET);
      if (events === null) return;
      res.status(200).send('OK');
      LineStaffService.processEvents(events).catch((err) => {
        console.error('[LINE Tech Webhook Background Processing Error]:', err?.message || err);
      });
    } catch (error: any) {
      console.error('[Tech Webhook Controller Error]:', error?.message || error);
      if (!res.headersSent) res.status(500).send('Internal Webhook Error');
    }
  }

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
