"""
Arbitova + CrewAI Integration Example (Path B, non-custodial)

Shows how CrewAI agents pay each other through Arbitova's on-chain escrow
on Base Sepolia. This replaces the old Path A REST API version.

Three CrewAI tools wrap the Path B SDK:

- ArbitovaCreateEscrowTool  — buyer locks USDC on-chain
- ArbitovaDeliverTool        — seller hashes delivery on-chain
- ArbitovaConfirmTool        — buyer releases (or disputes) on-chain

Requirements:
    pip install crewai arbitova>=2.5.2 web3>=6

Env vars (required):
    ARBITOVA_RPC_URL            Base Sepolia RPC
    ARBITOVA_ESCROW_ADDRESS     EscrowV1 contract
    ARBITOVA_USDC_ADDRESS       USDC contract
    ARBITOVA_AGENT_PRIVATE_KEY  agent's signer (this process only)

Usage:
    python examples/crewai_integration.py --role buyer  --seller 0x... --amount 0.50
    python examples/crewai_integration.py --role seller --escrow-id 42

This is a reference. In production, buyer and seller run as separate
processes with separate keys.
"""

from __future__ import annotations

import argparse
import os
from typing import Optional

from crewai import Agent, Crew, Task
from crewai.tools import BaseTool
from pydantic import Field

from arbitova import path_b


# ----------------------------------------------------------------------------
# CrewAI tool wrappers — thin, one tool per SDK function
# ----------------------------------------------------------------------------

class ArbitovaCreateEscrowTool(BaseTool):
    name: str = "arbitova_create_escrow"
    description: str = (
        "Lock USDC in Arbitova escrow for a seller agent. Returns the "
        "escrow_id. Use this BEFORE assigning work to an untrusted agent. "
        "Inputs: seller address, amount in USDC (e.g. '0.50'), delivery "
        "window in seconds, review window in seconds, verification URI."
    )

    def _run(
        self,
        seller: str,
        amount_usdc: str,
        delivery_window_sec: int,
        review_window_sec: int,
        verification_uri: str,
    ) -> str:
        amount_atoms = int(round(float(amount_usdc) * 10**6))
        result = path_b.arbitova_create_escrow(
            seller=seller,
            amount=amount_atoms,
            delivery_window_sec=int(delivery_window_sec),
            review_window_sec=int(review_window_sec),
            verification_uri=verification_uri,
        )
        if result.get("error"):
            return f"create_escrow failed: {result['error']}"
        return (
            f"escrow_id={result['escrow_id']} "
            f"tx={result['tx_hash']} "
            f"state=CREATED locked={amount_usdc} USDC"
        )


class ArbitovaDeliverTool(BaseTool):
    name: str = "arbitova_mark_delivered"
    description: str = (
        "As the seller, hash your delivery payload on-chain to signal the "
        "buyer for review. Inputs: escrow_id, delivery_content (the exact "
        "bytes/text you are handing over — its keccak256 is stored)."
    )

    def _run(self, escrow_id: int, delivery_content: str) -> str:
        content_bytes = delivery_content.encode("utf-8")
        result = path_b.arbitova_mark_delivered(
            escrow_id=int(escrow_id),
            delivery_content_bytes=content_bytes,
        )
        if result.get("error"):
            return f"mark_delivered failed: {result['error']}"
        return (
            f"delivered escrow_id={escrow_id} "
            f"tx={result['tx_hash']} "
            f"deliveryHash={result.get('delivery_hash')}"
        )


class ArbitovaConfirmTool(BaseTool):
    name: str = "arbitova_confirm_delivery"
    description: str = (
        "As the buyer, release the escrowed funds to the seller. Call this "
        "only after you have verified delivery matches the verification "
        "criteria. Input: escrow_id."
    )

    def _run(self, escrow_id: int) -> str:
        result = path_b.arbitova_confirm_delivery(escrow_id=int(escrow_id))
        if result.get("error"):
            return f"confirm failed: {result['error']}"
        return f"released escrow_id={escrow_id} tx={result['tx_hash']}"


class ArbitovaDisputeTool(BaseTool):
    name: str = "arbitova_dispute"
    description: str = (
        "Open a dispute on an escrow. The arbiter will split funds based "
        "on verificationURI + deliveryHash. Only call when delivery does "
        "NOT match criteria. Inputs: escrow_id, reason."
    )

    def _run(self, escrow_id: int, reason: str) -> str:
        result = path_b.arbitova_dispute(escrow_id=int(escrow_id), reason=reason)
        if result.get("error"):
            return f"dispute failed: {result['error']}"
        return f"disputed escrow_id={escrow_id} tx={result['tx_hash']}"


class ArbitovaGetTool(BaseTool):
    name: str = "arbitova_get_escrow"
    description: str = (
        "Read an escrow's current state from-chain. Input: escrow_id. "
        "Returns state (CREATED/DELIVERED/RELEASED/DISPUTED/RESOLVED/CANCELLED), "
        "buyer, seller, amount, deliveryHash, verificationURI."
    )

    def _run(self, escrow_id: int) -> str:
        result = path_b.arbitova_get_escrow(escrow_id=int(escrow_id))
        if result.get("error"):
            return f"get failed: {result['error']}"
        return str(result)


# ----------------------------------------------------------------------------
# Agents
# ----------------------------------------------------------------------------

def build_buyer_crew(seller: str, amount_usdc: str, verification_uri: str) -> Crew:
    create_tool = ArbitovaCreateEscrowTool()
    confirm_tool = ArbitovaConfirmTool()
    dispute_tool = ArbitovaDisputeTool()
    get_tool = ArbitovaGetTool()

    buyer = Agent(
        role="Buyer Agent",
        goal=(
            f"Hire the seller at {seller} to deliver the work described at "
            f"{verification_uri}. Pay {amount_usdc} USDC through Arbitova. "
            "Confirm only if delivery matches the verification criteria."
        ),
        backstory=(
            "You are an autonomous buyer agent using Arbitova escrow so you "
            "do not have to trust the seller up-front. You never release "
            "funds without verifying delivery."
        ),
        tools=[create_tool, confirm_tool, dispute_tool, get_tool],
        allow_delegation=False,
    )

    return Crew(
        agents=[buyer],
        tasks=[
            Task(
                description=(
                    f"Create an Arbitova escrow for seller {seller}, amount "
                    f"{amount_usdc} USDC, delivery window 3600s, review "
                    f"window 1800s, verificationURI {verification_uri}. "
                    "Return the escrow_id."
                ),
                agent=buyer,
                expected_output="escrow_id as a number",
            ),
        ],
    )


def build_seller_crew(escrow_id: int, delivery_content: str) -> Crew:
    deliver_tool = ArbitovaDeliverTool()
    get_tool = ArbitovaGetTool()

    seller = Agent(
        role="Seller Agent",
        goal=(
            f"Deliver the agreed work for escrow {escrow_id} and hash the "
            "delivery on-chain so the buyer can review."
        ),
        backstory=(
            "You are an autonomous seller agent. You only mark_delivered "
            "when you have the actual deliverable ready."
        ),
        tools=[deliver_tool, get_tool],
        allow_delegation=False,
    )

    return Crew(
        agents=[seller],
        tasks=[
            Task(
                description=(
                    f"Read escrow {escrow_id}. If state == CREATED, call "
                    f"arbitova_mark_delivered with delivery_content: "
                    f"{delivery_content!r}"
                ),
                agent=seller,
                expected_output="tx_hash of the delivery transaction",
            ),
        ],
    )


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=["buyer", "seller"], required=True)
    parser.add_argument("--seller", help="seller address (buyer role)")
    parser.add_argument("--amount", help="USDC amount (buyer role)")
    parser.add_argument(
        "--verification-uri",
        default="https://example.com/task.md",
        help="verification URI (buyer role)",
    )
    parser.add_argument("--escrow-id", type=int, help="escrow id (seller role)")
    parser.add_argument(
        "--delivery",
        default="delivery payload bytes",
        help="delivery content to hash on-chain (seller role)",
    )
    args = parser.parse_args()

    for key in (
        "ARBITOVA_RPC_URL",
        "ARBITOVA_ESCROW_ADDRESS",
        "ARBITOVA_USDC_ADDRESS",
        "ARBITOVA_AGENT_PRIVATE_KEY",
    ):
        if not os.environ.get(key):
            raise SystemExit(f"missing env var: {key}")

    if args.role == "buyer":
        if not args.seller or not args.amount:
            raise SystemExit("buyer role needs --seller and --amount")
        crew = build_buyer_crew(args.seller, args.amount, args.verification_uri)
    else:
        if args.escrow_id is None:
            raise SystemExit("seller role needs --escrow-id")
        crew = build_seller_crew(args.escrow_id, args.delivery)

    result = crew.kickoff()
    print(result)


if __name__ == "__main__":
    main()
