'use strict';

/**
 * Arbitova Path B — On-chain Escrow SDK (EscrowV1)
 *
 * Agent-owned wallet mode: funds flow directly through the EscrowV1 smart contract.
 * Your private key never leaves this process. Arbitova is not a custodian.
 *
 * Required env vars:
 *   ARBITOVA_RPC_URL          — e.g. https://mainnet.base.org
 *   ARBITOVA_ESCROW_ADDRESS   — deployed EscrowV1 address
 *   ARBITOVA_USDC_ADDRESS     — USDC token address (mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
 *   ARBITOVA_AGENT_PRIVATE_KEY — your agent wallet private key (hex, 0x-prefixed)
 */

const { ethers } = require('ethers');

// ── Minimal ABIs ──────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function getEnv(key) {
  const val = process.env[key];
  if (!val) throw new Error(`PathB: env var ${key} is required`);
  return val;
}

function getContracts() {
  const rpcUrl = getEnv('ARBITOVA_RPC_URL');
  const escrowAddress = getEnv('ARBITOVA_ESCROW_ADDRESS');
  const usdcAddress = getEnv('ARBITOVA_USDC_ADDRESS');
  const privateKey = getEnv('ARBITOVA_AGENT_PRIVATE_KEY');

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, wallet);
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, wallet);

  return { provider, wallet, escrow, usdc };
}

function errResult(error, hint) {
  return { ok: false, error: String(error?.message || error), hint };
}

// ── Tool implementations ──────────────────────────────────────────────────────

/**
 * Buyer locks USDC into EscrowV1.
 * Calls USDC.approve() then createEscrow().
 */
async function arbitova_create_escrow({
  seller,
  amount,
  deliveryWindowHours = 24,
  reviewWindowHours = 24,
  verificationURI,
}) {
  try {
    const { escrow, usdc, wallet } = getContracts();

    const decimals = await usdc.decimals();
    const amountWei = ethers.parseUnits(String(amount), decimals);

    // Approve escrow contract to spend USDC
    const approveTx = await usdc.approve(await escrow.getAddress(), amountWei);
    await approveTx.wait();

    const deliveryWindowSec = BigInt(deliveryWindowHours * 3600);
    const reviewWindowSec = BigInt(reviewWindowHours * 3600);

    const tx = await escrow.createEscrow(
      seller,
      amountWei,
      deliveryWindowSec,
      reviewWindowSec,
      verificationURI,
    );
    const receipt = await tx.wait();

    // Parse EscrowCreated event to get the escrowId
    const iface = escrow.interface;
    let escrowId;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === 'EscrowCreated') {
          escrowId = parsed.args.id.toString();
          break;
        }
      } catch (_) { /* skip */ }
    }

    return { ok: true, txHash: receipt.hash, escrowId };
  } catch (e) {
    return errResult(e, 'Check USDC balance, RPC URL, and that seller address is valid.');
  }
}

/**
 * Seller marks delivery. Hashes the payload URI to produce deliveryHash.
 */
async function arbitova_mark_delivered({ escrowId, deliveryPayloadURI }) {
  try {
    const { escrow } = getContracts();

    const deliveryHash = ethers.keccak256(ethers.toUtf8Bytes(deliveryPayloadURI));
    const tx = await escrow.markDelivered(BigInt(escrowId), deliveryHash);
    const receipt = await tx.wait();

    return { ok: true, txHash: receipt.hash, deliveryHash };
  } catch (e) {
    return errResult(e, 'Ensure the escrow exists and you are the seller. deliveryPayloadURI must be a stable URL pointing to completed work.');
  }
}

/**
 * Buyer confirms delivery after verification.
 */
async function arbitova_confirm_delivery({ escrowId }) {
  try {
    const { escrow } = getContracts();

    const tx = await escrow.confirmDelivery(BigInt(escrowId));
    const receipt = await tx.wait();

    return { ok: true, txHash: receipt.hash };
  } catch (e) {
    return errResult(e, 'Only the buyer can confirm. Escrow must be in Delivered state and within review window.');
  }
}

/**
 * Either party opens a dispute.
 */
async function arbitova_dispute({ escrowId, reason }) {
  try {
    const { escrow } = getContracts();

    const tx = await escrow.dispute(BigInt(escrowId), reason);
    const receipt = await tx.wait();

    return { ok: true, txHash: receipt.hash };
  } catch (e) {
    return errResult(e, 'Either buyer or seller can dispute. The reason field will be recorded on-chain and reviewed by the arbiter.');
  }
}

/**
 * View escrow state.
 */
async function arbitova_get_escrow({ escrowId }) {
  try {
    const { escrow } = getContracts();

    const data = await escrow.getEscrow(BigInt(escrowId));
    // Must match EscrowV1.sol `enum State { CREATED, DELIVERED, RELEASED, DISPUTED, RESOLVED, CANCELLED }`.
    const STATUS = ['CREATED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'RESOLVED', 'CANCELLED'];

    return {
      ok: true,
      escrowId: String(escrowId),
      buyer: data.buyer,
      seller: data.seller,
      amount: ethers.formatUnits(data.amount, 6), // USDC has 6 decimals
      deliveryDeadline: new Date(Number(data.deliveryDeadline) * 1000).toISOString(),
      reviewDeadline: data.reviewDeadline > 0n
        ? new Date(Number(data.reviewDeadline) * 1000).toISOString()
        : null,
      status: STATUS[Number(data.state)] || String(data.state),
      verificationURI: data.verificationURI,
      deliveryHash: data.deliveryHash !== ethers.ZeroHash ? data.deliveryHash : null,
    };
  } catch (e) {
    return errResult(e, 'Check that escrowId is valid and the contract address is correct.');
  }
}

/**
 * Buyer cancels if seller has not delivered before the delivery deadline.
 */
async function arbitova_cancel_if_not_delivered({ escrowId }) {
  try {
    const { escrow } = getContracts();

    const tx = await escrow.cancelIfNotDelivered(BigInt(escrowId));
    const receipt = await tx.wait();

    return { ok: true, txHash: receipt.hash };
  } catch (e) {
    return errResult(e, 'Cancel is only possible after the delivery deadline has passed and the escrow is still in CREATED state.');
  }
}

// ── Tool definitions (OpenAI-style, for AutoGen / LangChain / Anthropic) ─────

function getToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'arbitova_create_escrow',
        description:
          'Buyer locks USDC into the Arbitova EscrowV1 smart contract. Calls USDC.approve() then createEscrow() on-chain. ' +
          'REQUIRES: USDC balance >= amount. ' +
          'deliveryWindowHours = how long the seller has to deliver (default 24). ' +
          'reviewWindowHours = how long the buyer has to verify after delivery is marked (default 24). ' +
          'verificationURI must point to a publicly fetchable JSON document listing every criterion the delivery will be checked against — ' +
          'this is the verification contract between buyer and seller. ' +
          'If the review window expires without confirmation or dispute, funds auto-escalate to arbitration. ' +
          'Silence protects the buyer; you do NOT need to confirm promptly.',
        parameters: {
          type: 'object',
          required: ['seller', 'amount', 'verificationURI'],
          properties: {
            seller: {
              type: 'string',
              description: 'Seller Ethereum address (0x-prefixed)',
            },
            amount: {
              type: 'number',
              description: 'USDC amount to lock (human-readable, e.g. 50.00 for 50 USDC)',
            },
            deliveryWindowHours: {
              type: 'number',
              description: 'Hours the seller has to deliver (default 24)',
              default: 24,
            },
            reviewWindowHours: {
              type: 'number',
              description: 'Hours the buyer has to review after delivery (default 24)',
              default: 24,
            },
            verificationURI: {
              type: 'string',
              description:
                'Publicly fetchable URL of a JSON document listing every delivery criterion (e.g. {"criteria": ["word count >= 1000", "includes executive summary"]})',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'arbitova_mark_delivered',
        description:
          'Called by the SELLER after completing the work and uploading the deliverable to a stable URL. ' +
          'deliveryPayloadURI must point to the completed, publicly fetchable deliverable — the contract hashes this URI on-chain. ' +
          'Do NOT call this before the work is actually done. Do NOT use a temporary or expiring URL. ' +
          'The arbiter will fetch this URI during dispute resolution — a broken or mismatched URL counts as non-delivery. ' +
          'Before calling: (1) complete all work to spec, (2) upload to a stable URL (IPFS or persistent storage), ' +
          '(3) verify the content matches every criterion in verificationURI.',
        parameters: {
          type: 'object',
          required: ['escrowId', 'deliveryPayloadURI'],
          properties: {
            escrowId: {
              type: 'string',
              description: 'The escrow ID returned by arbitova_create_escrow',
            },
            deliveryPayloadURI: {
              type: 'string',
              description:
                'Stable public URL pointing to the completed deliverable (output, proof of work, etc.)',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'arbitova_confirm_delivery',
        description:
          'Confirm that the seller has delivered and the output meets ALL criteria in the escrow\'s verificationURI. ' +
          'ONLY call this AFTER you have: (1) fetched the delivery payload from deliveryPayloadURI, ' +
          '(2) fetched and parsed the verificationURI criteria document, ' +
          '(3) compared the payload against EVERY criterion, ' +
          '(4) are fully confident every criterion is satisfied. ' +
          'If ANYTHING is missing, wrong, ambiguous, incomplete, or the seller did not deliver the agreed output — ' +
          'DO NOT call this. Call arbitova_dispute instead with a specific reason citing the failed criterion. ' +
          'Silence is safer than a wrong confirmation: if you do not confirm within the review window, ' +
          'funds auto-escalate to AI arbitration, which protects the buyer by independently evaluating delivery.',
        parameters: {
          type: 'object',
          required: ['escrowId'],
          properties: {
            escrowId: {
              type: 'string',
              description: 'The escrow ID to confirm delivery for',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'arbitova_dispute',
        description:
          'Open a dispute when delivery is missing, incorrect, incomplete, or violates the verification criteria. ' +
          'Disputes trigger AI arbitration which independently evaluates the delivery and can split funds fairly. ' +
          'Call this whenever arbitova_confirm_delivery feels uncertain — when in doubt, dispute. ' +
          'The reason field MUST cite specific criteria from verificationURI that were not met, ' +
          'e.g. "Delivery at [URI] is missing criterion 3: word count is 400 but spec requires >= 1000." ' +
          'Either the buyer OR the seller can open a dispute. ' +
          'This is the correct action for: missing delivery, partial delivery, wrong format, ' +
          'criteria mismatch, broken payload URL, expired URL, or any ambiguity.',
        parameters: {
          type: 'object',
          required: ['escrowId', 'reason'],
          properties: {
            escrowId: {
              type: 'string',
              description: 'The escrow ID to dispute',
            },
            reason: {
              type: 'string',
              description:
                'Specific reason citing which verification criteria were not met. Include the criterion text and what was observed.',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'arbitova_get_escrow',
        description:
          'Fetch the current on-chain state of an escrow: buyer, seller, amount, deadlines, status, verificationURI, and deliveryHash. ' +
          'Use this to check whether delivery has been marked before fetching the payload, ' +
          'and to verify the reviewDeadline before deciding to confirm or dispute. ' +
          'Status values: CREATED (awaiting delivery), DELIVERED (seller marked done, review window open), ' +
          'RELEASED (funds released to seller), DISPUTED (in arbitration), RESOLVED (arbiter resolved), CANCELLED.',
        parameters: {
          type: 'object',
          required: ['escrowId'],
          properties: {
            escrowId: {
              type: 'string',
              description: 'The escrow ID to query',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'arbitova_cancel_if_not_delivered',
        description:
          'Buyer cancels an escrow after the delivery deadline has passed and the seller has not marked delivery. ' +
          'Full USDC refund to buyer. Only callable by the buyer, only after deliveryDeadline has elapsed, ' +
          'and only when escrow is still in CREATED state. ' +
          'Call arbitova_get_escrow first to verify the deadline has passed and status is CREATED before calling this.',
        parameters: {
          type: 'object',
          required: ['escrowId'],
          properties: {
            escrowId: {
              type: 'string',
              description: 'The escrow ID to cancel',
            },
          },
        },
      },
    },
  ];
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  arbitova_create_escrow,
  arbitova_mark_delivered,
  arbitova_confirm_delivery,
  arbitova_dispute,
  arbitova_get_escrow,
  arbitova_cancel_if_not_delivered,
  getToolDefinitions,
  // Also export ABIs for advanced users
  ESCROW_ABI,
  ERC20_ABI,
};
