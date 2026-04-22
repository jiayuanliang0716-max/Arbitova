// Arbitova — SDK constants
// Source of truth for contract addresses, ABIs, and state strings.

export const NETWORKS = {
  'base-sepolia': {
    label: 'Base Sepolia · Circle USDC',
    chainId: 84532,
    chainIdHex: '0x14a34',
    chainName: 'Base Sepolia',
    rpc: 'https://sepolia.base.org',
    escrow: '0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    usdcSymbol: 'USDC',
    usdcDecimals: 6,
    explorer: 'https://sepolia.basescan.org',
  },
  'base-sepolia-test': {
    label: 'Base Sepolia · Mock USDC (test)',
    chainId: 84532,
    chainIdHex: '0x14a34',
    chainName: 'Base Sepolia',
    rpc: 'https://sepolia.base.org',
    escrow: '0x331cE65982Dd879920fA00195e70bF77f18AB61A',
    usdc: '0xe5FC9d9D89817268b87C4ECcfd0A01CAea8c011e',
    usdcSymbol: 'mUSDC',
    usdcDecimals: 6,
    explorer: 'https://sepolia.basescan.org',
  },
};

export const DEFAULT_NETWORK = 'base-sepolia';

export const ESCROW_ABI = [
  'function createEscrow(address seller, uint256 amount, uint64 deliveryWindowSec, uint64 reviewWindowSec, string verificationURI) returns (uint256)',
  'function markDelivered(uint256 id, bytes32 deliveryHash)',
  'function confirmDelivery(uint256 id)',
  'function dispute(uint256 id, string reason)',
  'function cancelIfNotDelivered(uint256 id)',
  'function escalateIfExpired(uint256 id)',
  'function resolve(uint256 id, uint16 buyerBps, uint16 sellerBps, bytes32 verdictHash)',
  'function getEscrow(uint256 id) view returns (tuple(address buyer, address seller, uint256 amount, uint64 deliveryDeadline, uint64 reviewDeadline, uint64 reviewWindowSec, uint8 state, bytes32 deliveryHash, string verificationURI))',
  'function nextEscrowId() view returns (uint256)',
  'function releaseFeeBps() view returns (uint16)',
  'function resolveFeeBps() view returns (uint16)',
  'event EscrowCreated(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, uint64 deliveryDeadline, string verificationURI)',
  'event Delivered(uint256 indexed id, bytes32 deliveryHash, uint64 reviewDeadline)',
  'event Released(uint256 indexed id, uint256 toSeller, uint256 fee)',
  'event Disputed(uint256 indexed id, address by, string reason)',
  'event Cancelled(uint256 indexed id)',
  'event Resolved(uint256 indexed id, uint256 toBuyer, uint256 toSeller, uint256 feePaid, bytes32 verdictHash)',
];

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export const STATES = Object.freeze([
  'CREATED',
  'DELIVERED',
  'RELEASED',
  'DISPUTED',
  'RESOLVED',
  'CANCELLED',
]);

export const GAS_LIMITS = {
  approve: 80_000n,
  createEscrow: 280_000n,
  markDelivered: 150_000n,
  confirmDelivery: 180_000n,
  dispute: 120_000n,
  cancelIfNotDelivered: 120_000n,
  escalateIfExpired: 120_000n,
  resolve: 200_000n,
};
