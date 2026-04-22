'use strict';

/**
 * Arbitova MCP HTTP Endpoint — Path B (non-custodial)
 *
 * Implements MCP JSON-RPC 2.0 over HTTP for Smithery.ai and other
 * HTTP-based MCP clients.
 *
 * Path B design choice: this HTTP endpoint is READ-ONLY by design.
 * Signing a transaction requires the agent's private key, and sending a
 * private key over HTTP to api.arbitova.com would make Arbitova a
 * custodian — exactly what Path B removes. Write tools return a clear
 * error telling the user to install @arbitova/mcp-server (stdio) which
 * keeps the key local.
 *
 * Supported over HTTP:
 *   - arbitova_get_escrow (chain read, no signing)
 *
 * Write tools (require @arbitova/mcp-server stdio):
 *   - arbitova_create_escrow
 *   - arbitova_mark_delivered
 *   - arbitova_confirm_delivery
 *   - arbitova_dispute
 *   - arbitova_cancel_if_not_delivered
 *   - arbitova_escalate_if_expired
 */

const express = require('express');
const router  = express.Router();
const { ethers } = require('ethers');

const RPC_URL        = process.env.ARBITOVA_RPC_URL        || 'https://sepolia.base.org';
const ESCROW_ADDRESS = process.env.ARBITOVA_ESCROW_ADDRESS || '0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC';

const ESCROW_ABI = [
  'function getEscrow(uint256 id) view returns (tuple(address buyer, address seller, uint256 amount, uint64 deliveryDeadline, uint64 reviewDeadline, uint64 reviewWindowSec, uint8 state, bytes32 deliveryHash, string verificationURI))',
];

const STATE_NAMES = ['CREATED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'RESOLVED', 'CANCELLED'];

let _provider, _escrow;
function escrowRead() {
  if (!_escrow) {
    _provider = new ethers.JsonRpcProvider(RPC_URL);
    _escrow   = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, _provider);
  }
  return _escrow;
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

const ok  = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

const SIGNING_HINT =
  'This tool requires a local signing key. HTTP MCP is read-only by design (non-custodial). ' +
  'Install the stdio MCP server locally: `npx -y @arbitova/mcp-server` and set ARBITOVA_AGENT_PRIVATE_KEY. ' +
  'See https://arbitova.com/learn for setup.';

// ── Tool catalog (all 7 Path B tools, shown for discovery) ────────────────────

const TOOLS = [
  {
    name: 'arbitova_create_escrow',
    description:
      'Buyer locks USDC into EscrowV1 on Base. SIGNING REQUIRED — use the stdio MCP server (@arbitova/mcp-server) locally; HTTP cannot hold your key.',
    inputSchema: {
      type: 'object',
      required: ['seller', 'amount', 'verificationURI'],
      properties: {
        seller:              { type: 'string',  description: 'Seller Ethereum address (0x-prefixed)' },
        amount:              { type: 'number',  description: 'USDC amount to lock (e.g. 50)' },
        deliveryWindowHours: { type: 'number',  description: 'Hours seller has to deliver (default 24)', default: 24 },
        reviewWindowHours:   { type: 'number',  description: 'Hours buyer has to review (default 24)', default: 24 },
        verificationURI:     { type: 'string',  description: 'Public JSON listing every delivery criterion' },
      },
    },
  },
  {
    name: 'arbitova_mark_delivered',
    description:
      'Seller marks escrow as delivered, hashing the payload URI on-chain. SIGNING REQUIRED — use stdio MCP.',
    inputSchema: {
      type: 'object',
      required: ['escrowId', 'deliveryPayloadURI'],
      properties: {
        escrowId:           { type: 'string', description: 'Escrow ID from create_escrow' },
        deliveryPayloadURI: { type: 'string', description: 'Stable public URL of the completed deliverable' },
      },
    },
  },
  {
    name: 'arbitova_confirm_delivery',
    description:
      'Buyer releases funds after verifying every criterion in verificationURI. SIGNING REQUIRED — use stdio MCP.',
    inputSchema: {
      type: 'object',
      required: ['escrowId'],
      properties: { escrowId: { type: 'string' } },
    },
  },
  {
    name: 'arbitova_dispute',
    description:
      'Open a dispute citing which criteria failed. Either buyer or seller may dispute. SIGNING REQUIRED — use stdio MCP.',
    inputSchema: {
      type: 'object',
      required: ['escrowId', 'reason'],
      properties: {
        escrowId: { type: 'string' },
        reason:   { type: 'string', description: 'Specific failed criteria + observed vs expected' },
      },
    },
  },
  {
    name: 'arbitova_cancel_if_not_delivered',
    description:
      'Buyer reclaims funds if the delivery deadline passes without markDelivered. SIGNING REQUIRED — use stdio MCP.',
    inputSchema: {
      type: 'object',
      required: ['escrowId'],
      properties: { escrowId: { type: 'string' } },
    },
  },
  {
    name: 'arbitova_escalate_if_expired',
    description:
      'Permissionless: anyone can push a DELIVERED escrow into DISPUTED after reviewDeadline. SIGNING REQUIRED — use stdio MCP.',
    inputSchema: {
      type: 'object',
      required: ['escrowId'],
      properties: { escrowId: { type: 'string' } },
    },
  },
  {
    name: 'arbitova_get_escrow',
    description:
      'Read on-chain state of an escrow: buyer, seller, amount, deadlines, state, verificationURI, deliveryHash. No signing needed.',
    inputSchema: {
      type: 'object',
      required: ['escrowId'],
      properties: { escrowId: { type: 'string', description: 'Escrow ID to query' } },
    },
  },
];

const WRITE_TOOL_NAMES = new Set([
  'arbitova_create_escrow',
  'arbitova_mark_delivered',
  'arbitova_confirm_delivery',
  'arbitova_dispute',
  'arbitova_cancel_if_not_delivered',
  'arbitova_escalate_if_expired',
]);

// ── Tool handler ──────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  if (WRITE_TOOL_NAMES.has(name)) {
    return {
      ok: false,
      error: 'signing_required',
      hint: SIGNING_HINT,
      install: 'npx -y @arbitova/mcp-server',
    };
  }

  if (name === 'arbitova_get_escrow') {
    if (!args.escrowId && args.escrowId !== 0) {
      throw new Error('escrowId is required');
    }
    const data = await escrowRead().getEscrow(BigInt(args.escrowId));
    return {
      ok: true,
      escrowId:         String(args.escrowId),
      buyer:            data.buyer,
      seller:           data.seller,
      amount:           ethers.formatUnits(data.amount, 6),
      deliveryDeadline: new Date(Number(data.deliveryDeadline) * 1000).toISOString(),
      reviewDeadline:   data.reviewDeadline > 0n ? new Date(Number(data.reviewDeadline) * 1000).toISOString() : null,
      state:            STATE_NAMES[Number(data.state)] || String(data.state),
      verificationURI:  data.verificationURI,
      deliveryHash:     data.deliveryHash !== ethers.ZeroHash ? data.deliveryHash : null,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  res.json({
    name: 'arbitova',
    version: '4.0.1',
    description:
      'Arbitova MCP HTTP endpoint (Path B, non-custodial). Read-only by design. ' +
      'For signing, install the stdio MCP server: npx -y @arbitova/mcp-server',
    tools_count: TOOLS.length,
    signing_over_http: false,
    stdio_package: '@arbitova/mcp-server',
    chain: {
      rpc_url: RPC_URL,
      escrow_address: ESCROW_ADDRESS,
    },
    docs: 'https://arbitova.com/learn',
  });
});

router.post('/', async (req, res) => {
  const { method, params, id } = req.body || {};

  try {
    if (method === 'initialize') {
      return res.json(ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'arbitova', version: '4.0.1' },
      }));
    }

    if (method === 'notifications/initialized') {
      return res.status(204).end();
    }

    if (method === 'tools/list') {
      return res.json(ok(id, { tools: TOOLS }));
    }

    if (method === 'tools/call') {
      const result = await handleTool(params.name, params.arguments || {});
      return res.json(ok(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: result && result.ok === false,
      }));
    }

    return res.json(err(id, -32601, `Method not found: ${method}`));
  } catch (e) {
    return res.json(ok(id, {
      content: [{ type: 'text', text: `Error: ${e.message}` }],
      isError: true,
    }));
  }
});

module.exports = router;
