// src/telemetry/bootstrap.js
import { startOtel } from "./otel.js";
await startOtel();

// now load the actual server entry
await import("../index.js");
