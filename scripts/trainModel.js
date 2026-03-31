/**
 * scripts/trainModel.js
 *
 * Retrains the subscription confidence model using labeled feedback data
 * from the database. Run after collecting enough user feedback (≥ 10 rows).
 *
 * Usage:
 *   node scripts/trainModel.js
 *   node scripts/trainModel.js --epochs=1000 --lr=0.05
 */

import "dotenv/config";
import { pool } from "../src/db/index.js";
import { trainModel, saveWeights } from "../src/services/subscriptionModel.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const epochs = args.epochs ? Number(args.epochs) : 500;
const lr     = args.lr     ? Number(args.lr)     : 0.1;

async function main() {
  console.log("Loading feedback data from database…");

  const { rows } = await pool.query(
    `SELECT features, label FROM subscription_feedback ORDER BY created_at`
  );

  if (rows.length === 0) {
    console.error("No feedback rows found. Collect user feedback first via POST /subscriptions/:id/feedback.");
    process.exit(1);
  }

  console.log(`Found ${rows.length} labeled samples (epochs=${epochs}, lr=${lr})`);

  const dataset = rows.map(({ features, label }) => ({
    features: [
      features.occ_norm       ?? 0,
      features.interval_score ?? 0,
      features.amount_score   ?? 0,
      features.intent_score   ?? 0,
      features.known_brand    ?? 0,
    ],
    label: label === "confirmed" ? 1 : 0,
  }));

  const confirmed = dataset.filter((d) => d.label === 1).length;
  const rejected  = dataset.length - confirmed;
  console.log(`  confirmed: ${confirmed}  rejected: ${rejected}`);

  const result = trainModel(dataset, { epochs, lr });

  console.log(`Training complete — loss: ${result.loss.toFixed(4)}`);
  console.log(`Weights: ${result.weights.map((w) => w.toFixed(4)).join(", ")}`);
  console.log(`Bias:    ${result.bias.toFixed(4)}`);

  saveWeights(result);
  console.log("Saved to model/weights.json ✓");

  await pool.end();
}

main().catch((err) => {
  console.error("Training failed:", err.message);
  process.exit(1);
});
