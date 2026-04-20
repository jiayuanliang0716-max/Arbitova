#!/usr/bin/env node
'use strict';
/**
 * src/path_b/run.js
 *
 * Single entrypoint that starts the Path B off-chain infrastructure in one process:
 *   - Indexer: polls EscrowV1 events → DB
 *   - Worker:  auto-escalates expired DELIVERED escrows
 *
 * Notifications and arbitration are triggered asynchronously by the indexer
 * and do NOT need a separate top-level loop.
 *
 * IMPORTANT: This is NOT mounted in the Path A Express app (src/server.js).
 * It is designed to run as a SEPARATE Render service, e.g.:
 *
 *   # render.yaml service entry (add alongside existing web service)
 *   - type: worker
 *     name: arbitova-path-b
 *     env: node
 *     buildCommand: npm install
 *     startCommand: node src/path_b/run.js
 *     envVars:
 *       - key: DATABASE_URL
 *         fromDatabase: ...
 *       - key: BASE_RPC_URL
 *         value: ...
 *       - key: ESCROW_V1_ADDRESS
 *         value: ...
 *       - key: CHAIN_ID
 *         value: "8453"
 *       - key: START_BLOCK
 *         value: "..."
 *       - key: PATH_B_SIGNER_KEY
 *         sync: false
 *       - key: PATH_B_ARBITER_KEY
 *         sync: false
 *       - key: ANTHROPIC_API_KEY
 *         sync: false
 *       - key: BREVO_SMTP_KEY
 *         sync: false
 *       - key: BREVO_SMTP_NAME
 *         sync: false
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { runIndexer, stopIndexer } = require('./indexer');
const { runWorker, stopWorker } = require('./worker');

console.log('[run] Starting Arbitova Path B off-chain infrastructure');

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[run] Graceful shutdown initiated');
  stopIndexer();
  stopWorker();
  setTimeout(() => process.exit(0), 3_000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[run] uncaughtException:', err);
  shutdown();
});

// Start both services — they manage their own loops
Promise.all([
  runIndexer().catch((err) => {
    console.error('[run] indexer crashed:', err.message);
    shutdown();
  }),
  runWorker().catch((err) => {
    console.error('[run] worker crashed:', err.message);
    shutdown();
  }),
]).catch((err) => {
  console.error('[run] fatal:', err);
  process.exit(1);
});
