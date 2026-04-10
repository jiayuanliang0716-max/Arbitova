/**
 * wallet.js — Native Base chain wallet operations
 *
 * Chain mode: ALCHEMY_API_KEY + WALLET_ENCRYPTION_KEY both set
 * Mock mode:  fallback to DB-only fake balances (current behaviour)
 */

const { ethers } = require('ethers');
const crypto = require('crypto');

const CHAIN = process.env.CHAIN || 'base-sepolia'; // 'base' for mainnet

const USDC = {
  'base':         '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
};

const RPC = {
  'base':         `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
  'base-sepolia': `https://base-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
};

const USDC_ADDRESS = USDC[CHAIN] || USDC['base-sepolia'];
const USDC_DECIMALS = 6;
const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
];

// ── Encryption ──────────────────────────────────────────────────────────────

function getEncryptionKey() {
  const k = process.env.WALLET_ENCRYPTION_KEY || '';
  if (k.length < 32) throw new Error('WALLET_ENCRYPTION_KEY must be at least 32 chars');
  return Buffer.from(k.slice(0, 32), 'utf8');
}

function encryptPrivateKey(privateKey) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptPrivateKey(data) {
  const key = getEncryptionKey();
  const [ivHex, tagHex, encHex] = data.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex')).toString('utf8') + decipher.final('utf8');
}

// ── Wallet generation ────────────────────────────────────────────────────────

function generateWallet() {
  const w = ethers.Wallet.createRandom();
  return {
    address: w.address,
    encryptedKey: encryptPrivateKey(w.privateKey)
  };
}

// ── Chain reads ──────────────────────────────────────────────────────────────

function getProvider() {
  const url = RPC[CHAIN];
  if (!url || !process.env.ALCHEMY_API_KEY) throw new Error('ALCHEMY_API_KEY not configured');
  return new ethers.JsonRpcProvider(url);
}

async function getUsdcBalance(address) {
  const provider = getProvider();
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
  const raw = await usdc.balanceOf(address);
  return parseFloat(ethers.formatUnits(raw, USDC_DECIMALS));
}

// ── Transfer ─────────────────────────────────────────────────────────────────

async function transferUsdc(encryptedPrivateKey, toAddress, amount) {
  const provider = getProvider();
  const signer = new ethers.Wallet(decryptPrivateKey(encryptedPrivateKey), provider);
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
  const raw = ethers.parseUnits(amount.toFixed(6), USDC_DECIMALS);
  const tx = await usdc.transfer(toAddress, raw);
  const receipt = await tx.wait(1);
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

// ── Mode check ───────────────────────────────────────────────────────────────

const isChainMode = () =>
  !!(process.env.ALCHEMY_API_KEY && process.env.WALLET_ENCRYPTION_KEY);

module.exports = {
  generateWallet,
  encryptPrivateKey,
  decryptPrivateKey,
  getUsdcBalance,
  transferUsdc,
  isChainMode,
  USDC_ADDRESS,
  CHAIN
};
