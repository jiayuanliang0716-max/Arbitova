# EscrowV1 Deployment Guide

## Prerequisites

- Foundry installed (`~/.foundry/bin` on PATH)
- `.env` file at `contracts/.env` with all required vars (see below)
- ETH in the deployer wallet for gas

## Required `.env` variables

```
PRIVATE_KEY=0x...          # deployer private key
USDC_BASE_SEPOLIA=0x...    # USDC token address on target chain
ARBITER_ADDRESS=0x...      # arbiter EOA or multisig
FEE_RECIPIENT=0x...        # fee recipient address
BASE_SEPOLIA_RPC_URL=...   # RPC endpoint
```

---

## Deploy to Base Sepolia (testnet)

Requires ETH from the Base Sepolia faucet: https://faucet.base.org

```bash
cd contracts
source .env

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast \
  --verify \
  --verifier etherscan \
  --etherscan-api-key "$BASESCAN_API_KEY" \
  -vvv
```

The deployed address is logged as `EscrowV1 deployed at: 0x...`

---

## Deploy to Base Mainnet

First set mainnet vars in `.env`:
```
MAINNET_RPC_URL=https://mainnet.base.org   # or Alchemy/Infura
USDC_BASE_MAINNET=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

Then:
```bash
cd contracts
source .env

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$MAINNET_RPC_URL" \
  --broadcast \
  --verify \
  --verifier etherscan \
  --etherscan-api-key "$BASESCAN_API_KEY" \
  -vvv
```

Note: You must set `USDC_BASE_SEPOLIA` to the mainnet USDC address before running
(the env var name is reused by the deploy script for both environments).

---

## Post-deploy contract verification

If `--verify` flag did not work during deploy (e.g. API key missing), verify manually:

```bash
forge verify-contract <DEPLOYED_ADDRESS> \
  src/EscrowV1.sol:EscrowV1 \
  --chain-id 84532 \
  --etherscan-api-key "$BASESCAN_API_KEY" \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" \
    "$USDC_BASE_SEPOLIA" "$ARBITER_ADDRESS" "$FEE_RECIPIENT") \
  --verifier etherscan
```

For mainnet (chain-id 8453):
```bash
forge verify-contract <DEPLOYED_ADDRESS> \
  src/EscrowV1.sol:EscrowV1 \
  --chain-id 8453 \
  --etherscan-api-key "$BASESCAN_API_KEY" \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" \
    "$USDC_BASE_MAINNET" "$ARBITER_ADDRESS" "$FEE_RECIPIENT") \
  --verifier etherscan
```

---

## Dry-run (simulate without submitting)

Omit `--broadcast` to simulate only:

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  -vv
```

---

## Gas estimate (from Sepolia dry-run)

- Estimated gas: ~2,381,645
- At 0.013 gwei: ~0.000031 ETH
- One faucet drip (0.1 ETH on Base Sepolia) is more than sufficient.

---

## Local Anvil test

```bash
# Start Anvil
anvil --port 8545 --chain-id 31337

# Run full E2E flows 1+2
forge script script/LocalE2E.s.sol:LocalE2E \
  --rpc-url http://localhost:8545 \
  --broadcast -vv
```
