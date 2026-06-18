/**
 * Retries an async function with exponential backoff.
 *
 * @param {() => Promise<T>} fn
 * @param {{
 *   maxAttempts?: number,    // default 3
 *   baseDelayMs?: number,    // default 500; doubles each attempt
 *   retryOn?: (err: Error) => boolean  // if provided, only retry when true
 * }} opts
 * @returns {Promise<T>}
 */
export async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 500, retryOn } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (retryOn && !retryOn(err)) throw err;
      if (attempt === maxAttempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1); // 500 → 1000 → 2000 ms
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw lastErr;
}

/**
 * Per-scan circuit breaker with half-open recovery.
 *
 * States:
 *   CLOSED   – normal operation, requests pass through
 *   OPEN     – threshold reached, all requests rejected
 *   HALF_OPEN – cooldown elapsed, one test request allowed through
 *
 * After cooldown (default 60s), the breaker enters half-open state.
 * If the next call succeeds → CLOSED. If it fails → OPEN (timer resets).
 */
export class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 60_000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this._openedAt = null;
  }

  get isOpen() {
    if (this.failures < this.threshold) return false;
    // Check if cooldown has elapsed → transition to half-open
    if (this._openedAt && Date.now() - this._openedAt >= this.cooldownMs) {
      return false; // half-open: allow one test request
    }
    return true;
  }

  get isHalfOpen() {
    return (
      this.failures >= this.threshold &&
      this._openedAt != null &&
      Date.now() - this._openedAt >= this.cooldownMs
    );
  }

  /** Call before making a request. Throws `circuit_open` if breaker is open. */
  check() {
    if (this.isOpen) {
      const err = new Error("circuit_open");
      throw err;
    }
  }

  /** Call after a successful API response. */
  success() {
    this.failures = 0;
    this._openedAt = null;
  }

  /**
   * Call after a transient failure (429, 503, network error).
   * Throws `circuit_open` if the threshold is reached.
   */
  failure(err) {
    this.failures++;
    if (this.failures >= this.threshold) {
      this._openedAt = Date.now();
      const open = new Error("circuit_open");
      open.cause = err;
      throw open;
    }
  }

  /** Returns true if this error should count as a circuit-breaking failure. */
  static isTransient(err) {
    const msg = err?.message ?? "";
    return (
      msg.includes("429") ||
      msg.includes("503") ||
      msg.includes("502") ||
      msg.includes("ECONNRESET") ||
      msg.includes("ETIMEDOUT")
    );
  }
}
