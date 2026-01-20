// src/start.js
import "dotenv/config";
import { startOtel } from "./telemetry/otel.js";
import { buildServer } from "./server.js";

await startOtel().catch(() => {});

const server = await buildServer();
await server.listen({ port: Number(process.env.PORT || 8787), host: "0.0.0.0" });
