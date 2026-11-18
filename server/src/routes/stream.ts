import type { FastifyInstance } from 'fastify';
import type { ChangeBus } from '../bus.js';
import { canView } from '../access.js';
import { requireUser } from '../auth.js';
import type { ChangeNotification } from '../../../shared/api.js';

const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events stream. Clients receive lightweight "event X changed"
 * notifications (only for events they can see) and refetch what they need.
 */
export async function registerStreamRoute(app: FastifyInstance, bus: ChangeBus): Promise<void> {
  app.get('/api/stream', { preHandler: requireUser }, (request, reply) => {
    const user = request.user!;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stop nginx & friends from buffering the stream.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n: connected\n\n');

    const unsubscribe = bus.subscribe((msg) => {
      if (!canView(user, msg.access)) return;
      const payload: ChangeNotification = { kind: msg.kind, eventId: msg.eventId };
      res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', close);
    res.on('error', close);
  });
}
