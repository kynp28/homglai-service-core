import { Request, Response } from 'express';
import prisma from '@homglai/db';
import { SseService } from '../services/sse.service';
import { bindLineToOrder, findOrderByTrackingQuery } from '../services/line-subscription.service';
import { LineWebhookService } from '../services/line-webhook.service';
import { getLineIdentityVerifier } from '../services/line-identity';
import { statusLabelTh, toPublicTrackingView } from '../utils/customer-view';

/**
 * Byte-identical 404 for every "not found" case (unknown number, bad format, missing body), so the
 * endpoint cannot be used to discover which job / receipt numbers exist (SRS 3.2).
 */
export const TRACKING_NOT_FOUND_BODY = Object.freeze({
  status: 'error',
  message: 'ไม่พบข้อมูลใบงาน กรุณาตรวจสอบเลขที่อีกครั้ง',
});

/** One generic answer for every failed LINE link attempt (unknown order, wrong phone, bad token). */
export const SUBSCRIBE_FAILED_BODY = Object.freeze({
  status: 'error',
  message: 'ไม่สามารถผูกบัญชี LINE ได้ กรุณาตรวจสอบเลขใบงานและเบอร์โทรศัพท์อีกครั้ง',
});

export class TrackingController {
  /** POST /api/tracking/search — public, whitelist response only. */
  static async search(req: Request, res: Response): Promise<void> {
    const found = await findOrderByTrackingQuery(req.body?.query);
    if (!found) {
      res.status(404).json(TRACKING_NOT_FOUND_BODY);
      return;
    }
    const order = await prisma.repairOrder.findUniqueOrThrow({
      where: { id: found.id },
      select: {
        jobNumber: true,
        status: true,
        repairOutcome: true,
        receivedDate: true,
        updatedAt: true,
        machine: { select: { brand: true, model: true } },
        statusLogs: { select: { status: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    res.status(200).json({ status: 'success', data: toPublicTrackingView(order) });
  }

  /**
   * POST /api/tracking/subscribe-line — link the caller's LINE account (proven by a LIFF access
   * token verified server-side) to one order, after checking the phone number on file.
   */
  static async subscribeLine(req: Request, res: Response): Promise<void> {
    const { query, phone, lineAccessToken } = req.body ?? {};
    const lineUserId =
      typeof lineAccessToken === 'string' && lineAccessToken.length > 0 && lineAccessToken.length <= 2000
        ? await getLineIdentityVerifier().verify(lineAccessToken)
        : null;
    const result = lineUserId ? await bindLineToOrder(query, phone, lineUserId) : ({ ok: false } as const);
    if (!result.ok) {
      res.status(400).json(SUBSCRIBE_FAILED_BODY);
      return;
    }
    const order = await prisma.repairOrder.findUniqueOrThrow({
      where: { id: result.order.id },
      select: { jobNumber: true, status: true, repairOutcome: true },
    });
    // Confirmation in the customer's chat on a new link (status only — no personal data, SRS 5)
    if (!result.alreadySubscribed) {
      LineWebhookService.sendPush(lineUserId!, [
        {
          type: 'text',
          text: `รับแจ้งเตือนใบงาน ${order.jobNumber} เรียบร้อยแล้ว ✅\nสถานะตอนนี้: ${statusLabelTh(order.status, order.repairOutcome)}\nร้านจะแจ้งทาง LINE นี้ทุกครั้งที่สถานะเปลี่ยน`,
        },
      ]).catch(() => {});
    }
    res.status(200).json({
      status: 'success',
      data: {
        subscribed: true,
        alreadySubscribed: result.alreadySubscribed,
        jobNumber: order.jobNumber,
        status: order.status,
        statusLabelTh: statusLabelTh(order.status, order.repairOutcome),
      },
    });
  }

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
