"""
Arbitova + Coinbase CDP — buyer-side demo (v0.1-alpha).

Runs a full escrow lifecycle from a CDP-managed account:

    create_escrow → (seller marks delivered off-demo) → confirm_delivery

Prerequisites:
    pip install arbitova coinbase-cdp-sdk

Environment:
    CDP_API_KEY_NAME        — your CDP API key name
    CDP_API_KEY_PRIVATE     — your CDP API key private key (PEM or hex)
    CDP_ACCOUNT_ID          — target account inside your CDP project

    ARBITOVA_ESCROW_ADDRESS — default: deployed Sepolia escrow
    ARBITOVA_USDC_ADDRESS   — default: Circle Sepolia USDC
    SELLER_ADDRESS          — receiver of the escrow

Run:
    python cdp_buyer_demo.py --amount 0.10 --seller 0x...

This is a demo, not a test. It expects the CDP account to already
hold test USDC and Sepolia ETH for gas (CDP faucet on base-sepolia).
"""

import argparse
import os
import sys
import time

try:
    from arbitova.cdp_adapter import CdpEscrowClient, CdpNotInstalled
except ImportError as exc:
    print(
        "Install the SDK first: `pip install arbitova`.\n"
        f"Underlying error: {exc}"
    )
    sys.exit(1)


DEFAULT_ESCROW = "0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC"
DEFAULT_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
DEFAULT_RPC = "https://sepolia.base.org"


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"Missing required env var: {name}")
        sys.exit(2)
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description="Arbitova CDP buyer demo.")
    parser.add_argument("--seller", default=os.environ.get("SELLER_ADDRESS"))
    parser.add_argument("--amount", type=float, default=0.10,
                        help="USDC amount (human-readable).")
    parser.add_argument("--delivery-window", type=int, default=3600)
    parser.add_argument("--review-window", type=int, default=86400)
    parser.add_argument(
        "--verification-uri", default="ipfs://demo-spec.json",
        help="URI the seller will fulfil; included in the on-chain event.",
    )
    args = parser.parse_args()

    if not args.seller:
        print("--seller is required (or set SELLER_ADDRESS).")
        sys.exit(2)

    try:
        client = CdpEscrowClient(
            cdp_api_key=_require_env("CDP_API_KEY_NAME"),
            cdp_api_secret=_require_env("CDP_API_KEY_PRIVATE"),
            cdp_account_id=_require_env("CDP_ACCOUNT_ID"),
            rpc_url=os.environ.get("ARBITOVA_RPC_URL", DEFAULT_RPC),
            escrow_address=os.environ.get(
                "ARBITOVA_ESCROW_ADDRESS", DEFAULT_ESCROW
            ),
            usdc_address=os.environ.get(
                "ARBITOVA_USDC_ADDRESS", DEFAULT_USDC
            ),
        )
    except CdpNotInstalled as exc:
        print(f"coinbase-cdp-sdk is required for this demo: {exc}")
        sys.exit(3)

    print("=== Arbitova CDP buyer demo ===")
    print(f"Seller:              {args.seller}")
    print(f"Amount:              {args.amount} USDC")
    print(f"Delivery window:     {args.delivery_window}s")
    print(f"Review window:       {args.review_window}s")
    print(f"Verification URI:    {args.verification_uri}")
    print()

    print("[1/3] Approving USDC + creating escrow via CDP ...")
    t0 = time.time()
    escrow_id = client.create_escrow(
        seller=args.seller,
        amount_usdc=args.amount,
        delivery_window_sec=args.delivery_window,
        review_window_sec=args.review_window,
        verification_uri=args.verification_uri,
    )
    print(f"       escrow id: {escrow_id}  "
          f"(elapsed {time.time() - t0:.1f}s)")
    print()

    print("[2/3] Fetching on-chain state (read path, bypasses CDP) ...")
    snapshot = client.get_escrow(escrow_id)
    print(f"       state: {snapshot.get('state')}")
    print(f"       buyer: {snapshot.get('buyer')}")
    print(f"       seller: {snapshot.get('seller')}")
    print(f"       amount: {snapshot.get('amount')}")
    print()

    print("[3/3] Pausing for seller-side delivery.")
    print("       → run seller_demo.js (or any MCP-compatible seller) "
          f"against escrow id {escrow_id}")
    print("       → then rerun this script with --confirm to release funds.")

    if "--confirm" in sys.argv:
        client.confirm_delivery(escrow_id)
        print(f"       confirmDelivery() sent for id {escrow_id}.")


if __name__ == "__main__":
    main()
