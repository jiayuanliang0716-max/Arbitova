'use strict';
/**
 * src/routes/burner.js
 *
 * POST /api/burner/fund  { address }
 *   Sends 0.00002 Sepolia ETH + 2 Sepolia USDC from a treasury wallet to the
 *   supplied address. Intended for /try-real — a zero-friction way to let
 *   visitors run a full Arbitova escrow flow without installing MetaMask,
 *   hunting for a faucet, or DMing us for gas.
 *
 * Amounts are deliberately tiny: Base Sepolia gas is fractions of a gwei, so
 * 0.00002 ETH covers ~20 full escrow flows and testnet faucets are stingy.
 *
 * Non-custodial invariant: the treasury wallet is Arbitova-owned, but once
 * funds are sent to the user's burner, the private key lives only in their
 * browser sessionStorage. We never see it, never hold anything of theirs.
 *
 * Env vars (endpoint no-ops with 503 if any required one is missing):
 *   BURNER_TREASURY_PRIVATE_KEY   — 0x-prefixed private key for the funding wallet
 *   BURNER_RPC_URL                — Base Sepolia RPC (falls back to BASE_RPC_URL)
 *   BURNER_USDC_ADDRESS           — defaults to Circle Sepolia USDC
 *   BURNER_ETH_AMOUNT             — wei string, defaults to 0.00002 ETH
 *   BURNER_USDC_AMOUNT            — uint string (6 decimals), defaults to 2 USDC = 2000000
 *   BURNER_DAILY_CAP              — global daily cap, defaults to 20
 *   BURNER_PER_IP_DAILY_CAP       — per-IP cap, defaults to 3
 */

const express = require('express');
const { ethers } = require('ethers');

const router = express.Router();

const DEFAULT_USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

const state = {
  day: null,          // YYYY-MM-DD bucket
  total: 0,           // funds issued today (global)
  perIp: new Map(),   // ip -> count today
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function rollover() {
  const d = today();
  if (state.day !== d) {
    state.day = d;
    state.total = 0;
    state.perIp.clear();
  }
}

function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'unknown';
}

function config() {
  return {
    pk:       process.env.BURNER_TREASURY_PRIVATE_KEY,
    rpcUrl:   process.env.BURNER_RPC_URL || process.env.BASE_RPC_URL,
    usdc:     process.env.BURNER_USDC_ADDRESS || DEFAULT_USDC_SEPOLIA,
    ethWei:   BigInt(process.env.BURNER_ETH_AMOUNT || '20000000000000'),    // 0.00002 ETH — plenty for Base Sepolia gas (~20 txs)
    usdcAmt:  BigInt(process.env.BURNER_USDC_AMOUNT || '2000000'),           // 2 USDC
    globalCap: parseInt(process.env.BURNER_DAILY_CAP || '20', 10),
    perIpCap:  parseInt(process.env.BURNER_PER_IP_DAILY_CAP || '3', 10),
  };
}

router.post('/fund', express.json(), async (req, res) => {
  const cfg = config();
  if (!cfg.pk || !cfg.rpcUrl) {
    return res.status(503).json({
      error: 'Burner faucet is not configured on this deployment.',
      code: 'burner_disabled',
    });
  }

  const address = String((req.body || {}).address || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid address', code: 'bad_request' });
  }

  rollover();
  const ip = clientIp(req);
  const ipCount = state.perIp.get(ip) || 0;

  if (state.total >= cfg.globalCap) {
    return res.status(429).json({
      error: `Daily cap of ${cfg.globalCap} reached. Comes back tomorrow UTC, or grab testnet USDC directly from https://faucet.circle.com.`,
      code: 'daily_cap_reached',
    });
  }
  if (ipCount >= cfg.perIpCap) {
    return res.status(429).json({
      error: `You've already been funded ${cfg.perIpCap} times today from this IP.`,
      code: 'ip_cap_reached',
    });
  }

  let provider, wallet;
  try {
    provider = new ethers.JsonRpcProvider(cfg.rpcUrl, 84532, { staticNetwork: true });
    wallet = new ethers.Wallet(cfg.pk, provider);
  } catch (err) {
    return res.status(503).json({ error: 'Treasury wallet init failed.', code: 'burner_init_failed' });
  }

  try {
    // ETH first — USDC transfer needs recipient to exist and we want them able to retry.
    const ethTx = await wallet.sendTransaction({ to: address, value: cfg.ethWei });
    // Don't wait for mining — return the hashes so the UI can show progress.
    const usdc = new ethers.Contract(cfg.usdc, USDC_ABI, wallet);
    const usdcTx = await usdc.transfer(address, cfg.usdcAmt);

    state.total += 1;
    state.perIp.set(ip, ipCount + 1);

    return res.json({
      ok: true,
      ethTxHash:  ethTx.hash,
      usdcTxHash: usdcTx.hash,
      funded: {
        eth:  ethers.formatEther(cfg.ethWei),
        usdc: Number(cfg.usdcAmt) / 1_000_000,
      },
      remaining: {
        globalToday: cfg.globalCap - state.total,
        ipToday:     cfg.perIpCap  - (ipCount + 1),
      },
    });
  } catch (err) {
    console.error('[burner] fund error:', err.message);
    return res.status(500).json({
      error: err.message,
      code: 'fund_failed',
    });
  }
});

router.get('/status', (_req, res) => {
  const cfg = config();
  rollover();
  res.json({
    enabled: Boolean(cfg.pk && cfg.rpcUrl),
    day: state.day,
    issuedToday: state.total,
    globalCap: cfg.globalCap,
    perIpCap: cfg.perIpCap,
    amounts: {
      eth:  ethers.formatEther(cfg.ethWei),
      usdc: Number(cfg.usdcAmt) / 1_000_000,
    },
  });
});

module.exports = router;
