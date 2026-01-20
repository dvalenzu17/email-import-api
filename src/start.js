// src/start.js
import "dotenv/config";
import { startOtel } from "./telemetry/otel.js";
import { buildServer } from "./server.js";

await startOtel().catch(() => {});

const server = await buildServer();

// ✅ start worker in same process (cheap mode)
if (process.env.RUN_WORKER_IN_WEB === "true") {
    await import("./worker/scanWorker.js");
    server.log.info("BullMQ worker started in web process");
}

await server.listen({ port: Number(process.env.PORT || 8787), host: "0.0.0.0" });
