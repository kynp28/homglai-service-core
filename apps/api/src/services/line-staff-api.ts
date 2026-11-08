import axios from 'axios';
import { getAppConfig } from '../config/env';

/**
 * Low-level calls to the technicians' LINE Messaging API channel (LINE_TECH_CHANNEL_ACCESS_TOKEN).
 * Kept free of business-service imports so the notifier can use it without import cycles.
 */
export function techLineEnabled(): boolean {
  return !!process.env.LINE_TECH_CHANNEL_ACCESS_TOKEN;
}

async function callLine(path: 'push' | 'reply', body: Record<string, unknown>): Promise<boolean> {
  const token = process.env.LINE_TECH_CHANNEL_ACCESS_TOKEN;
  if (!token) return false;
  try {
    await axios.post(`https://api.line.me/v2/bot/message/${path}`, body, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      timeout: 5000,
    });
    return true;
  } catch (error: any) {
    console.error(`[LINE Tech ${path} Error]:`, error.response?.data || error.message);
    return false;
  }
}

export const LineStaffApi = {
  push(lineUserId: string, messages: unknown[]): Promise<boolean> {
    return callLine('push', { to: lineUserId, messages });
  },
  reply(replyToken: string, text: string): Promise<boolean> {
    return LineStaffApi.replyMessages(replyToken, [{ type: 'text', text }]);
  },
  /** Up to 5 messages in one reply. */
  replyMessages(replyToken: string, messages: unknown[]): Promise<boolean> {
    if (!replyToken || messages.length === 0) return Promise.resolve(false);
    return callLine('reply', { replyToken, messages: messages.slice(0, 5) });
  },
};

/**
 * Link that opens one job for staff: inside LINE through the technicians' LIFF app when LINE_TECH_LIFF_ID
 * is set (no web login), otherwise the staff web page (STAFF_WEB_URL). null when neither is configured.
 * `action` asks the LIFF page to open a form straight away (e.g. "add-item", "complete").
 */
export function staffJobUrl(orderId: number, action?: string): string | null {
  const { lineTechLiffId, staffWebUrl } = getAppConfig();
  if (lineTechLiffId) {
    return `https://liff.line.me/${lineTechLiffId}/jobs/${orderId}${action ? `?do=${encodeURIComponent(action)}` : ''}`;
  }
  if (staffWebUrl.startsWith('https://')) return `${staffWebUrl}/staff/repairs/${orderId}`;
  return null;
}

export const ACCEPT_JOB_ACTION = 'accept_job';

export const STILL_WORKING_ACTION = 'still_working';

export const START_REPAIR_ACTION = 'start_repair';
