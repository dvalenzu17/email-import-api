import pkg from "pg";
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 50,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  // Prevent runaway queries from holding connections indefinitely.
  statement_timeout: 60000,                   // 60s per query
  idle_in_transaction_session_timeout: 120000, // 2 min — catches leaked transactions
  application_name: "email-import-api",
});
