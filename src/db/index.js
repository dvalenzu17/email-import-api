/**
 * Barrel re-export — all consumers import from "db/index.js" and continue to work.
 * Each domain module lives in its own file for maintainability.
 */

export { pool } from "./pool.js";

// OAuth tokens
export { saveOAuthTokens, getOAuthToken } from "./oauth.js";

// Subscriptions
export {
  batchUpsertSubscriptions,
  getActiveSubscriptionConfidences,
  updateSubscriptionStatus,
  getSubscriptionById,
  getSubscriptions,
  upsertCancelledSubscriptions,
  updateRenewalDateByAmountAndInterval,
  cancelSubscriptionByMerchant,
  applyTrialEnds,
} from "./subscriptions.js";

// Scan metadata
export { getUserScanCount, saveScanMetadata, getLatestScanMetadata } from "./scanMetadata.js";

// IMAP credentials
export { saveImapCredentials, getImapCredentials } from "./imapCredentials.js";

// Push tokens (Expo) — written by the mobile app, read here to send pushes
export { getPushTokensForUser } from "./pushTokens.js";

// Background scan scheduling (cron)
export { getUsersDueForScan } from "./scanScheduling.js";

// Time-based alerts (big-renewal heads-up, trial-ending) — cron-driven
export { getDueRenewalAlerts, getDueTrialAlerts, reserveAlert } from "./timeBasedAlerts.js";

// Gmail real-time push (users.watch + Pub/Sub)
export { upsertGmailWatch, getWatchByEmail, updateWatchHistoryId, getExpiringWatches } from "./gmailWatch.js";

// ML feedback + merchant confirmations
export { getFeedbackMerchantMap, saveFeedback, saveMerchantConfirmation } from "./feedback.js";

// Scan checkpoints (incremental scanning)
export { getScanCheckpoint, saveScanCheckpoint } from "./checkpoints.js";

// Admin
export { getAdminUsersData, aggregateMerchantConfirmations } from "./admin.js";

// GDPR data export
export { getUserDataExport } from "./export.js";
