// src/worker/entry.js
import "dotenv/config";
import "./worker/scanWorker.bullmq.js"; // your BullMQ worker file only
console.log("Worker online");
