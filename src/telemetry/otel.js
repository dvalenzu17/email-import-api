// src/telemetry/otel.js
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export async function startOtel() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  await sdk.start();

  process.on("SIGTERM", async () => {
    try { await sdk.shutdown(); } finally { process.exit(0); }
  });
}
