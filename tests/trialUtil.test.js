import { describe, it, expect } from "vitest";
import { selectTrialEnds } from "../src/services/trialUtil.js";

const now = new Date("2026-01-01T00:00:00Z").getTime();
const future = (days) => new Date(now + days * 86400000);

describe("selectTrialEnds", () => {
  it("keeps a future trial-end date", () => {
    const out = selectTrialEnds([{ merchant: "Netflix", trialEnd: future(5) }], now);
    expect(out).toEqual([{ merchant: "Netflix", trialEnd: future(5) }]);
  });

  it("drops past-dated signals", () => {
    const out = selectTrialEnds([{ merchant: "Netflix", trialEnd: future(-3) }], now);
    expect(out).toEqual([]);
  });

  it("keeps the EARLIEST future date per merchant (most imminent bill)", () => {
    const out = selectTrialEnds([
      { merchant: "Netflix", trialEnd: future(10) },
      { merchant: "netflix", trialEnd: future(4) },
      { merchant: "Netflix", trialEnd: future(7) },
    ], now);
    expect(out).toEqual([{ merchant: "Netflix", trialEnd: future(4) }]);
  });

  it("handles multiple merchants independently", () => {
    const out = selectTrialEnds([
      { merchant: "Netflix", trialEnd: future(5) },
      { merchant: "Disney+", trialEnd: future(9) },
    ], now);
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.merchant).sort()).toEqual(["Disney+", "Netflix"]);
  });

  it("accepts ISO string dates and ignores invalid/missing ones", () => {
    const out = selectTrialEnds([
      { merchant: "Netflix", trialEnd: new Date(now + 5 * 86400000).toISOString() },
      { merchant: "Bad", trialEnd: "not-a-date" },
      { trialEnd: future(3) }, // no merchant
    ], now);
    expect(out).toEqual([{ merchant: "Netflix", trialEnd: future(5) }]);
  });
});
