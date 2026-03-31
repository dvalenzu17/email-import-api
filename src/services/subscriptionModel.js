/**
 * Logistic regression model for subscription confidence scoring.
 *
 * Replaces the hand-tuned additive heuristic in subscriptionEngine.js with a
 * trainable model. Default weights in model/weights.json are bootstrapped to
 * match the previous heuristic thresholds; retraining with real feedback data
 * will improve accuracy over time.
 *
 * Usage:
 *   import { predictConfidence } from './subscriptionModel.js';
 *   const raw = predictConfidence(features);           // 0–1 raw score
 *   const final = raw * recencyDecay;                  // apply staleness decay
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEIGHTS_PATH = resolve(__dirname, "../../model/weights.json");

let _model = null;

function loadModel() {
  if (_model) return _model;
  try {
    const raw = readFileSync(WEIGHTS_PATH, "utf8");
    _model = JSON.parse(raw);
  } catch {
    // Fallback to hardcoded defaults if weights file is missing.
    _model = { weights: [1.5, 1.2, 1.0, 0.4, 0.8], bias: -2.5, version: 0 };
  }
  return _model;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Predicts raw subscription confidence from a feature vector.
 * Multiply the result by recencyDecay to get the final confidence score.
 *
 * @param {number[]} features — [occ_norm, interval_score, amount_score, intent_score, known_brand]
 * @returns {number} — probability in [0, 1]
 */
export function predictConfidence(features) {
  const { weights, bias } = loadModel();
  const z = features.reduce((sum, f, i) => sum + f * (weights[i] ?? 0), bias);
  return sigmoid(z);
}

/**
 * Trains a new logistic regression model from labeled feedback data using
 * mini-batch gradient descent. Saves updated weights to model/weights.json.
 *
 * @param {Array<{ features: number[], label: number }>} dataset
 *   label: 1 = confirmed (subscription), 0 = rejected (false positive)
 * @param {{ epochs?: number, lr?: number }} opts
 * @returns {{ weights: number[], bias: number, loss: number }}
 */
export function trainModel(dataset, { epochs = 500, lr = 0.1 } = {}) {
  if (dataset.length < 10) {
    throw new Error("Insufficient training data — need at least 10 labeled samples.");
  }

  const { weights: initW, bias: initB } = loadModel();
  let weights = [...initW];
  let bias = initB;

  for (let epoch = 0; epoch < epochs; epoch++) {
    let dW = new Array(weights.length).fill(0);
    let dB = 0;

    for (const { features, label } of dataset) {
      const z = features.reduce((s, f, i) => s + f * weights[i], bias);
      const pred = sigmoid(z);
      const err = pred - label;

      for (let i = 0; i < weights.length; i++) {
        dW[i] += err * features[i];
      }
      dB += err;
    }

    const n = dataset.length;
    for (let i = 0; i < weights.length; i++) {
      weights[i] -= (lr / n) * dW[i];
    }
    bias -= (lr / n) * dB;
  }

  // Compute final log-loss.
  const loss = dataset.reduce((sum, { features, label }) => {
    const z = features.reduce((s, f, i) => s + f * weights[i], bias);
    const p = Math.min(Math.max(sigmoid(z), 1e-9), 1 - 1e-9);
    return sum - (label * Math.log(p) + (1 - label) * Math.log(1 - p));
  }, 0) / dataset.length;

  const updated = { version: (loadModel().version ?? 0) + 1, weights, bias };
  _model = updated; // update in-memory cache

  return { ...updated, loss };
}

/**
 * Persists updated model weights to disk (called by scripts/trainModel.js).
 */
export function saveWeights(model) {
  const out = { ...model, description: _model?.description ?? "" };
  writeFileSync(WEIGHTS_PATH, JSON.stringify(out, null, 2));
}
