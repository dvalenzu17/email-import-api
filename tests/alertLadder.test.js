import { describe, it, expect } from "vitest";
import { rungFromDays, LADDER_RUNGS, LADDER_MAX_DAYS } from "../src/services/alertLadder.js";

describe("rungFromDays", () => {
  it("maps 2 days out to the '2day' rung", () => {
    expect(rungFromDays(2)).toMatchObject({ key: "2day", lead: "in 2 days" });
  });

  it("maps 1 day out to 'tomorrow'", () => {
    expect(rungFromDays(1)).toMatchObject({ key: "1day", lead: "tomorrow" });
  });

  it("maps day-of (0) to 'today'", () => {
    expect(rungFromDays(0)).toMatchObject({ key: "day_of", lead: "today" });
  });

  it("returns null outside the ladder window (>2 days, or past)", () => {
    expect(rungFromDays(3)).toBeNull();
    expect(rungFromDays(-1)).toBeNull();
  });

  it("returns null for non-integer / bad input", () => {
    expect(rungFromDays(1.5)).toBeNull();
    expect(rungFromDays(NaN)).toBeNull();
    expect(rungFromDays(undefined)).toBeNull();
  });

  it("each day in the window maps to a distinct rung (no duplicate fires)", () => {
    const keys = [0, 1, 2].map((d) => rungFromDays(d).key);
    expect(new Set(keys).size).toBe(3);
  });

  it("LADDER_MAX_DAYS covers the widest rung", () => {
    expect(LADDER_MAX_DAYS).toBe(Math.max(...LADDER_RUNGS.map((r) => r.days)));
  });
});
