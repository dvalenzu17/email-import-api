import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const scanEmailsProcessed = new client.Counter({
  name: "scan_emails_processed_total",
  help: "Total emails processed",
  labelNames: ["provider"],
  registers: [registry],
});

export const scanMatchesFound = new client.Counter({
  name: "scan_matches_found_total",
  help: "Total matches found",
  labelNames: ["provider"],
  registers: [registry],
});

export const scanChunkDuration = new client.Histogram({
  name: "scan_chunk_duration_seconds",
  help: "Duration of one scan chunk",
  buckets: [0.25, 0.5, 1, 2, 5, 10, 20, 40],
  registers: [registry],
});

export async function metricsHandler(req, reply) {
  reply.header("Content-Type", registry.contentType);
  return reply.send(await registry.metrics());
}
