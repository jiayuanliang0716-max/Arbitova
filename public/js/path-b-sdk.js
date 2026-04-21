/**
 * Arbitova Path B — Browser SDK
 *
 * Talks directly to EscrowV1 on Base Sepolia via MetaMask.
 * No private keys, no backend custody. Everything signs client-side.
 *
 * Usage:
 *   <script type="module" src="https://cdn.jsdelivr.net/npm/ethers@6.16.0/dist/ethers.umd.min.js"></script>
 *   <script src="/js/path-b-sdk.js"></script>
 *   <script>
 *     await PathB.connect();
 *     const { escrowId, txHash } = await PathB.createEscrow({ seller, amount, ... });
 *   </script>
 */
(function (global) {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  const ENVS = {
    sepolia_prod: {
      label: 'Base Sepolia · Circle USDC',
      chainId: 84532,
      chainIdHex: '0x14a34',
      chainName: 'Base Sepolia',
      rpc: 'https://base-sepolia.g.alchemy.com/v2/R6R9Rai6b-PF4toEAv_kq',
      escrow: '0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC',
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      usdcSymbol: 'USDC',
      explorer: 'https://sepolia.basescan.org',
    },
    sepolia_test: {
      label: 'Base Sepolia · Mock USDC (test)',
      chainId: 84532,
      chainIdHex: '0x14a34',
      chainName: 'Base Sepolia',
      rpc: 'https://base-sepolia.g.alchemy.com/v2/R6R9Rai6b-PF4toEAv_kq',
      escrow: '0x331cE65982Dd879920fA00195e70bF77f18AB61A',
      usdc: '0xe5FC9d9D89817268b87C4ECcfd0A01CAea8c011e',
      usdcSymbol: 'mUSDC',
      explorer: 'https://sepolia.basescan.org',
    },
  };

  function getEnv() {
    const q = new URLSearchParams(location.search);
    const key = q.get('env') === 'test' ? 'sepolia_test' : 'sepolia_prod';
    return ENVS[key];
  }

  // ── ABIs ──────────────────────────────────────────────────────────────────
  const ESCROW_ABI = [
    'function createEscrow(address seller, uint256 amount, uint64 deliveryWindowSec, uint64 reviewWindowSec, string verificationURI) returns (uint256)',
    'function markDelivered(uint256 id, bytes32 deliveryHash)',
    'function confirmDelivery(uint256 id)',
    'function dispute(uint256 id, string reason)',
    'function cancelIfNotDelivered(uint256 id)',
    'function escalateIfExpired(uint256 id)',
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

  const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ];

  const STATES = ['CREATED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'RESOLVED', 'CANCELLED'];

  // Base Sepolia rejects gas estimation frequently — use fixed limits.
  const GAS = {
    approve: 80000n,
    createEscrow: 400000n,
    markDelivered: 120000n,
    confirmDelivery: 150000n,
    dispute: 150000n,
    cancel: 120000n,
    escalate: 120000n,
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let provider = null;
  let signer = null;
  let account = null;
  const env = getEnv();

  // ── Helpers ───────────────────────────────────────────────────────────────
  function readProvider() {
    return new ethers.JsonRpcProvider(env.rpc);
  }

  function escrowRead() {
    return new ethers.Contract(env.escrow, ESCROW_ABI, readProvider());
  }

  function escrowWrite() {
    if (!signer) throw new Error('Not connected. Call PathB.connect() first.');
    return new ethers.Contract(env.escrow, ESCROW_ABI, signer);
  }

  function usdcRead() {
    return new ethers.Contract(env.usdc, ERC20_ABI, readProvider());
  }

  function usdcWrite() {
    if (!signer) throw new Error('Not connected.');
    return new ethers.Contract(env.usdc, ERC20_ABI, signer);
  }

  function explorerTx(hash) { return `${env.explorer}/tx/${hash}`; }
  function explorerAddr(addr) { return `${env.explorer}/address/${addr}`; }

  async function ensureChain() {
    const currentHex = await window.ethereum.request({ method: 'eth_chainId' });
    if (currentHex.toLowerCase() !== env.chainIdHex) {
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: env.chainIdHex }],
        });
      } catch (e) {
        if (e.code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: env.chainIdHex,
              chainName: env.chainName,
              rpcUrls: [env.rpc],
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
              blockExplorerUrls: [env.explorer],
            }],
          });
        } else { throw e; }
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async function connect() {
    if (!window.ethereum) throw new Error('No wallet found. Install MetaMask or another EIP-1193 wallet.');
    await ensureChain();
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    account = accounts[0];
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    window.ethereum.on('accountsChanged', (a) => { account = a[0]; dispatchChange(); });
    window.ethereum.on('chainChanged', () => location.reload());
    dispatchChange();
    return account;
  }

  function dispatchChange() {
    document.dispatchEvent(new CustomEvent('pathb:account', { detail: { account } }));
  }

  function isConnected() { return !!account; }
  function getAccount() { return account; }
  function getEnvInfo() { return { ...env }; }

  async function getUsdcBalance(addr) {
    const usdc = usdcRead();
    const raw = await usdc.balanceOf(addr || account);
    return ethers.formatUnits(raw, 6);
  }

  async function getUsdcAllowance(owner) {
    const usdc = usdcRead();
    const raw = await usdc.allowance(owner || account, env.escrow);
    return ethers.formatUnits(raw, 6);
  }

  async function getEscrow(id) {
    const c = escrowRead();
    const e = await c.getEscrow(BigInt(id));
    return {
      id: String(id),
      buyer: e.buyer,
      seller: e.seller,
      amount: ethers.formatUnits(e.amount, 6),
      amountRaw: e.amount,
      deliveryDeadline: Number(e.deliveryDeadline),
      reviewDeadline: Number(e.reviewDeadline),
      state: STATES[Number(e.state)] || String(e.state),
      stateCode: Number(e.state),
      deliveryHash: e.deliveryHash === ethers.ZeroHash ? null : e.deliveryHash,
      verificationURI: e.verificationURI,
    };
  }

  async function getNextEscrowId() {
    const c = escrowRead();
    return Number(await c.nextEscrowId());
  }

  async function createEscrow({ seller, amount, deliveryWindowHours = 24, reviewWindowHours = 24, verificationURI }) {
    const amountWei = ethers.parseUnits(String(amount), 6);

    // Check allowance; approve if needed.
    const usdc = usdcWrite();
    const currentAllowance = await usdc.allowance(account, env.escrow);
    if (currentAllowance < amountWei) {
      const approveTx = await usdc.approve(env.escrow, amountWei, { gasLimit: GAS.approve });
      await approveTx.wait();
    }

    const c = escrowWrite();
    const tx = await c.createEscrow(
      seller,
      amountWei,
      BigInt(deliveryWindowHours * 3600),
      BigInt(reviewWindowHours * 3600),
      verificationURI,
      { gasLimit: GAS.createEscrow }
    );
    const receipt = await tx.wait();

    // Parse EscrowCreated
    const iface = c.interface;
    let escrowId = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === 'EscrowCreated') {
          escrowId = parsed.args.id.toString();
          break;
        }
      } catch (_) {}
    }
    return { escrowId, txHash: receipt.hash };
  }

  async function markDelivered({ escrowId, deliveryPayloadURI }) {
    const c = escrowWrite();
    const deliveryHash = ethers.keccak256(ethers.toUtf8Bytes(deliveryPayloadURI));
    const tx = await c.markDelivered(BigInt(escrowId), deliveryHash, { gasLimit: GAS.markDelivered });
    const r = await tx.wait();
    return { txHash: r.hash, deliveryHash };
  }

  async function confirmDelivery({ escrowId }) {
    const c = escrowWrite();
    const tx = await c.confirmDelivery(BigInt(escrowId), { gasLimit: GAS.confirmDelivery });
    const r = await tx.wait();
    return { txHash: r.hash };
  }

  async function dispute({ escrowId, reason }) {
    const c = escrowWrite();
    const tx = await c.dispute(BigInt(escrowId), reason, { gasLimit: GAS.dispute });
    const r = await tx.wait();
    return { txHash: r.hash };
  }

  async function cancelIfNotDelivered({ escrowId }) {
    const c = escrowWrite();
    const tx = await c.cancelIfNotDelivered(BigInt(escrowId), { gasLimit: GAS.cancel });
    const r = await tx.wait();
    return { txHash: r.hash };
  }

  async function listEscrowsForAddress(role, addr) {
    const target = (addr || account || '').toLowerCase();
    if (!target) return [];
    const next = await getNextEscrowId();
    const out = [];
    for (let i = 1; i < next; i++) {
      try {
        const e = await getEscrow(i);
        const matches = role === 'buyer'
          ? e.buyer.toLowerCase() === target
          : role === 'seller'
          ? e.seller.toLowerCase() === target
          : false;
        if (matches) out.push(e);
      } catch (_) {}
    }
    return out;
  }

  function formatDeadline(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    const now = Date.now();
    const diff = d.getTime() - now;
    const abs = Math.abs(diff);
    const mins = Math.floor(abs / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    let rel;
    if (days > 0) rel = `${days}d ${hours % 24}h`;
    else if (hours > 0) rel = `${hours}h ${mins % 60}m`;
    else rel = `${mins}m`;
    return diff > 0 ? `in ${rel}` : `${rel} ago`;
  }

  global.PathB = {
    connect, isConnected, getAccount, getEnvInfo,
    getUsdcBalance, getUsdcAllowance,
    getEscrow, getNextEscrowId, listEscrowsForAddress,
    createEscrow, markDelivered, confirmDelivery, dispute, cancelIfNotDelivered,
    explorerTx, explorerAddr, formatDeadline,
    STATES,
  };
})(window);
