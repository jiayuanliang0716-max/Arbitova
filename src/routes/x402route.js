'use strict';

/**
 * x402 Payment Protocol Integration
 *
 * Exposes Arbitova services behind x402 micropayments.
 * Any x402-compatible agent can call these endpoints without pre-registration.
 *
 * Endpoints:
 *   GET  /api/v1/x402/services  — search services (costs $0.001 USDC)
 *   POST /api/v1/x402/topup     — add $1 USDC to authenticated agent balance
 *   GET  /api/v1/x402/info      — public info about x402 integration (free)
 */

const express = require('express');
const { paymentMiddleware } = require('x402-express');
const { dbGet, dbAll } = require('../db/helpers');
const { isChainMode, USDC_ADDRESS, CHAIN } = require('../wallet');
const crypto = require('crypto');
const { ethers } = require('ethers');

const router = express.Router();

// ── Derive deterministic platform wallet from WALLET_ENCRYPTION_KEY ──────────
function getPlatformWalletAddress() {
  const seed = process.env.WALLET_ENCRYPTION_KEY || 'default-seed';
  const hash = crypto.createHash('sha256').update('arbitova-platform-' + seed).digest('hex');
  const wallet = new ethers.Wallet('0x' + hash);
  return wallet.address;
}

const PLATFORM_ADDRESS = getPlatformWalletAddress();
const NETWORK = (CHAIN === 'base') ? 'base' : 'base-sepolia';

// ── x402 middleware — only active in chain mode ───────────────────────────────
let x402Middleware = null;
if (isChainMode()) {
  try {
    x402Middleware = paymentMiddleware(
      PLATFORM_ADDRESS,
      {
        '/services': {
          price: '$0.001',
          network: NETWORK,
          config: { description: 'Search Arbitova service marketplace' },
        },
        '/topup': {
          price: '$1.00',
          network: NETWORK,
          config: { description: 'Add 1.00 USDC to your Arbitova balance' },
        },
      }
    );
  } catch (e) {
    console.warn('[x402] middleware init failed:', e.message);
  }
}

function useX402(req, res, next) {
  if (x402Middleware) return x402Middleware(req, res, next);
  next(); // mock mode: skip payment check
}

// ── GET /api/v1/x402/info — free, no payment required ────────────────────────
router.get('/info', (req, res) => {
  res.json({
    protocol: 'x402',
    version: '1.0',
    network: NETWORK,
    payTo: PLATFORM_ADDRESS,
    usdcAddress: USDC_ADDRESS,
    endpoints: [
      {
        path: '/api/v1/x402/services',
        method: 'GET',
        price: '$0.001 USDC',
        description: 'Search Arbitova service marketplace',
      },
      {
        path: '/api/v1/x402/topup',
        method: 'POST',
        price: '$1.00 USDC',
        description: 'Top up your Arbitova balance by 1.00 USDC',
        auth: 'X-API-Key header required to identify your agent',
      },
    ],
    integration: {
      sdk: 'npm install @arbitova/sdk',
      docs: 'https://api.arbitova.com/docs',
      agentCard: 'https://api.arbitova.com/.well-known/agent.json',
    },
  });
});

// ── GET /api/v1/x402/services — costs $0.001 USDC via x402 ───────────────────
router.get('/services', useX402, async (req, res) => {
  try {
    const isPostgres = !!process.env.DATABASE_URL;
    const p = (n) => isPostgres ? `$${n}` : '?';
    const { q, category, max_price } = req.query;

    let where = 'WHERE s.is_active = true';
    const params = [];
    let idx = 1;
    if (q) { where += ` AND (s.name ILIKE ${p(idx)} OR s.description ILIKE ${p(idx)})`; params.push(`%${q}%`); idx++; }
    if (category) { where += ` AND s.category = ${p(idx++)}`; params.push(category); }
    if (max_price) { where += ` AND s.price <= ${p(idx++)}`; params.push(parseFloat(max_price)); }

    const services = await dbAll(
      `SELECT s.id, s.name, s.description, s.price, s.category, s.delivery_hours, s.auto_verify, a.reputation_score
       FROM services s JOIN agents a ON a.id = s.agent_id ${where} ORDER BY a.reputation_score DESC LIMIT 20`,
      params
    );

    res.json({
      services,
      paid_via: 'x402',
      note: 'You paid $0.001 USDC to access this marketplace data.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/v1/x402/topup — costs $1.00 USDC via x402 ─────────────────────
// Requires X-API-Key to identify the agent to credit
router.post('/topup', useX402, async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'X-API-Key required to identify your Arbitova agent' });

    const isPostgres = !!process.env.DATABASE_URL;
    const p = (n) => isPostgres ? `$${n}` : '?';

    const agent = await dbGet(
      isPostgres ? 'SELECT id, balance FROM agents WHERE api_key = $1' : 'SELECT id, balance FROM agents WHERE api_key = ?',
      [apiKey]
    );
    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    const topupAmount = 1.00;
    await require('../db/helpers').dbRun(
      isPostgres
        ? 'UPDATE agents SET balance = balance + $1 WHERE id = $2'
        : 'UPDATE agents SET balance = balance + ? WHERE id = ?',
      [topupAmount, agent.id]
    );

    res.json({
      success: true,
      agent_id: agent.id,
      credited: topupAmount,
      new_balance: parseFloat(agent.balance) + topupAmount,
      paid_via: 'x402',
      note: 'You paid $1.00 USDC via x402. 1.00 USDC credited to your Arbitova balance.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, PLATFORM_ADDRESS };
