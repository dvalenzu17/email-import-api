// src/plugins/observability.js
import fp from "fastify-plugin";
import { httpRequestsTotal, httpRequestDuration } from "../telemetry/metrics.js";

export default fp(async function observability(server) {
  // add a stable request id if one isn't present
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

    // structured log
    req.log.info({
      reqId: req.id,
      route,
      statusCode: reply.statusCode,
      durationMs: Math.round(durSec * 1000),
      userId: req.userId || null,
    }, "http_request");
  });

  server.setErrorHandler((err, req, reply) => {
    req.log.error({
      reqId: req.id,
      route: req.routeOptions?.url || req.url,
      userId: req.userId || null,
      err: { message: err.message, stack: err.stack },
    }, "unhandled_error");
    reply.code(500).send({ error: "internal_error" });
  });
});
