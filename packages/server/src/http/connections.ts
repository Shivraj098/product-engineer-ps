import type { ServerResponse } from 'node:http';

/** Tracks open event streams, so they can be severed on demand or on shutdown. */
export class ConnectionRegistry {
  private readonly active = new Set<ServerResponse>();

  get size(): number {
    return this.active.size;
  }

  add(res: ServerResponse): void {
    this.active.add(res);
  }

  delete(res: ServerResponse): void {
    this.active.delete(res);
  }

  /** Abruptly cuts every open stream, like a network failure. Returns how many. */
  dropAll(): number {
    const count = this.active.size;
    for (const res of this.active) {
      res.destroy();
    }
    this.active.clear();
    return count;
  }
}
