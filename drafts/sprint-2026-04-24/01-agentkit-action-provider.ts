/**
 * ArbitovaActionProvider — Coinbase AgentKit action provider that wraps
 * Arbitova's non-custodial USDC escrow on Base.
 *
 * TARGET: submit as a PR to coinbase/agentkit under
 *   typescript/agentkit/src/action-providers/arbitova/
 *
 * The PR should include, as siblings of this file:
 *   - index.ts (re-export)
 *   - schemas.ts (the zod schemas below, extracted)
 *   - arbitovaActionProvider.test.ts (mirror of other providers' tests)
 *
 * This single file combines provider + schemas + README-style header so it
 * can be reviewed end-to-end before being split into the three files above.
 *
 * Category proposed for AgentKit WISHLIST.md: "Escrow / Dispute Resolution".
 *
 * Networks:
 *   base-sepolia (live): EscrowV1 @ 0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC
 *   base-mainnet (pending user deploy): address TBD
 *
 * Why AgentKit should ship this: every x402 / per-call payment provider in
 * AgentKit has the same gap — once the buyer agent pays, there's no
 * recourse if the seller agent delivers garbage. Arbitova is the drop-in
 * dispute layer: createEscrow locks the USDC, markDelivered opens review,
 * confirmDelivery settles, dispute locks funds until an arbiter resolves.
 * Every verdict is public on /verdicts for per-case transparency.
 */

import { z } from 'zod';
import { encodeFunctionData, parseUnits, formatUnits, type Address } from 'viem';
import { ActionProvider, CreateAction, Network } from '@coinbase/agentkit';
import { EvmWalletProvider } from '@coinbase/agentkit';

// ---------------------------------------------------------------------------
// Constants — source of truth: https://arbitova.com/.well-known/agent.json
// ---------------------------------------------------------------------------
const ARBITOVA_CONTRACTS = {
  'base-sepolia': {
    escrow: '0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC' as Address,
    usdc:   '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address,
  },
  // 'base-mainnet': populated on deploy; see SPRINT-C
} as const;

const ESCROW_ABI = [
  {
    type: 'function',
    name: 'createEscrow',
    inputs: [
      { name: 'seller', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deliveryWindowSec', type: 'uint256' },
      { name: 'reviewWindowSec', type: 'uint256' },
      { name: 'verificationURI', type: 'string' },
    ],
    outputs: [{ name: 'escrowId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'markDelivered',
    inputs: [
      { name: 'escrowId', type: 'uint256' },
      { name: 'deliveryHash', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'confirmDelivery',
    inputs: [{ name: 'escrowId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'dispute',
    inputs: [
      { name: 'escrowId', type: 'uint256' },
      { name: 'reason', type: 'string' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getEscrow',
    inputs: [{ name: 'escrowId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'buyer', type: 'address' },
          { name: 'seller', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'deliveryDeadline', type: 'uint256' },
          { name: 'reviewDeadline', type: 'uint256' },
          { name: 'reviewWindowSec', type: 'uint64' },
          { name: 'state', type: 'uint8' },
          { name: 'deliveryHash', type: 'bytes32' },
          { name: 'verificationURI', type: 'string' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

const ESCROW_STATES = ['CREATED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'RESOLVED', 'CANCELLED'] as const;

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------
const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 40-char hex address');

const CreateEscrowSchema = z
  .object({
    seller: AddressSchema.describe('Seller agent wallet that will receive USDC on delivery.'),
    amountUsdc: z.string().describe('USDC amount as a decimal string, e.g. "5.00". Six decimals are applied automatically.'),
    deliveryWindowSec: z.number().int().positive().describe('Seconds the seller has to call markDelivered before the escrow can be cancelled.'),
    reviewWindowSec:   z.number().int().positive().describe('Seconds the buyer has to confirm or dispute after markDelivered.'),
    verificationURI:   z.string().url().describe('URL or ipfs:// URI pointing to the task spec. Public.'),
  })
  .strict();

const MarkDeliveredSchema = z
  .object({
    escrowId:     z.string().regex(/^\d+$/, 'escrow id is a decimal integer (uint256)'),
    deliveryHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 0x + 64 hex chars (keccak256 of the payload URI)'),
  })
  .strict();

const ConfirmDeliverySchema = z
  .object({ escrowId: z.string().regex(/^\d+$/) })
  .strict();

const DisputeSchema = z
  .object({
    escrowId: z.string().regex(/^\d+$/),
    reason:   z.string().min(1).max(280).describe('Short reason emitted in the Disputed event.'),
  })
  .strict();

const GetEscrowSchema = z
  .object({ escrowId: z.string().regex(/^\d+$/) })
  .strict();

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
export class ArbitovaActionProvider extends ActionProvider<EvmWalletProvider> {
  constructor() {
    super('arbitova', []);
  }

  public supportsNetwork(network: Network): boolean {
    return network.protocolFamily === 'evm'
      && (network.networkId === 'base-sepolia' || network.networkId === 'base-mainnet');
  }

  private contractsFor(network: Network) {
    const row = ARBITOVA_CONTRACTS[network.networkId as keyof typeof ARBITOVA_CONTRACTS];
    if (!row) throw new Error(`Arbitova is not deployed on ${network.networkId}`);
    return row;
  }

  // -------------------------------------------------------------------------
  // createEscrow
  // -------------------------------------------------------------------------
  @CreateAction({
    name: 'create_escrow',
    description:
      'Lock USDC into an Arbitova escrow on Base. The buyer agent calls this to pay the seller. Funds are held by the contract until the buyer confirms delivery (seller is paid, minus 0.5%) or a dispute is filed. This is a two-step operation: an ERC20 approve, then createEscrow.',
    schema: CreateEscrowSchema,
  })
  async createEscrow(wallet: EvmWalletProvider, args: z.infer<typeof CreateEscrowSchema>): Promise<string> {
    const { escrow, usdc } = this.contractsFor(wallet.getNetwork());
    const amount = parseUnits(args.amountUsdc, 6);

    // Step 1: approve
    const approveTx = await wallet.sendTransaction({
      to: usdc,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [escrow, amount] }),
    });
    await wallet.waitForTransactionReceipt(approveTx);

    // Step 2: createEscrow
    const createTx = await wallet.sendTransaction({
      to: escrow,
      data: encodeFunctionData({
        abi: ESCROW_ABI,
        functionName: 'createEscrow',
        args: [args.seller as Address, amount, BigInt(args.deliveryWindowSec), BigInt(args.reviewWindowSec), args.verificationURI],
      }),
    });
    const receipt = await wallet.waitForTransactionReceipt(createTx);

    const esc = ARBITOVA_CONTRACTS[wallet.getNetwork().networkId as keyof typeof ARBITOVA_CONTRACTS];
    const logUrl = `https://${wallet.getNetwork().networkId === 'base-mainnet' ? 'basescan.org' : 'sepolia.basescan.org'}/tx/${createTx}`;
    return [
      `Escrow created on ${wallet.getNetwork().networkId}.`,
      `Amount: ${args.amountUsdc} USDC locked in ${esc.escrow}.`,
      `Approve tx: ${approveTx}`,
      `Create tx:  ${createTx}`,
      `Explorer:   ${logUrl}`,
      `Next step:  seller calls mark_delivered with deliveryHash once they've delivered the work.`,
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // markDelivered
  // -------------------------------------------------------------------------
  @CreateAction({
    name: 'mark_delivered',
    description:
      'Seller-side: declare the work is delivered and open the review window. deliveryHash is keccak256 of the delivered payload URI (e.g. an IPFS CID or URL). The buyer then has reviewWindowSec to confirm or dispute.',
    schema: MarkDeliveredSchema,
  })
  async markDelivered(wallet: EvmWalletProvider, args: z.infer<typeof MarkDeliveredSchema>): Promise<string> {
    const { escrow } = this.contractsFor(wallet.getNetwork());
    const tx = await wallet.sendTransaction({
      to: escrow,
      data: encodeFunctionData({
        abi: ESCROW_ABI,
        functionName: 'markDelivered',
        args: [BigInt(args.escrowId), args.deliveryHash as `0x${string}`],
      }),
    });
    await wallet.waitForTransactionReceipt(tx);
    return `Escrow ${args.escrowId} marked delivered. Buyer has reviewWindowSec to confirm or dispute. Tx: ${tx}`;
  }

  // -------------------------------------------------------------------------
  // confirmDelivery
  // -------------------------------------------------------------------------
  @CreateAction({
    name: 'confirm_delivery',
    description:
      'Buyer-side happy path. Releases USDC to the seller (minus the 0.5% release fee) and closes the escrow. Only callable during the review window; after it, either party can call confirm for automatic settlement.',
    schema: ConfirmDeliverySchema,
  })
  async confirmDelivery(wallet: EvmWalletProvider, args: z.infer<typeof ConfirmDeliverySchema>): Promise<string> {
    const { escrow } = this.contractsFor(wallet.getNetwork());
    const tx = await wallet.sendTransaction({
      to: escrow,
      data: encodeFunctionData({
        abi: ESCROW_ABI,
        functionName: 'confirmDelivery',
        args: [BigInt(args.escrowId)],
      }),
    });
    await wallet.waitForTransactionReceipt(tx);
    return `Escrow ${args.escrowId} confirmed. Seller has been paid. Tx: ${tx}`;
  }

  // -------------------------------------------------------------------------
  // dispute
  // -------------------------------------------------------------------------
  @CreateAction({
    name: 'dispute',
    description:
      'Either party can raise a dispute during the review window. Funds stay locked until the designated arbiter resolves. The reason string is emitted in the Disputed event and appears on https://arbitova.com/verdicts for public review.',
    schema: DisputeSchema,
  })
  async dispute(wallet: EvmWalletProvider, args: z.infer<typeof DisputeSchema>): Promise<string> {
    const { escrow } = this.contractsFor(wallet.getNetwork());
    const tx = await wallet.sendTransaction({
      to: escrow,
      data: encodeFunctionData({
        abi: ESCROW_ABI,
        functionName: 'dispute',
        args: [BigInt(args.escrowId), args.reason],
      }),
    });
    await wallet.waitForTransactionReceipt(tx);
    return [
      `Dispute filed on escrow ${args.escrowId}.`,
      `Reason: ${args.reason}`,
      `Tx: ${tx}`,
      `Track the verdict at https://arbitova.com/verdicts/${args.escrowId}`,
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // getEscrow (read)
  // -------------------------------------------------------------------------
  @CreateAction({
    name: 'get_escrow',
    description: 'Read the current state of an Arbitova escrow. Returns buyer, seller, amount, deadlines, state (CREATED/DELIVERED/RELEASED/DISPUTED/RESOLVED/CANCELLED), and verificationURI.',
    schema: GetEscrowSchema,
  })
  async getEscrow(wallet: EvmWalletProvider, args: z.infer<typeof GetEscrowSchema>): Promise<string> {
    const { escrow } = this.contractsFor(wallet.getNetwork());
    const result = (await wallet.readContract({
      address: escrow,
      abi: ESCROW_ABI,
      functionName: 'getEscrow',
      args: [BigInt(args.escrowId)],
    })) as {
      buyer: Address; seller: Address; amount: bigint;
      deliveryDeadline: bigint; reviewDeadline: bigint; reviewWindowSec: bigint;
      state: number; deliveryHash: `0x${string}`; verificationURI: string;
    };

    return JSON.stringify({
      escrowId: args.escrowId,
      buyer:    result.buyer,
      seller:   result.seller,
      amount:   formatUnits(result.amount, 6) + ' USDC',
      deliveryDeadline: new Date(Number(result.deliveryDeadline) * 1000).toISOString(),
      reviewDeadline:   result.reviewDeadline === 0n ? null : new Date(Number(result.reviewDeadline) * 1000).toISOString(),
      state:            ESCROW_STATES[result.state] || String(result.state),
      deliveryHash:     result.deliveryHash,
      verificationURI:  result.verificationURI,
    }, null, 2);
  }
}

export const arbitovaActionProvider = () => new ArbitovaActionProvider();
