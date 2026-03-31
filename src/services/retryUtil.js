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
 * Per-scan circuit breaker. Tracks consecutive API failures within a scan run.
 * If failures reach the threshold, throws to abort the scan rather than
 * hammering a rate-limited or degraded API.
 */
export class CircuitBreaker {
  constructor({ threshold = 3 } = {}) {
    this.failures = 0;
    this.threshold = threshold;
  }

  /** Call after a successful API response. */
  success() {
    this.failures = 0;
  }

  /**
   * Call after a transient failure (429, 503, network error).
   * Throws `circuit_open` if the threshold is reached.
   */
  failure(err) {
    this.failures++;
    if (this.failures >= this.threshold) {
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
