import { describe, it, expect } from "vitest";
import { selectStaleCancellations } from "../src/services/cancellationUtil.js";

describe("selectStaleCancellations", () => {
  it("drops merchants seen active in the same scan (re-subscribe guard)", () => {
    const out = selectStaleCancellations(["Netflix", "Hulu"], new Set(["hulu"]));
    expect(out).toEqual([{ merchant: "Netflix", date: null }]);
  });

  it("matches active merchants case-insensitively", () => {
    const out = selectStaleCancellations(["Netflix"], new Set(["netflix"]));
    expect(out).toEqual([]);
  });

  it("normalizes { merchant, date } entries and preserves the date", () => {
    const d = new Date("2026-01-10T00:00:00Z");
    const out = selectStaleCancellations([{ merchant: "Netflix", date: d }], new Set());
    expect(out).toEqual([{ merchant: "Netflix", date: d }]);
  });

  it("accepts a mix of legacy strings and objects", () => {
    const d = new Date("2026-02-01T00:00:00Z");
    const out = selectStaleCancellations(["Disney+", { merchant: "Spotify", date: d }], new Set());
    expect(out).toEqual([
      { merchant: "Disney+", date: null },
      { merchant: "Spotify", date: d },
    ]);
  });

  it("drops entries with a missing merchant", () => {
    const out = selectStaleCancellations([{ date: new Date() }, "", "Netflix"], new Set());
    expect(out).toEqual([{ merchant: "Netflix", date: null }]);
  });
});
