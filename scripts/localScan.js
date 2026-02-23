import { scanGmail } from "../src/lib/gmail.js";

const USER_ID = process.env.USER_ID || "local-test";
const PHASE = process.env.PHASE || "phase_a";

async function run() {
  const startedAt = performance.now();

  const result = await scanGmail({
    userId: USER_ID,
    phase: PHASE,
    debug: true,
  });

  const totalTime = (performance.now() - startedAt).toFixed(2);

  console.table({
    merchants: result?.merchants?.length ?? 0,
    subscriptions: result?.subscriptions?.length ?? 0,
    tookMs: Number(totalTime),
  });
}

run().catch(console.error);
