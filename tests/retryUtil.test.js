import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, CircuitBreaker } from "../src/services/retryUtil.js";

// ── withRetry ────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to maxAttempts and then throws", async () => {
    vi.useRealTimers();
    const err = new Error("fail");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("succeeds after transient failures", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("recovered");

    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });

    // Advance timer enough for retries
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }

    const result = await promise;
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry when retryOn returns false", async () => {
    const err = new Error("non-retryable");
    const fn = vi.fn().mockRejectedValue(err);
    const retryOn = vi.fn().mockReturnValue(false);

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, retryOn })
    ).rejects.toThrow("non-retryable");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(retryOn).toHaveBeenCalledWith(err);
  });

  it("retries when retryOn returns true", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("retryable"))
      .mockResolvedValue("ok");
    const retryOn = vi.fn().mockReturnValue(true);

    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, retryOn });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ── CircuitBreaker ───────────────────────────────────────────────────────────

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in closed state", () => {
    const cb = new CircuitBreaker({ threshold: 3 });
    expect(cb.isOpen).toBe(false);
    expect(cb.isHalfOpen).toBe(false);
    expect(cb.failures).toBe(0);
  });

  it("stays closed below the failure threshold", () => {
    const cb = new CircuitBreaker({ threshold: 3 });
    cb.failure(new Error("err1"));
    cb.failure(new Error("err2"));
    expect(cb.isOpen).toBe(false);
    expect(cb.failures).toBe(2);
  });

  it("opens after reaching the failure threshold", () => {
    const cb = new CircuitBreaker({ threshold: 3 });
    cb.failure(new Error("e1"));
    cb.failure(new Error("e2"));
    expect(() => cb.failure(new Error("e3"))).toThrow("circuit_open");
    expect(cb.isOpen).toBe(true);
    expect(cb.failures).toBe(3);
  });

  it("check() throws when circuit is open", () => {
    const cb = new CircuitBreaker({ threshold: 2 });
    cb.failure(new Error("e1"));
    expect(() => cb.failure(new Error("e2"))).toThrow("circuit_open");
    expect(() => cb.check()).toThrow("circuit_open");
  });

  it("transitions to half-open after cooldown elapses", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    cb.failure(new Error("e1"));
    expect(() => cb.failure(new Error("e2"))).toThrow("circuit_open");

    // Before cooldown
    expect(cb.isOpen).toBe(true);
    expect(cb.isHalfOpen).toBe(false);

    // After cooldown
    vi.advanceTimersByTime(1001);
    expect(cb.isOpen).toBe(false);
    expect(cb.isHalfOpen).toBe(true);
    // check() should NOT throw in half-open — one test request allowed
    expect(() => cb.check()).not.toThrow();
  });

  it("resets to closed on success after half-open", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 500 });
    cb.failure(new Error("e1"));
    expect(() => cb.failure(new Error("e2"))).toThrow("circuit_open");

    vi.advanceTimersByTime(600);
    expect(cb.isHalfOpen).toBe(true);

    cb.success();
    expect(cb.failures).toBe(0);
    expect(cb.isOpen).toBe(false);
    expect(cb.isHalfOpen).toBe(false);
  });

  it("re-opens on failure during half-open state", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 500 });
    cb.failure(new Error("e1"));
    expect(() => cb.failure(new Error("e2"))).toThrow("circuit_open");

    vi.advanceTimersByTime(600);
    expect(cb.isHalfOpen).toBe(true);

    // The breaker should re-trip immediately in half-open because
    // failures is already >= threshold. Adding another failure pushes
    // failures to 3 which is still >= threshold, so it re-opens.
    expect(() => cb.failure(new Error("e3"))).toThrow("circuit_open");
    expect(cb.isOpen).toBe(true);
  });

  it("success() resets failure count to zero", () => {
    const cb = new CircuitBreaker({ threshold: 5 });
    cb.failure(new Error("e1"));
    cb.failure(new Error("e2"));
    expect(cb.failures).toBe(2);
    cb.success();
    expect(cb.failures).toBe(0);
  });

  it("failure() throws with cause referencing the original error", () => {
    const cb = new CircuitBreaker({ threshold: 1 });
    const original = new Error("root cause");
    try {
      cb.failure(original);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e.message).toBe("circuit_open");
      expect(e.cause).toBe(original);
    }
  });
});

// ── CircuitBreaker.isTransient ───────────────────────────────────────────────

describe("CircuitBreaker.isTransient", () => {
  it("detects 429 rate limit errors", () => {
    expect(CircuitBreaker.isTransient(new Error("429 Too Many Requests"))).toBe(true);
  });

  it("detects 503 service unavailable", () => {
    expect(CircuitBreaker.isTransient(new Error("503 Service Unavailable"))).toBe(true);
  });

  it("detects 502 bad gateway", () => {
    expect(CircuitBreaker.isTransient(new Error("502 Bad Gateway"))).toBe(true);
  });

  it("detects ECONNRESET", () => {
    expect(CircuitBreaker.isTransient(new Error("ECONNRESET"))).toBe(true);
  });

  it("detects ETIMEDOUT", () => {
    expect(CircuitBreaker.isTransient(new Error("ETIMEDOUT"))).toBe(true);
  });

  it("returns false for non-transient errors", () => {
    expect(CircuitBreaker.isTransient(new Error("404 Not Found"))).toBe(false);
    expect(CircuitBreaker.isTransient(new Error("Invalid credentials"))).toBe(false);
  });

  it("returns false for null/undefined error", () => {
    expect(CircuitBreaker.isTransient(null)).toBe(false);
    expect(CircuitBreaker.isTransient(undefined)).toBe(false);
  });

  it("returns false for error with no message", () => {
    expect(CircuitBreaker.isTransient({})).toBe(false);
  });
});
