// src/lib/slo.js
function clamp(n, a, b) {
    const x = Number(n);
    if (!Number.isFinite(x)) return a;
    return Math.max(a, Math.min(b, x));
  }
  
  export function enforceBudgets(options = {}) {
    const mode = String(options.mode || "quick");
  
    // Defaults (safe)
    const base = {
      daysBack: clamp(options.daysBack ?? 90, 7, 730),
      pageSize: clamp(options.pageSize ?? 500, 50, 500),
      maxPages: clamp(options.maxPages ?? 6, 1, 200),
      maxListIds: clamp(options.maxListIds ?? 800, 100, 25000),
      fullFetchCap: clamp(options.fullFetchCap ?? 12, 0, 120),
      maxCandidates: clamp(options.maxCandidates ?? 60, 10, 400),
      concurrency: clamp(options.concurrency ?? 6, 2, 10),
      chunkMs: clamp(options.chunkMs ?? 9000, 8000, 45000),
      includePromotions: Boolean(options.includePromotions ?? false),
      queryMode: options.queryMode ?? "transactions",
      clusterCap: clamp(options.clusterCap ?? 40, 10, 200),
      debug: Boolean(options.debug ?? false),
    };
  
    if (mode === "deep") {
      return {
        ...base,
        daysBack: clamp(options.daysBack ?? 730, 90, 3650),
        maxPages: clamp(options.maxPages ?? 60, 10, 400),
        maxListIds: clamp(options.maxListIds ?? 4000, 800, 25000),
        fullFetchCap: clamp(options.fullFetchCap ?? 40, 10, 120),
        maxCandidates: clamp(options.maxCandidates ?? 200, 50, 400),
        chunkMs: clamp(options.chunkMs ?? 15000, 9000, 45000),
        queryMode: options.queryMode ?? "broad",
        includePromotions: Boolean(options.includePromotions ?? true),
        clusterCap: clamp(options.clusterCap ?? 90, 20, 200),
        debug: false,
      };
    }
  
    // QUICK = hard SLA guardrails (this is your YC 60s promise)
    return {
      ...base,
      mode: "quick",
      daysBack: clamp(options.daysBack ?? 90, 7, 120),
      maxPages: clamp(options.maxPages ?? 6, 1, 8),
      maxListIds: clamp(options.maxListIds ?? 800, 200, 1200),
      fullFetchCap: clamp(options.fullFetchCap ?? 12, 0, 20),
      maxCandidates: clamp(options.maxCandidates ?? 60, 10, 80),
      chunkMs: clamp(options.chunkMs ?? 9000, 8000, 12000),
      includePromotions: false,
      queryMode: "transactions",
      debug: false,
    };
  }
  