/**
 * A counting semaphore so the Telegram bot and the web conversion API can share
 * one "how many videos do we encode at once" rule.
 */

import { CancelledError } from "./ffmpeg.js";

export class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get isFull() {
    return this.active >= this.limit;
  }

  get running() {
    return this.active;
  }

  get queued() {
    return this.waiting.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    const release = () => {
      this.active = Math.max(0, this.active - 1);
      this.waiting.shift()?.();
    };
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active++;
        resolve(release);
      };
      const onAbort = () => {
        this.waiting = this.waiting.filter((fn) => fn !== start);
        reject(new CancelledError());
      };
      if (signal) {
        if (signal.aborted) return reject(new CancelledError());
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiting.push(start);
    });
  }
}
