// Shared detection thresholds — single source of truth across scan routes and engine.
// TASK 5: CONFIDENCE_THRESHOLD now comes from detectionConstants.js.
// This re-export keeps existing imports (imapScanRoutes.js, subscriptionEngine.js) working.
import { DETECTION } from "./config/detectionConstants.js";

export { DETECTION };
export const CONFIDENCE_THRESHOLD = DETECTION.CONFIDENCE_THRESHOLD;
