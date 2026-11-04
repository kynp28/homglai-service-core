import { Response } from 'express';

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

  static broadcastUpdate(trackingToken: string, payload: any) {
    const tokenClients = clients.get(trackingToken);
    if (tokenClients) {
      const data = `data: ${JSON.stringify(payload)}\n\n`;
      tokenClients.forEach((client) => {
        client.write(data);
      });
    }
  }
}
