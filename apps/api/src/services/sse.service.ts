import { Response } from 'express';

// Store connections mapped by jobNumber
const clients = new Map<string, Set<Response>>();

export class SseService {
  static addClient(jobNumber: string, res: Response) {
    if (!clients.has(jobNumber)) {
      clients.set(jobNumber, new Set());
    }
    clients.get(jobNumber)!.add(res);

    // Keep connection alive
    const intervalId = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    // Remove client on connection close
    res.on('close', () => {
      clearInterval(intervalId);
      const jobClients = clients.get(jobNumber);
      if (jobClients) {
        jobClients.delete(res);
        if (jobClients.size === 0) {
          clients.delete(jobNumber);
        }
      }
    });
  }

  static broadcastUpdate(jobNumber: string, payload: any) {
    const jobClients = clients.get(jobNumber);
    if (jobClients) {
      const data = `data: ${JSON.stringify(payload)}\n\n`;
      jobClients.forEach((client) => {
        client.write(data);
      });
    }
  }
}
