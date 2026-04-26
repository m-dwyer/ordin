/**
 * In-memory pub/sub with replay. A run accumulates events until it
 * completes; late subscribers (HTTP SSE clients connecting after the
 * run started) replay buffered events first, then stream live ones.
 * Closes once when the run finishes — subscribers exit cleanly.
 */
export class EventBus<T> {
  private readonly buffer: T[] = [];
  private readonly listeners = new Set<(event: T) => void>();
  private closed = false;
  private readonly closePromise: Promise<void>;
  private resolveClose!: () => void;

  constructor() {
    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClose = resolve;
    });
  }

  emit(event: T): void {
    if (this.closed) return;
    this.buffer.push(event);
    for (const listener of this.listeners) listener(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveClose();
  }

  isClosed(): boolean {
    return this.closed;
  }

  buffered(): readonly T[] {
    return this.buffer;
  }

  async *subscribe(): AsyncIterableIterator<T> {
    const queue: T[] = [];
    let waker: (() => void) | null = null;

    const replay = this.buffer.slice();
    const listener = (event: T) => {
      queue.push(event);
      const w = waker;
      waker = null;
      w?.();
    };
    this.listeners.add(listener);

    try {
      for (const event of replay) yield event;

      while (!this.closed || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift() as T;
          continue;
        }
        await Promise.race([
          new Promise<void>((resolve) => {
            waker = resolve;
          }),
          this.closePromise,
        ]);
      }
    } finally {
      this.listeners.delete(listener);
    }
  }
}
