import axios from 'axios';

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
    if (!replyToken) return Promise.resolve(false);
    return callLine('reply', { replyToken, messages: [{ type: 'text', text }] });
  },
};

export const ACCEPT_JOB_ACTION = 'accept_job';

export const STILL_WORKING_ACTION = 'still_working';
