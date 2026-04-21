"""
Arbitova Path B — AutoGen Buyer Agent Demo

Demonstrates an AutoGen agent using Arbitova Path B tool definitions to:
  1. Create an on-chain escrow for a writing task
  2. Wait for seller delivery (polled via arbitova_get_escrow)
  3. Verify delivery against the criteria in verificationURI
  4. Confirm if all criteria pass, or dispute with a specific reason if any fail

REQUIRED ENV VARS:
    ARBITOVA_RPC_URL           -- e.g. https://sepolia.base.org
    ARBITOVA_ESCROW_ADDRESS    -- deployed EscrowV1 address (<FILL_IN_AFTER_DEPLOY>)
    ARBITOVA_USDC_ADDRESS      -- USDC token address
    ARBITOVA_AGENT_PRIVATE_KEY -- Buyer wallet private key (0x-prefixed)
    OPENAI_API_KEY             -- Required by AutoGen for LLM calls
    SELLER_ADDRESS             -- Seller Ethereum address

HOW TO RUN:
    pip install pyautogen web3
    python examples/path_b/autogen_buyer.py

EXPECTED OUTPUT:
    [AutoGen] Starting buyer agent session...
    [buyer_agent] I will create an escrow for the writing task...
    [Tool: arbitova_create_escrow] -> {ok: true, escrow_id: 1, ...}
    [buyer_agent] Escrow 1 created. Waiting for seller delivery...
    ... (polls until DELIVERED) ...
    [Tool: arbitova_get_escrow] -> {status: "DELIVERED", ...}
    [buyer_agent] Fetching delivery payload and verification criteria...
    [buyer_agent] Criterion 1 passed. Criterion 2 passed. All criteria satisfied.
    [Tool: arbitova_confirm_delivery] -> {ok: true, tx_hash: "0x..."}
    [buyer_agent] Delivery confirmed. Task complete.
"""

import os
import json
import time
import asyncio
from typing import Any, Dict

# ── Try importing AutoGen (graceful degradation for demo) ─────────────────────
try:
    import autogen
    from autogen import AssistantAgent, UserProxyAgent, register_function
    _AUTOGEN_AVAILABLE = True
except ImportError:
    _AUTOGEN_AVAILABLE = False
    print("NOTE: autogen package not installed. Install with: pip install pyautogen")
    print("Running in STUB mode — showing what the agent would do.\n")

# Path B SDK tools
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'python-sdk'))
from arbitova.path_b import (
    arbitova_create_escrow,
    arbitova_mark_delivered,
    arbitova_confirm_delivery,
    arbitova_dispute,
    arbitova_get_escrow,
    arbitova_cancel_if_not_delivered,
    get_tool_definitions,
)

# ── Config ───────────────────────────────────────────────────────────────────

SELLER_ADDRESS = os.environ.get("SELLER_ADDRESS", "0x0000000000000000000000000000000000000001")
VERIFICATION_URI = "https://example.com/criteria/writing-task-001.json"

# The task the buyer wants the seller to perform
TASK_DESCRIPTION = """
You are a buyer agent. Your goal is to:

1. Create an on-chain escrow with:
   - seller = {seller}
   - amount = 10 USDC
   - delivery_window_hours = 24
   - review_window_hours = 24
   - verification_uri = {verification_uri}

2. Poll arbitova_get_escrow every 30 seconds until status = DELIVERED.

3. When DELIVERED:
   - The delivery_payload_uri will be in the escrow notes (for demo, use "https://example.com/delivery/001.md")
   - Fetch the verification criteria from verification_uri
   - Fetch the delivery content from delivery_payload_uri
   - Check each criterion against the delivery

4. If ALL criteria pass: call arbitova_confirm_delivery.
   If ANY criterion fails or is unclear: call arbitova_dispute with a specific reason
   citing the exact criterion text and what you observed.

Remember: When in doubt about delivery quality, DISPUTE — do not confirm.
Silence is safer than a wrong confirmation.
""".format(seller=SELLER_ADDRESS, verification_uri=VERIFICATION_URI)


# ── Tool wrappers for AutoGen (synchronous, JSON-serializable returns) ─────────

def tool_create_escrow(seller: str, amount: float, verification_uri: str,
                       delivery_window_hours: int = 24, review_window_hours: int = 24) -> str:
    result = arbitova_create_escrow(
        seller=seller,
        amount=amount,
        delivery_window_hours=delivery_window_hours,
        review_window_hours=review_window_hours,
        verification_uri=verification_uri,
    )
    return json.dumps(result)


def tool_get_escrow(escrow_id: int) -> str:
    result = arbitova_get_escrow(escrow_id=escrow_id)
    return json.dumps(result)


def tool_confirm_delivery(escrow_id: int) -> str:
    result = arbitova_confirm_delivery(escrow_id=escrow_id)
    return json.dumps(result)


def tool_dispute(escrow_id: int, reason: str) -> str:
    result = arbitova_dispute(escrow_id=escrow_id, reason=reason)
    return json.dumps(result)


def tool_cancel_if_not_delivered(escrow_id: int) -> str:
    result = arbitova_cancel_if_not_delivered(escrow_id=escrow_id)
    return json.dumps(result)


# ── AutoGen agent setup ───────────────────────────────────────────────────────

def run_autogen_agent():
    """Run the buyer agent using AutoGen with Path B tool definitions."""
    if not _AUTOGEN_AVAILABLE:
        print("AutoGen not available. Install with: pip install pyautogen")
        run_stub_demo()
        return

    openai_key = os.environ.get("OPENAI_API_KEY")
    if not openai_key:
        print("OPENAI_API_KEY not set. Running stub demo instead.")
        run_stub_demo()
        return

    llm_config = {
        "config_list": [{"model": "gpt-4o", "api_key": openai_key}],
        "tools": get_tool_definitions(),  # Path B OpenAI-style schemas
    }

    buyer_agent = AssistantAgent(
        name="buyer_agent",
        system_message=(
            "You are an Arbitova buyer agent operating on-chain. "
            "You use the provided tools to create escrows and verify deliveries. "
            "CRITICAL SAFETY RULE: Never call arbitova_confirm_delivery unless you have "
            "fetched the delivery payload, read every criterion from verification_uri, "
            "and verified each one passes. If ANYTHING is uncertain, call arbitova_dispute. "
            "Silence is safer than a wrong confirmation."
        ),
        llm_config=llm_config,
    )

    proxy = UserProxyAgent(
        name="user_proxy",
        human_input_mode="NEVER",
        max_consecutive_auto_reply=20,
        code_execution_config=False,
    )

    # Register tools with the proxy (executor)
    register_function(tool_create_escrow, caller=buyer_agent, executor=proxy,
                      name="arbitova_create_escrow",
                      description="Create on-chain escrow. See tool schema for safety rules.")
    register_function(tool_get_escrow, caller=buyer_agent, executor=proxy,
                      name="arbitova_get_escrow",
                      description="Get escrow state.")
    register_function(tool_confirm_delivery, caller=buyer_agent, executor=proxy,
                      name="arbitova_confirm_delivery",
                      description="Confirm delivery ONLY after verifying ALL criteria.")
    register_function(tool_dispute, caller=buyer_agent, executor=proxy,
                      name="arbitova_dispute",
                      description="Open dispute when delivery fails or is uncertain.")
    register_function(tool_cancel_if_not_delivered, caller=buyer_agent, executor=proxy,
                      name="arbitova_cancel_if_not_delivered",
                      description="Cancel escrow after delivery deadline if seller did not deliver.")

    print("[AutoGen] Starting buyer agent session...")
    proxy.initiate_chat(buyer_agent, message=TASK_DESCRIPTION)


# ── Stub demo (runs without AutoGen / real network) ──────────────────────────

def run_stub_demo():
    """
    Demonstrates the buyer verification logic without a live network.
    Shows what the agent *would* do step by step.
    """
    print("=" * 60)
    print("STUB DEMO — Buyer Verification Logic")
    print("=" * 60)

    # Simulated escrow state after delivery
    mock_escrow = {
        "ok": True,
        "escrow_id": "1",
        "buyer": "0xBUYER",
        "seller": SELLER_ADDRESS,
        "amount_usdc": 10.0,
        "status": "DELIVERED",
        "verification_uri": VERIFICATION_URI,
        "delivery_hash": "0xabc123",
    }

    # Simulated criteria
    criteria = [
        {"id": 1, "text": "word count >= 500"},
        {"id": 2, "text": "includes executive summary section"},
    ]

    # Simulated delivery text (one good, one bad for demonstration)
    delivery_text = "Short delivery. Missing executive summary."  # Deliberately fails

    print(f"\n[Stub] Escrow state: {json.dumps(mock_escrow, indent=2)}")
    print(f"\n[Stub] Verification criteria: {criteria}")
    print(f"\n[Stub] Delivery content snippet: '{delivery_text[:80]}...'")

    failures = []
    for c in criteria:
        if "word count" in c["text"]:
            wc = len(delivery_text.split())
            req = int(c["text"].split(">=")[1].strip())
            passed = wc >= req
            observed = f"word count = {wc}, required >= {req}"
        elif "executive summary" in c["text"]:
            passed = "executive summary" in delivery_text.lower()
            observed = "section found" if passed else "section absent"
        else:
            passed = False
            observed = "unknown criterion"

        status = "PASS" if passed else "FAIL"
        print(f"[Stub] Criterion {c['id']}: '{c['text']}' -> {status} ({observed})")
        if not passed:
            failures.append({"criterion": c, "observed": observed})

    if not failures:
        print("\n[Stub] All criteria passed. Would call: arbitova_confirm_delivery(escrow_id=1)")
    else:
        reason_parts = [
            f"Criterion {f['criterion']['id']} not met: spec='{f['criterion']['text']}', observed='{f['observed']}'"
            for f in failures
        ]
        reason = ". ".join(reason_parts)
        print(f"\n[Stub] {len(failures)} failure(s). Would call: arbitova_dispute(escrow_id=1, reason='{reason}')")

    print("\n[Stub] Demo complete. Run with real env vars and AutoGen for live on-chain execution.")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if _AUTOGEN_AVAILABLE and os.environ.get("OPENAI_API_KEY") and os.environ.get("ARBITOVA_RPC_URL"):
        run_autogen_agent()
    else:
        run_stub_demo()
