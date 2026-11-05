import { Response } from 'express';
import { RepairStatus } from '@homglai/db';

/** The only data a public tracking stream ever receives. */
export interface PublicStatusEvent {
  status: RepairStatus;
  updatedAt: string;
}

// Store connections mapped by trackingToken
const clients = new Map<string, Set<Response>>();

export class SseService {
  static addClient(trackingToken: string, res: Response) {
    if (!clients.has(trackingToken)) {
      clients.set(trackingToken, new Set());
    }
    clients.get(trackingToken)!.add(res);

    // Keep connection alive
    const intervalId = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    // Remove client on connection close
    res.on('close', () => {
      clearInterval(intervalId);
      const tokenClients = clients.get(trackingToken);
      if (tokenClients) {
        tokenClients.delete(res);
        if (tokenClients.size === 0) {
          clients.delete(trackingToken);
        }
      }
    });
  }

  /**
   * Public SSE payload (SRS 5, PDPA): ONLY { status, updatedAt }. The payload is rebuilt from these
   * two fields so extra properties passed by mistake can never reach the customer's browser.
   * Call through OrderEvents.statusChanged, not directly.
   */
  static broadcastStatus(trackingToken: string, payload: PublicStatusEvent) {
    const tokenClients = clients.get(trackingToken);
    if (tokenClients) {
      const safe: PublicStatusEvent = { status: payload.status, updatedAt: payload.updatedAt };
      const data = `data: ${JSON.stringify(safe)}\n\n`;
      tokenClients.forEach((client) => {
        client.write(data);
      });
    }
  }
}
