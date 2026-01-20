// src/plugins/observability.js
import fp from "fastify-plugin";
import { httpRequestsTotal, httpRequestDuration } from "../telemetry/metrics.js";

export default fp(async function observability(server) {
  server.addHook("onRequest", async (req) => {
    req.startAt = process.hrtime.bigint();
  });

  server.addHook("onResponse", async (req, reply) => {
    const endAt = process.hrtime.bigint();
    const durSec = Number(endAt - req.startAt) / 1e9;

    const route = req.routeOptions?.url || req.routerPath || req.url.split("?")[0] || "unknown";
    const status = String(reply.statusCode);

    httpRequestsTotal.inc({ method: req.method, route, status }, 1);
    httpRequestDuration.observe({ method: req.method, route, status }, durSec);

    req.log.info(
      { reqId: req.id, route, statusCode: reply.statusCode, durationMs: Math.round(durSec * 1000), userId: req.userId || null },
      "http_request"
    );
  });

  server.setErrorHandler((err, req, reply) => {
    req.log.error(
      { reqId: req.id, route: req.routeOptions?.url || req.url, userId: req.userId || null, err: { message: err.message, code: err.code, stack: err.stack } },
      "unhandled_error"
    );

    const debug = process.env.DEBUG_ERRORS === "true";
    const status = Number(err.statusCode || 500);

    // If you threw something with a statusCode, keep it.
    reply.code(status).send(
      debug
        ? { error: "internal_error", message: err.message, code: err.code || null }
        : { error: "internal_error" }
    );
  });
});
