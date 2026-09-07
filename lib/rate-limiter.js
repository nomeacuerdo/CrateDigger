// Resolves after the given number of milliseconds.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sliding-window rate limiter enforcing a max number of requests per time window.
export class RateLimiter {
  // Stores the request budget, window size and an optional onWait callback.
  constructor({ maxRequests, windowMs, onWait }) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.onWait = onWait ?? (() => {});
    this.timestamps = [];
    this.totalRequests = 0;
  }

  // Waits until a slot frees up in the current window, then records the request.
  async acquire() {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        this.totalRequests++;
        return;
      }
      const oldest = this.timestamps[0];
      const waitMs = oldest + this.windowMs - now;
      await this.countdown(Math.max(1, Math.ceil(waitMs / 1000)));
    }
  }

  // Waits a fixed number of seconds (used for 429 retry-after delays).
  async block(seconds) {
    await this.countdown(Math.max(1, Math.ceil(seconds)));
  }

  // Sleeps while invoking onWait once per second with the remaining seconds.
  async countdown(totalSeconds) {
    const start = Date.now();
    for (;;) {
      const elapsed = Date.now() - start;
      if (elapsed >= totalSeconds * 1000) break;
      const remaining = Math.max(1, Math.ceil((totalSeconds * 1000 - elapsed) / 1000));
      this.onWait(remaining);
      await sleep(1000);
    }
  }
}