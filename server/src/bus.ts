import type { ChangeKind } from '../../shared/api.js';
import type { EventAccess } from './access.js';

export interface ChangeMessage {
  kind: ChangeKind;
  eventId: string;
  /** Access info at the time of the change, used to filter recipients. */
  access: EventAccess;
}

type Listener = (msg: ChangeMessage) => void;

/**
 * In-process pub/sub used to fan event changes out to SSE connections.
 *
 * This is sufficient for a single app instance. To run multiple replicas
 * against Postgres, implement the same interface on top of LISTEN/NOTIFY
 * (or Redis) so every instance receives every change.
 */
export class ChangeBus {
  private listeners = new Set<Listener>();

  publish(msg: ChangeMessage): void {
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch {
        // A broken listener must not stop delivery to others.
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }
}
