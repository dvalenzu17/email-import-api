// src/telemetry/metrics.js
import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry }); // process/mem/eventloop/etc.

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20],
  registers: [registry],
});

export const scanChunksTotal = new client.Counter({
  name: "scan_chunks_total",
  help: "Total scan chunks processed",
  labelNames: ["provider", "outcome"],
  registers: [registry],
});

export const scanEmailsProcessed = new client.Counter({
  name: "scan_emails_processed_total",
  help: "Emails processed by scans",
  labelNames: ["provider"],
  registers: [registry],
});

export const scanCandidatesFound = new client.Counter({
  name: "scan_candidates_found_total",
  help: "Candidates found",
  labelNames: ["provider"],
  registers: [registry],
});

export async function metricsHandler(req, reply) {
  reply.header("Content-Type", registry.contentType);
  return reply.send(await registry.metrics());
}
