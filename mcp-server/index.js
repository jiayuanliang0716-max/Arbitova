#!/usr/bin/env node
'use strict';

/**
 * Arbitova MCP Server — Path B (on-chain, non-custodial)
 *
 * Exposes the six EscrowV1 entrypoints as MCP tools for Claude Desktop,
 * Claude Code, and any MCP-compatible agent framework. Your agent's
 * private key never leaves this process. Arbitova is not a custodian.
 *
 * Setup in claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "arbitova": {
 *       "command": "npx",
 *       "args": ["-y", "@arbitova/mcp-server"],
 *       "env": {
 *         "ARBITOVA_RPC_URL": "https://sepolia.base.org",
 *         "ARBITOVA_ESCROW_ADDRESS": "0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC",
 *         "ARBITOVA_USDC_ADDRESS": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
 *         "ARBITOVA_AGENT_PRIVATE_KEY": "0x..."
 *       }
 *     }
 *   }
 * }
 *
 * Read-only mode (no private key): get_escrow still works; write tools
 * return a clear error telling you how to enable signing.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// ── Env + config ─────────────────────────────────────────────────────────────

const RPC_URL         = process.env.ARBITOVA_RPC_URL;
const ESCROW_ADDRESS  = process.env.ARBITOVA_ESCROW_ADDRESS;
const USDC_ADDRESS    = process.env.ARBITOVA_USDC_ADDRESS;
const PRIVATE_KEY     = process.env.ARBITOVA_AGENT_PRIVATE_KEY;

if (!RPC_URL) {
  console.error('[Arbitova MCP] ERROR: ARBITOVA_RPC_URL is required (e.g. https://sepolia.base.org).');
  process.exit(1);
}
if (!ESCROW_ADDRESS) {
  console.error('[Arbitova MCP] ERROR: ARBITOVA_ESCROW_ADDRESS is required (deployed EscrowV1 address).');
  process.exit(1);
}
if (!USDC_ADDRESS) {
  console.error('[Arbitova MCP] ERROR: ARBITOVA_USDC_ADDRESS is required.');
  process.exit(1);
}

const READ_ONLY = !PRIVATE_KEY;

// ── ABIs (minimal, matches deployed EscrowV1) ────────────────────────────────

const ESCROW_ABI = [
  'function createEscrow(address seller, uint256 amount, uint64 deliveryWindowSec, uint64 reviewWindowSec, string verificationURI) returns (uint256)',
  'function markDelivered(uint256 id, bytes32 deliveryHash)',
  'function confirmDelivery(uint256 id)',
  'function dispute(uint256 id, string reason)',
  'function cancelIfNotDelivered(uint256 id)',
  'function getEscrow(uint256 id) view returns (tuple(address buyer, address seller, uint256 amount, uint64 deliveryDeadline, uint64 reviewDeadline, uint64 reviewWindowSec, uint8 state, bytes32 deliveryHash, string verificationURI))',
  'event EscrowCreated(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, uint64 deliveryDeadline, string verificationURI)',
  'event Delivered(uint256 indexed id, bytes32 deliveryHash, uint64 reviewDeadline)',
  'event Released(uint256 indexed id, uint256 toSeller, uint256 fee)',
  'event Disputed(uint256 indexed id, address by, string reason)',
  'event Cancelled(uint256 indexed id)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// Must match EscrowV1.sol: enum State { CREATED, DELIVERED, RELEASED, DISPUTED, RESOLVED, CANCELLED }
const STATE_NAMES = ['CREATED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'RESOLVED', 'CANCELLED'];

// ── Contract clients ─────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = READ_ONLY ? null : new ethers.Wallet(PRIVATE_KEY, provider);

// Read instances use provider; write instances use signer
const escrowRead = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, provider);
const escrowWrite = signer ? new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, signer) : null;
const usdcWrite = signer ? new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer) : null;

function requireSigner() {
  if (READ_ONLY) {
    const err = new Error(
      'This tool requires a signing key. Set ARBITOVA_AGENT_PRIVATE_KEY in your MCP server env to enable write operations.'
    );
    err.readOnly = true;
    throw err;
  }
}

function errResult(error, hint) {
  return {
    ok: false,
    error: String(error?.message || error),
    hint: hint || undefined,
  };
}

// ── Tool implementations ─────────────────────────────────────────────────────

async function arbitova_create_escrow({ seller, amount, deliveryWindowHours = 24, reviewWindowHours = 24, verificationURI }) {
  try {
    requireSigner();
    if (!seller || !amount || !verificationURI) {
      throw new Error('seller, amount, and verificationURI are required');
    }

    const decimals = await new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider).decimals();
    const amountWei = ethers.parseUnits(String(amount), decimals);

    const approveTx = await usdcWrite.approve(ESCROW_ADDRESS, amountWei);
    await approveTx.wait();

    const deliveryWindowSec = BigInt(Math.round(deliveryWindowHours * 3600));
    const reviewWindowSec = BigInt(Math.round(reviewWindowHours * 3600));

    const tx = await escrowWrite.createEscrow(
      seller,
      amountWei,
      deliveryWindowSec,
      reviewWindowSec,
      verificationURI,
    );
    const receipt = await tx.wait();

    let escrowId;
    for (const log of receipt.logs) {
      try {
        const parsed = escrowWrite.interface.parseLog(log);
        if (parsed?.name === 'EscrowCreated') {
          escrowId = parsed.args.id.toString();
          break;
        }
      } catch (_) { /* skip non-matching log */ }
    }

    return { ok: true, txHash: receipt.hash, escrowId };
  } catch (e) {
    return errResult(e, 'Check USDC balance, RPC URL, and that seller address is valid.');
  }
}

async function arbitova_mark_delivered({ escrowId, deliveryPayloadURI }) {
  try {
    requireSigner();
    if (!escrowId || !deliveryPayloadURI) {
      throw new Error('escrowId and deliveryPayloadURI are required');
    }

    const deliveryHash = ethers.keccak256(ethers.toUtf8Bytes(deliveryPayloadURI));
    const tx = await escrowWrite.markDelivered(BigInt(escrowId), deliveryHash);
    const receipt = await tx.wait();

    return { ok: true, txHash: receipt.hash, deliveryHash };
  } catch (e) {
    return errResult(e, 'Ensure the escrow exists and you are the seller. deliveryPayloadURI must be a stable URL pointing to completed work.');
  }
}

async function arbitova_confirm_delivery({ escrowId }) {
  try {
    requireSigner();
    if (!escrowId) throw new Error('escrowId is required');

    const tx = await escrowWrite.confirmDelivery(BigInt(escrowId));
    const receipt = await tx.wait();

    return { ok: true, txHash: receipt.hash };
  } catch (e) {
    return errResult(e, 'Only the buyer can confirm. Escrow must be in DELIVERED state and within the review window.');
  }
}

async function arbitova_dispute({ escrowId, reason }) {
  try {
    requireSigner();
    if (!escrowId || !reason) {
      throw new Error('escrowId and reason are required');
    }

    const tx = await escrowWrite.dispute(BigInt(escrowId), reason);
    const receipt = await tx.wait();

    return { ok: true, txHash: receipt.hash };
  } catch (e) {
    return errResult(e, 'Either buyer or seller can dispute. The reason field is recorded on-chain and reviewed by the arbiter.');
  }
}

async function arbitova_cancel_if_not_delivered({ escrowId }) {
  try {
    requireSigner();
    if (!escrowId) throw new Error('escrowId is required');

    const tx = await escrowWrite.cancelIfNotDelivered(BigInt(escrowId));
    const receipt = await tx.wait();

    return { ok: true, txHash: receipt.hash };
  } catch (e) {
    return errResult(e, 'Cancel is only possible after the delivery deadline has passed and the escrow is still in CREATED state.');
  }
}

async function arbitova_get_escrow({ escrowId }) {
  try {
    if (!escrowId) throw new Error('escrowId is required');

    const data = await escrowRead.getEscrow(BigInt(escrowId));

    return {
      ok: true,
      escrowId: String(escrowId),
      buyer: data.buyer,
      seller: data.seller,
      amount: ethers.formatUnits(data.amount, 6),
      deliveryDeadline: new Date(Number(data.deliveryDeadline) * 1000).toISOString(),
      reviewDeadline: data.reviewDeadline > 0n
        ? new Date(Number(data.reviewDeadline) * 1000).toISOString()
        : null,
      status: STATE_NAMES[Number(data.state)] || String(data.state),
      verificationURI: data.verificationURI,
      deliveryHash: data.deliveryHash !== ethers.ZeroHash ? data.deliveryHash : null,
    };
  } catch (e) {
    return errResult(e, 'Check that escrowId is valid and the contract address is correct.');
  }
}

// ── MCP tool schemas ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'arbitova_create_escrow',
    description:
      'Buyer locks USDC into the Arbitova EscrowV1 smart contract. Calls USDC.approve() then createEscrow() on-chain. ' +
      'Requires USDC balance >= amount. deliveryWindowHours = how long the seller has to deliver (default 24). ' +
      'reviewWindowHours = how long the buyer has to verify after delivery is marked (default 24). ' +
      'verificationURI must point to a publicly fetchable JSON document listing every criterion the delivery will be checked against. ' +
      'If the review window expires without confirmation or dispute, funds auto-escalate to arbitration. ' +
      'Silence protects the buyer — you do NOT need to confirm promptly.',
    inputSchema: {
      type: 'object',
      required: ['seller', 'amount', 'verificationURI'],
      properties: {
        seller: { type: 'string', description: 'Seller Ethereum address (0x-prefixed)' },
        amount: { type: 'number', description: 'USDC amount to lock (human-readable, e.g. 50 for 50 USDC)' },
        deliveryWindowHours: { type: 'number', description: 'Hours the seller has to deliver (default 24)', default: 24 },
        reviewWindowHours: { type: 'number', description: 'Hours the buyer has to review after delivery (default 24)', default: 24 },
        verificationURI: {
          type: 'string',
          description: 'Publicly fetchable URL of a JSON document listing every delivery criterion (e.g. {"criteria": ["word count >= 1000", "includes executive summary"]})',
        },
      },
    },
  },
  {
    name: 'arbitova_mark_delivered',
    description:
      'Called by the SELLER after completing the work and uploading the deliverable to a stable URL. ' +
      'deliveryPayloadURI must point to the completed, publicly fetchable deliverable — the contract hashes this URI on-chain. ' +
      'Do NOT call before work is actually done. Do NOT use a temporary or expiring URL. ' +
      'The arbiter will fetch this URI during dispute resolution — a broken or mismatched URL counts as non-delivery. ' +
      'Before calling: complete all work to spec, upload to a stable URL (IPFS or persistent storage), ' +
      'and verify the content matches every criterion in verificationURI.',
    inputSchema: {
      type: 'object',
      required: ['escrowId', 'deliveryPayloadURI'],
      properties: {
        escrowId: { type: 'string', description: 'The escrow ID returned by arbitova_create_escrow' },
        deliveryPayloadURI: { type: 'string', description: 'Stable public URL pointing to the completed deliverable' },
      },
    },
  },
  {
    name: 'arbitova_confirm_delivery',
    description:
      'Confirm that the seller has delivered and the output meets ALL criteria in the escrow\'s verificationURI. ' +
      'ONLY call after you have: (1) fetched the delivery payload, (2) fetched and parsed the verificationURI criteria document, ' +
      '(3) compared the payload against EVERY criterion, (4) are fully confident every criterion is satisfied. ' +
      'If anything is missing, wrong, ambiguous, incomplete, or the seller did not deliver the agreed output — ' +
      'DO NOT call this. Call arbitova_dispute instead with a specific reason citing the failed criterion. ' +
      'Silence is safer than a wrong confirmation: if you do not confirm within the review window, ' +
      'funds auto-escalate to AI arbitration, which protects the buyer by independently evaluating delivery.',
    inputSchema: {
      type: 'object',
      required: ['escrowId'],
      properties: {
        escrowId: { type: 'string', description: 'The escrow ID to confirm delivery for' },
      },
    },
  },
  {
    name: 'arbitova_dispute',
    description:
      'Open a dispute when delivery is missing, incorrect, incomplete, or violates the verification criteria. ' +
      'Disputes trigger AI arbitration which independently evaluates the delivery and can split funds fairly. ' +
      'Call this whenever arbitova_confirm_delivery feels uncertain — when in doubt, dispute. ' +
      'The reason field MUST cite specific criteria from verificationURI that were not met, ' +
      'e.g. "Delivery at [URI] is missing criterion 3: word count is 400 but spec requires >= 1000." ' +
      'Either the buyer OR the seller can open a dispute.',
    inputSchema: {
      type: 'object',
      required: ['escrowId', 'reason'],
      properties: {
        escrowId: { type: 'string', description: 'The escrow ID to dispute' },
        reason: {
          type: 'string',
          description: 'Specific reason citing which verification criteria were not met. Include the criterion text and what was observed.',
        },
      },
    },
  },
  {
    name: 'arbitova_get_escrow',
    description:
      'Fetch the current on-chain state of an escrow: buyer, seller, amount, deadlines, status, verificationURI, and deliveryHash. ' +
      'Use this to check whether delivery has been marked before fetching the payload, ' +
      'and to verify the reviewDeadline before deciding to confirm or dispute. ' +
      'Status values: CREATED (awaiting delivery), DELIVERED (seller marked done, review window open), ' +
      'RELEASED (funds released to seller), DISPUTED (in arbitration), RESOLVED (arbiter resolved), CANCELLED.',
    inputSchema: {
      type: 'object',
      required: ['escrowId'],
      properties: {
        escrowId: { type: 'string', description: 'The escrow ID to query' },
      },
    },
  },
  {
    name: 'arbitova_cancel_if_not_delivered',
    description:
      'Buyer cancels an escrow after the delivery deadline has passed and the seller has not marked delivery. ' +
      'Full USDC refund to buyer. Only callable by the buyer, only after deliveryDeadline has elapsed, ' +
      'and only when escrow is still in CREATED state. ' +
      'Call arbitova_get_escrow first to verify the deadline has passed and status is CREATED before calling this.',
    inputSchema: {
      type: 'object',
      required: ['escrowId'],
      properties: {
        escrowId: { type: 'string', description: 'The escrow ID to cancel' },
      },
    },
  },
];

async function handleTool(name, args) {
  switch (name) {
    case 'arbitova_create_escrow':           return arbitova_create_escrow(args);
    case 'arbitova_mark_delivered':          return arbitova_mark_delivered(args);
    case 'arbitova_confirm_delivery':        return arbitova_confirm_delivery(args);
    case 'arbitova_dispute':                 return arbitova_dispute(args);
    case 'arbitova_get_escrow':              return arbitova_get_escrow(args);
    case 'arbitova_cancel_if_not_delivered': return arbitova_cancel_if_not_delivered(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Resources ────────────────────────────────────────────────────────────────

const PROMPTS_DIR = path.join(__dirname, 'prompts');

const RESOURCES = [
  {
    uri: 'arbitova://prompts/buyer-verification',
    name: 'Buyer Verification Protocol',
    description: 'Checklist a buyer agent must follow before confirming delivery or opening a dispute. Fetches verification criteria, evaluates each one, then either confirms or disputes with specific reasons.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'arbitova://prompts/seller-delivery',
    name: 'Seller Delivery Protocol',
    description: 'Checklist a seller agent must follow before marking delivery. Emphasizes stable payload URLs, pre-submission self-check against criteria, and the on-chain hashing behavior.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'arbitova://prompts/arbitrator-self-check',
    name: 'Arbitrator Self-Check Protocol',
    description: 'Structured protocol for LLM-as-arbitrator use cases: gather evidence, evaluate criteria, produce a fair allocation verdict. Includes self-check and bias-prevention rules.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'arbitova://resources/escrow-abi',
    name: 'EscrowV1 Contract ABI',
    description: 'Minimal ABI for the Arbitova EscrowV1 smart contract (functions + events). Use this to interact with the contract directly via ethers.js, viem, web3.py, or any EVM library.',
    mimeType: 'application/json',
  },
];

function readPromptFile(filename) {
  return fs.readFileSync(path.join(PROMPTS_DIR, filename), 'utf8');
}

function readEscrowAbi() {
  return JSON.stringify(ESCROW_ABI, null, 2);
}

// ── MCP Server setup ─────────────────────────────────────────────────────────

const server = new Server(
  { name: 'arbitova', version: '4.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCES,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  try {
    let text;
    if (uri === 'arbitova://prompts/buyer-verification') {
      text = readPromptFile('buyer-verification.md');
    } else if (uri === 'arbitova://prompts/seller-delivery') {
      text = readPromptFile('seller-delivery.md');
    } else if (uri === 'arbitova://prompts/arbitrator-self-check') {
      text = readPromptFile('arbitrator-self-check.md');
    } else if (uri === 'arbitova://resources/escrow-abi') {
      text = readEscrowAbi();
    } else {
      throw new Error(`Unknown resource URI: ${uri}`);
    }
    return {
      contents: [{ uri, mimeType: uri.endsWith('abi') ? 'application/json' : 'text/markdown', text }],
    };
  } catch (err) {
    return {
      contents: [{ uri, mimeType: 'text/plain', text: `Error: ${err.message}` }],
    };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  process.stderr.write(
    `[Arbitova MCP] v4.0.0 started. Mode: ${READ_ONLY ? 'READ-ONLY' : 'SIGNING'}. Escrow: ${ESCROW_ADDRESS}\n`
  );
});
