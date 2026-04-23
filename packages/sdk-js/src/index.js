// Arbitova SDK — public API.
// Wraps EscrowV1 on Base for agent developers. No API keys, no registration.
//
// Usage (private key):
//   import { Arbitova } from '@arbitova/sdk';
//   const client = await Arbitova.fromPrivateKey({ privateKey: process.env.AGENT_PK });
//   const id = await client.createEscrow({ seller, amount: '5.00', deliveryHours: 24, reviewHours: 24 });
//
// Usage (browser wallet):
//   const client = await Arbitova.fromWallet(window.ethereum);
//   await client.confirmDelivery(id);

import {
  Contract,
  JsonRpcProvider,
  BrowserProvider,
  Wallet,
  parseUnits,
  formatUnits,
  keccak256,
  toUtf8Bytes,
} from 'ethers';
import {
  NETWORKS,
  DEFAULT_NETWORK,
  ESCROW_ABI,
  ERC20_ABI,
  STATES,
  GAS_LIMITS,
} from './constants.js';

export { NETWORKS, STATES, ESCROW_ABI, ERC20_ABI };

function netConfig(network) {
  const cfg = NETWORKS[network];
  if (!cfg) throw new Error(`Unknown network: ${network}. Known: ${Object.keys(NETWORKS).join(', ')}`);
  return cfg;
}

export class Arbitova {
  constructor({ network = DEFAULT_NETWORK, provider, signer }) {
    this.network = network;
    this.net = netConfig(network);
    this.provider = provider;
    this.signer = signer;
    this.escrowRead = new Contract(this.net.escrow, ESCROW_ABI, provider);
    this.usdcRead = new Contract(this.net.usdc, ERC20_ABI, provider);
    if (signer) {
      this.escrowWrite = new Contract(this.net.escrow, ESCROW_ABI, signer);
      this.usdcWrite = new Contract(this.net.usdc, ERC20_ABI, signer);
    }
  }

  static async fromPrivateKey({ privateKey, network = DEFAULT_NETWORK, rpcUrl }) {
    const net = netConfig(network);
    const provider = new JsonRpcProvider(rpcUrl || net.rpc);
    const signer = new Wallet(privateKey, provider);
    return new Arbitova({ network, provider, signer });
  }

  static async fromWallet(ethereum, { network = DEFAULT_NETWORK } = {}) {
    if (!ethereum) throw new Error('No EIP-1193 provider (window.ethereum) supplied.');
    const net = netConfig(network);
    const cidHex = await ethereum.request({ method: 'eth_chainId' });
    if (cidHex.toLowerCase() !== net.chainIdHex) {
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: net.chainIdHex }],
      }).catch(async (e) => {
        if (e.code === 4902) {
          await ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: net.chainIdHex,
              chainName: net.chainName,
              rpcUrls: [net.rpc],
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
              blockExplorerUrls: [net.explorer],
            }],
          });
        } else { throw e; }
      });
    }
    await ethereum.request({ method: 'eth_requestAccounts' });
    const provider = new BrowserProvider(ethereum);
    const signer = await provider.getSigner();
    return new Arbitova({ network, provider, signer });
  }

  static async fromReadOnly({ network = DEFAULT_NETWORK, rpcUrl } = {}) {
    const net = netConfig(network);
    const provider = new JsonRpcProvider(rpcUrl || net.rpc);
    return new Arbitova({ network, provider });
  }

  requireSigner() {
    if (!this.signer) throw new Error('Client is read-only. Use Arbitova.fromPrivateKey or fromWallet to sign transactions.');
  }

  async address() {
    this.requireSigner();
    return this.signer.getAddress();
  }

  // ── Balances & allowances ────────────────────────────────────────────────

  async getUsdcBalance(addr) {
    const a = addr || (await this.address());
    const raw = await this.usdcRead.balanceOf(a);
    return formatUnits(raw, this.net.usdcDecimals);
  }

  async getUsdcAllowance(owner) {
    const a = owner || (await this.address());
    const raw = await this.usdcRead.allowance(a, this.net.escrow);
    return formatUnits(raw, this.net.usdcDecimals);
  }

  async approveUsdc(amount) {
    this.requireSigner();
    const raw = parseUnits(String(amount), this.net.usdcDecimals);
    const tx = await this.usdcWrite.approve(this.net.escrow, raw, { gasLimit: GAS_LIMITS.approve });
    return tx.wait();
  }

  // ── Escrow — write ───────────────────────────────────────────────────────

  /**
   * Lock `amount` USDC on behalf of the signer (buyer) against `seller`.
   *
   * Dispute publicity: if this escrow later enters DISPUTED and is
   * resolved by Arbitova arbitration, the verdict, reasoning, ensemble
   * vote breakdown, and any internal re-audit result will be published
   * per-case at https://arbitova.com/verdicts. The delivery payload is
   * NOT published (only its keccak256 hash). The buyer/seller wallet
   * addresses are already public on-chain. By calling createEscrow you
   * accept this disclosure on behalf of your agent/principal. See
   * docs/transparency-policy.md for the full commitment.
   */
  async createEscrow({ seller, amount, deliveryHours = 24, reviewHours = 24, verificationURI = '' }) {
    this.requireSigner();
    if (!/^0x[a-fA-F0-9]{40}$/.test(seller)) throw new Error('Invalid seller address.');
    const raw = parseUnits(String(amount), this.net.usdcDecimals);

    const allow = await this.usdcRead.allowance(await this.address(), this.net.escrow);
    if (allow < raw) await this.approveUsdc(amount);

    const tx = await this.escrowWrite.createEscrow(
      seller,
      raw,
      BigInt(deliveryHours) * 3600n,
      BigInt(reviewHours) * 3600n,
      verificationURI,
      { gasLimit: GAS_LIMITS.createEscrow },
    );
    const rc = await tx.wait();
    const evt = rc.logs
      .map((l) => { try { return this.escrowRead.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === 'EscrowCreated');
    if (!evt) throw new Error('EscrowCreated event not found in receipt.');
    return {
      escrowId: evt.args.id.toString(),
      txHash: rc.hash,
      buyer: evt.args.buyer,
      seller: evt.args.seller,
      amount: formatUnits(evt.args.amount, this.net.usdcDecimals),
      deliveryDeadline: Number(evt.args.deliveryDeadline),
      verificationURI: evt.args.verificationURI,
    };
  }

  async markDelivered({ escrowId, deliveryPayloadURI }) {
    this.requireSigner();
    if (!deliveryPayloadURI) throw new Error('deliveryPayloadURI is required.');
    const deliveryHash = keccak256(toUtf8Bytes(deliveryPayloadURI));
    const tx = await this.escrowWrite.markDelivered(BigInt(escrowId), deliveryHash, { gasLimit: GAS_LIMITS.markDelivered });
    const rc = await tx.wait();
    return { txHash: rc.hash, deliveryHash };
  }

  async confirmDelivery(escrowId) {
    this.requireSigner();
    const tx = await this.escrowWrite.confirmDelivery(BigInt(escrowId), { gasLimit: GAS_LIMITS.confirmDelivery });
    const rc = await tx.wait();
    return { txHash: rc.hash };
  }

  async dispute(escrowId, reason = '') {
    this.requireSigner();
    const tx = await this.escrowWrite.dispute(BigInt(escrowId), reason, { gasLimit: GAS_LIMITS.dispute });
    const rc = await tx.wait();
    return { txHash: rc.hash };
  }

  async cancelIfNotDelivered(escrowId) {
    this.requireSigner();
    const tx = await this.escrowWrite.cancelIfNotDelivered(BigInt(escrowId), { gasLimit: GAS_LIMITS.cancelIfNotDelivered });
    const rc = await tx.wait();
    return { txHash: rc.hash };
  }

  async escalateIfExpired(escrowId) {
    this.requireSigner();
    const tx = await this.escrowWrite.escalateIfExpired(BigInt(escrowId), { gasLimit: GAS_LIMITS.escalateIfExpired });
    const rc = await tx.wait();
    return { txHash: rc.hash };
  }

  // Arbiter-only. Must be called from the arbiter wallet configured on the contract.
  // buyerBps + sellerBps must sum to exactly 10000 (100%). verdictHash is a bytes32
  // commitment to the full arbitration reasoning (e.g. keccak256 of a JSON verdict).
  // Accepts verdictHash as 0x-hex string or a pre-hashed URI via Arbitova.keccakURI().
  async resolve({ escrowId, buyerBps, sellerBps, verdictHash }) {
    this.requireSigner();
    const b = Number(buyerBps);
    const s = Number(sellerBps);
    if (!Number.isInteger(b) || !Number.isInteger(s) || b < 0 || s < 0 || b > 10000 || s > 10000) {
      throw new Error('buyerBps and sellerBps must be integers in [0, 10000].');
    }
    if (b + s !== 10000) throw new Error(`buyerBps + sellerBps must equal 10000 (got ${b + s}).`);
    if (typeof verdictHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(verdictHash)) {
      throw new Error('verdictHash must be a 0x-prefixed 32-byte hex string.');
    }
    const tx = await this.escrowWrite.resolve(
      BigInt(escrowId), b, s, verdictHash,
      { gasLimit: GAS_LIMITS.resolve },
    );
    const rc = await tx.wait();
    return { txHash: rc.hash };
  }

  // ── Escrow — read ────────────────────────────────────────────────────────

  async getEscrow(escrowId) {
    const e = await this.escrowRead.getEscrow(BigInt(escrowId));
    return {
      id: String(escrowId),
      buyer: e.buyer,
      seller: e.seller,
      amount: formatUnits(e.amount, this.net.usdcDecimals),
      deliveryDeadline: Number(e.deliveryDeadline),
      reviewDeadline: Number(e.reviewDeadline),
      reviewWindowSec: Number(e.reviewWindowSec),
      state: STATES[Number(e.state)],
      deliveryHash: e.deliveryHash,
      verificationURI: e.verificationURI,
    };
  }

  async nextEscrowId() {
    const n = await this.escrowRead.nextEscrowId();
    return Number(n);
  }

  async listEscrowsForAddress(role, addr) {
    if (!['buyer', 'seller'].includes(role)) throw new Error("role must be 'buyer' or 'seller'");
    const a = (addr || (await this.address())).toLowerCase();
    const next = await this.nextEscrowId();
    const out = [];
    for (let i = 1; i < next; i++) {
      const e = await this.getEscrow(i);
      if (e[role].toLowerCase() === a) out.push(e);
    }
    return out;
  }

  // ── Event subscription (via contract.on) ────────────────────────────────

  onEscrowCreated(cb) { return this.escrowRead.on('EscrowCreated', (id, buyer, seller, amount, deadline, uri, ev) =>
    cb({ id: id.toString(), buyer, seller, amount: formatUnits(amount, this.net.usdcDecimals), deliveryDeadline: Number(deadline), verificationURI: uri, log: ev.log })); }
  onDelivered(cb) { return this.escrowRead.on('Delivered', (id, hash, deadline, ev) =>
    cb({ id: id.toString(), deliveryHash: hash, reviewDeadline: Number(deadline), log: ev.log })); }
  onReleased(cb) { return this.escrowRead.on('Released', (id, toSeller, fee, ev) =>
    cb({ id: id.toString(), toSeller: formatUnits(toSeller, this.net.usdcDecimals), fee: formatUnits(fee, this.net.usdcDecimals), log: ev.log })); }
  onDisputed(cb) { return this.escrowRead.on('Disputed', (id, by, reason, ev) =>
    cb({ id: id.toString(), by, reason, log: ev.log })); }
  onResolved(cb) { return this.escrowRead.on('Resolved', (id, toBuyer, toSeller, fee, verdictHash, ev) =>
    cb({ id: id.toString(), toBuyer: formatUnits(toBuyer, this.net.usdcDecimals), toSeller: formatUnits(toSeller, this.net.usdcDecimals), fee: formatUnits(fee, this.net.usdcDecimals), verdictHash, log: ev.log })); }
  onCancelled(cb) { return this.escrowRead.on('Cancelled', (id, ev) =>
    cb({ id: id.toString(), log: ev.log })); }

  // ── Utils ────────────────────────────────────────────────────────────────

  explorerTx(hash) { return `${this.net.explorer}/tx/${hash}`; }
  explorerAddr(addr) { return `${this.net.explorer}/address/${addr}`; }

  static keccakURI(uri) { return keccak256(toUtf8Bytes(uri)); }
}
