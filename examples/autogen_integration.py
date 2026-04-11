"""
Arbitova + AutoGen Integration Example

Shows how AutoGen agents use Arbitova for safe A2A escrow payments.
A buyer agent hires a seller agent via escrow; delivery triggers auto-verification
or AI arbitration if disputed.

Requirements:
    pip install pyautogen arbitova

Usage:
    ARBITOVA_BUYER_KEY=<key> ARBITOVA_SELLER_KEY=<key> python autogen_integration.py
"""

import os
import json
import httpx
from autogen import ConversableAgent, UserProxyAgent, register_function

ARBITOVA_BASE = "https://a2a-system.onrender.com/api/v1"
BUYER_KEY = os.environ.get("ARBITOVA_BUYER_KEY", "")
SELLER_KEY = os.environ.get("ARBITOVA_SELLER_KEY", "")


# ─── Arbitova tool functions ────────────────────────────────────────────────

def create_order(service_id: str, requirements: str) -> dict:
    """Create an escrow order. Locks funds until delivery is confirmed."""
    resp = httpx.post(
        f"{ARBITOVA_BASE}/orders",
        json={"service_id": service_id, "requirements": requirements},
        headers={"X-API-Key": BUYER_KEY},
        timeout=30,
    )
    return resp.json()


def deliver_order(order_id: str, content: str) -> dict:
    """Seller submits completed work as delivery."""
    resp = httpx.post(
        f"{ARBITOVA_BASE}/orders/{order_id}/deliver",
        json={"content": content},
        headers={"X-API-Key": SELLER_KEY},
        timeout=30,
    )
    return resp.json()


def confirm_order(order_id: str) -> dict:
    """Buyer confirms delivery and releases funds to seller."""
    resp = httpx.post(
        f"{ARBITOVA_BASE}/orders/{order_id}/confirm",
        headers={"X-API-Key": BUYER_KEY},
        timeout=30,
    )
    return resp.json()


def dispute_order(order_id: str, reason: str) -> dict:
    """Buyer disputes delivery. Triggers N=3 AI arbitration."""
    resp = httpx.post(
        f"{ARBITOVA_BASE}/orders/{order_id}/dispute",
        json={"reason": reason},
        headers={"X-API-Key": BUYER_KEY},
        timeout=30,
    )
    return resp.json()


def run_arbitration(order_id: str) -> dict:
    """Run N=3 AI arbitration on a disputed order."""
    resp = httpx.post(
        f"{ARBITOVA_BASE}/orders/{order_id}/auto-arbitrate",
        headers={"X-API-Key": BUYER_KEY},
        timeout=60,
    )
    return resp.json()


def partial_confirm(order_id: str, percent: float, note: str = "") -> dict:
    """Release a percentage of escrowed funds for partial delivery."""
    resp = httpx.post(
        f"{ARBITOVA_BASE}/orders/{order_id}/partial-confirm",
        json={"percent": percent, "note": note},
        headers={"X-API-Key": BUYER_KEY},
        timeout=30,
    )
    return resp.json()


def get_my_orders(role: str = "") -> dict:
    """Get list of orders for the authenticated agent."""
    params = f"?role={role}" if role else ""
    resp = httpx.get(
        f"{ARBITOVA_BASE}/orders{params}",
        headers={"X-API-Key": BUYER_KEY},
        timeout=30,
    )
    return resp.json()


# ─── AutoGen agents ─────────────────────────────────────────────────────────

def create_agents():
    llm_config = {
        "config_list": [{"model": "claude-haiku-4-5-20251001", "api_key": os.environ.get("ANTHROPIC_API_KEY")}],
        "timeout": 60,
    }

    buyer_agent = ConversableAgent(
        name="BuyerAgent",
        system_message="""You are a buyer agent using Arbitova escrow for safe A2A payments.
Your workflow:
1. create_order(service_id, requirements) — lock funds in escrow
2. Wait for seller to deliver
3. confirm_order(order_id) if delivery is good, OR dispute_order(order_id, reason) if not
4. If disputed, run_arbitration(order_id) to get AI verdict

Always use escrow. Never pay without an order ID.""",
        llm_config=llm_config,
        human_input_mode="NEVER",
    )

    seller_agent = ConversableAgent(
        name="SellerAgent",
        system_message="""You are a seller agent delivering work via Arbitova.
Your workflow:
1. Receive order details (order_id, requirements)
2. Complete the work
3. deliver_order(order_id, content) — submit your work

Your payment releases when buyer confirms. Work hard and deliver quality.""",
        llm_config=llm_config,
        human_input_mode="NEVER",
    )

    executor = UserProxyAgent(
        name="Executor",
        human_input_mode="NEVER",
        code_execution_config=False,
    )

    # Register tools with agents
    for fn in [create_order, deliver_order, confirm_order, dispute_order, run_arbitration, partial_confirm, get_my_orders]:
        register_function(
            fn,
            caller=buyer_agent,
            executor=executor,
            name=fn.__name__,
            description=fn.__doc__,
        )

    register_function(
        deliver_order,
        caller=seller_agent,
        executor=executor,
        name="deliver_order",
        description=deliver_order.__doc__,
    )

    return buyer_agent, seller_agent, executor


def run_demo():
    if not BUYER_KEY or not SELLER_KEY:
        print("Set ARBITOVA_BUYER_KEY and ARBITOVA_SELLER_KEY.")
        print("Register: POST https://a2a-system.onrender.com/api/v1/agents/register")
        return

    # Create a service for demo
    service_resp = httpx.post(
        f"{ARBITOVA_BASE}/services",
        json={"name": "AutoGen Demo Service", "description": "Summarize text", "price": 0.5, "delivery_time": 1},
        headers={"X-API-Key": SELLER_KEY},
    )
    service_id = service_resp.json().get("id")
    print(f"Service: {service_id}")

    buyer, seller, executor = create_agents()

    # Initiate the transaction conversation
    result = buyer.initiate_chats([
        {
            "recipient": executor,
            "message": f"Create an order for service {service_id} with requirements: 'Write a 100-word summary of quantum computing'",
            "max_turns": 3,
        },
        {
            "recipient": seller,
            "message": "An order has been placed for you. Deliver a 100-word summary of quantum computing.",
            "max_turns": 3,
        },
        {
            "recipient": executor,
            "message": "The seller has delivered. Review and confirm (or dispute) the delivery.",
            "max_turns": 3,
        },
    ])

    print("\n=== Transaction complete ===")
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    run_demo()
