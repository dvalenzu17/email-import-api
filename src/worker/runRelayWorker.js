
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { processRelayOutbox } from "./relayWorker.js";

const limit = Number(process.env.RELAY_LIMIT || 10);

processRelayOutbox({ supabase: supabaseAdmin, limit })
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
