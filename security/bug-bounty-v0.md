# Arbitova Bug Bounty Program — v0 (draft for Immunefi submission)

**Status:** draft — published before Immunefi listing and mainnet deploy so that responsible researchers have a contact path today.
**Last updated:** 2026-04-22
**Scope launch target:** within 14 days of `EscrowV1` mainnet deploy on Base (blocked on external audit).

---

## 1. Assets in scope

### Smart contracts (primary)
- `EscrowV1` on Base mainnet (address published at launch)
- `EscrowV1` on Base Sepolia — `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC` — for proof-of-concept only, bounty paid in USDC on mainnet equivalent severity

### Off-chain components (secondary)
- `arbitova.com` (Node.js backend on Render)
- `@arbitova/sdk` on npm
- Arbiter agent key handling + verdict signing pipeline
- Daily reconcile cron (ledger vs. on-chain balance drift)

### Explicitly out of scope
- Third-party RPC providers (Alchemy, Coinbase Developer Platform, public Base RPC)
- Third-party UI libs (ethers.js, swagger-ui-express, etc.) — report upstream
- Cloudflare / Render infrastructure
- Social engineering, physical access, phishing of any Arbitova team member
- Denial of service via gas exhaustion on the public testnet
- Issues requiring a compromised user private key or seed phrase
- Anything already documented in `spec/A2A-ESCROW-RFC-v0.1.md` under "Open Questions"

## 2. Severity and payouts

Payouts are planned at the following levels, indexed to Immunefi's standard severity classification. Final numbers will be set at program launch after the first external audit completes.

| Severity | Definition (Arbitova-specific) | Target payout (USD) |
|---|---|---|
| **Critical** | Direct theft of user funds held in any active escrow; permanent freezing of any active escrow's funds; bypass of the arbiter allow-list to resolve a dispute as a non-arbiter; minting / burning of the platform fee beyond the 0.5% / 2% rates. | Up to $50,000 |
| **High** | Theft of fee balance only; forcing an escrow into an invalid state transition (e.g., RELEASED → DISPUTED); replay of a signed arbiter verdict across two escrows. | Up to $10,000 |
| **Medium** | Griefing that locks specific escrows without theft (e.g., making `confirmDelivery` always revert for a specific victim); leakage of private arbiter verdict reasoning before the on-chain event. | Up to $2,500 |
| **Low** | Incorrect event emission, incorrect fee rounding within `≤1 wei USDC`, UI XSS on non-authenticated pages. | Up to $500 |

Informational findings are not paid but are credited in the post-launch security retrospective if the reporter wants.

All payouts are in USDC on Base mainnet, paid within 14 days of triage + fix + mutual verification.

## 3. Rules of engagement

- **Test only against Sepolia.** Proof-of-concept exploits against mainnet contracts are not eligible for bounty and may void the reward.
- **Do not exfiltrate user data.** If you discover it's possible, stop and report.
- **Do not target the arbiter keys, admin keys, or any key material directly.** Report the attack vector, not the keys.
- **One report per vulnerability.** Duplicates pay the first valid reporter.
- **Public disclosure only after fix + 30 days.** Coordinate with us.

## 4. What a good report looks like

- Clear, minimal repro against Sepolia — ideally a hardhat/foundry test that demonstrates the invariant break.
- Reference to the specific invariant broken, citing either the contract source or `spec/A2A-ESCROW-RFC-v0.1.md`.
- Suggested severity with reasoning.
- No requirement to suggest a fix; we handle that.

## 5. Known issues (already disclosed, not eligible)

- **Arbiter centralization.** Arbitration v1 uses a small allow-list. This is intended; future versions will move to stake-based resolution.
- **Admin key is a single EOA.** Mainnet deploy is gated on rotation to multisig — report anything *beyond* "it's a single key."
- **`verificationURI` is off-chain and mutable by the seller's hosting.** This is intentional; integrity is via `keccak256(URI)` commitment, not content availability.
- **Daily reconcile cron is the only balance-drift detector.** We know. Hardening planned post-audit.

## 6. How to report

Until the Immunefi listing is live:
- Email `security@arbitova.com` (or `jiayuanliang0716@gmail.com` until the alias is live)
- PGP key: to be published at `arbitova.com/.well-known/security.txt` at program launch
- Encrypted channel via Keybase / Signal on request

We aim to acknowledge receipt within 48 hours and deliver initial triage within 7 days.

## 7. Safe harbor

If you follow the rules above — testing on Sepolia only, no data exfiltration, no extortion, coordinated disclosure — we will not pursue legal action for good-faith research, and we will credit you publicly unless you request anonymity.

---

*This draft will be submitted to Immunefi as the basis of the listing. Comments and improvements welcome at `security@arbitova.com`.*
