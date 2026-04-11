"""
Arbitova + CrewAI Integration Example

This example shows how CrewAI agents can use Arbitova for safe A2A payments:
- Buyer agent hires seller agent via Arbitova escrow
- Seller agent delivers work
- Buyer agent confirms (or disputes) delivery

Requirements:
    pip install crewai arbitova

Usage:
    ARBITOVA_BUYER_KEY=<key> ARBITOVA_SELLER_KEY=<key> python crewai_integration.py
"""

import os
from crewai import Agent, Task, Crew
from crewai.tools import BaseTool
from typing import Optional
import httpx

ARBITOVA_BASE = "https://a2a-system.onrender.com/api/v1"


class ArbitovaEscrowTool(BaseTool):
    """Tool for creating and managing Arbitova escrow transactions."""

    name: str = "arbitova_escrow"
    description: str = (
        "Create an escrow transaction to safely pay another agent for a task. "
        "Funds are locked until delivery is confirmed or disputed. "
        "Use this before assigning work to an untrusted agent."
    )
    api_key: str = ""

    def _run(self, service_id: str, requirements: str) -> str:
        resp = httpx.post(
            f"{ARBITOVA_BASE}/orders",
            json={"service_id": service_id, "requirements": requirements},
            headers={"X-API-Key": self.api_key},
            timeout=30,
        )
        data = resp.json()
        if resp.status_code == 200:
            return f"Escrow created. Order ID: {data['id']}. Amount locked: {data['amount']} USDC."
        return f"Escrow failed: {data.get('error', 'Unknown error')}"


class ArbitovaConfirmTool(BaseTool):
    """Tool for confirming or disputing a delivery."""

    name: str = "arbitova_confirm_or_dispute"
    description: str = (
        "Confirm a delivery (releasing funds) or dispute it (triggering AI arbitration). "
        "Use after reviewing the seller's work."
    )
    api_key: str = ""

    def _run(self, order_id: str, action: str, reason: Optional[str] = None) -> str:
        if action == "confirm":
            resp = httpx.post(
                f"{ARBITOVA_BASE}/orders/{order_id}/confirm",
                headers={"X-API-Key": self.api_key},
                timeout=30,
            )
        elif action == "dispute":
            resp = httpx.post(
                f"{ARBITOVA_BASE}/orders/{order_id}/dispute",
                json={"reason": reason or "Delivery did not meet requirements"},
                headers={"X-API-Key": self.api_key},
                timeout=30,
            )
        elif action == "partial":
            # Partial confirm — release 50% if partially done
            resp = httpx.post(
                f"{ARBITOVA_BASE}/orders/{order_id}/partial-confirm",
                json={"percent": 50, "note": "Partial delivery accepted"},
                headers={"X-API-Key": self.api_key},
                timeout=30,
            )
        else:
            return f"Unknown action: {action}. Use 'confirm', 'dispute', or 'partial'."

        data = resp.json()
        if resp.status_code in (200, 201):
            return str(data)
        return f"Action failed: {data.get('error', 'Unknown error')}"


class ArbitovaDeliverTool(BaseTool):
    """Tool for submitting delivery of a completed task."""

    name: str = "arbitova_deliver"
    description: str = "Submit completed work as delivery for an Arbitova order."
    api_key: str = ""

    def _run(self, order_id: str, content: str) -> str:
        resp = httpx.post(
            f"{ARBITOVA_BASE}/orders/{order_id}/deliver",
            json={"content": content},
            headers={"X-API-Key": self.api_key},
            timeout=30,
        )
        data = resp.json()
        if resp.status_code == 200:
            return f"Delivery submitted. Status: {data.get('status')}. {data.get('message', '')}"
        return f"Delivery failed: {data.get('error', 'Unknown error')}"


def create_buyer_agent(api_key: str) -> Agent:
    """Buyer agent that hires and evaluates work."""
    return Agent(
        role="Buyer Agent",
        goal="Hire another agent to summarize a document, verify the quality, and confirm payment.",
        backstory=(
            "You are an autonomous AI agent with a budget of USDC. "
            "You use Arbitova escrow to safely pay for work — funds only release "
            "when you confirm the delivery meets your requirements."
        ),
        tools=[
            ArbitovaEscrowTool(api_key=api_key),
            ArbitovaConfirmTool(api_key=api_key),
        ],
        verbose=True,
    )


def create_seller_agent(api_key: str) -> Agent:
    """Seller agent that does the work and delivers."""
    return Agent(
        role="Seller Agent",
        goal="Complete assigned tasks and deliver results via Arbitova to receive payment.",
        backstory=(
            "You are a specialized AI agent offering document summarization services. "
            "You submit work through Arbitova's delivery system and receive payment "
            "once the buyer confirms quality."
        ),
        tools=[
            ArbitovaDeliverTool(api_key=api_key),
        ],
        verbose=True,
    )


def run_demo():
    """Run a full buyer-seller transaction demo."""
    buyer_key = os.environ.get("ARBITOVA_BUYER_KEY")
    seller_key = os.environ.get("ARBITOVA_SELLER_KEY")

    if not buyer_key or not seller_key:
        print("Set ARBITOVA_BUYER_KEY and ARBITOVA_SELLER_KEY environment variables.")
        print("Register at: POST https://a2a-system.onrender.com/api/v1/agents/register")
        return

    # First, create a service (seller registers what they offer)
    service_resp = httpx.post(
        f"{ARBITOVA_BASE}/services",
        json={
            "name": "Document Summarizer",
            "description": "Summarize any document to 200 words",
            "price": 1.0,
            "delivery_time": 1,
        },
        headers={"X-API-Key": seller_key},
    )
    service_id = service_resp.json().get("id")
    print(f"Service created: {service_id}")

    buyer = create_buyer_agent(buyer_key)
    seller = create_seller_agent(seller_key)

    buy_task = Task(
        description=f"Create an escrow order for service {service_id} with requirements: 'Summarize the French Revolution in exactly 200 words'",
        agent=buyer,
        expected_output="Escrow order ID and confirmation that funds are locked",
    )

    sell_task = Task(
        description="Deliver a 200-word summary of the French Revolution for the pending Arbitova order",
        agent=seller,
        expected_output="Confirmation that delivery was submitted successfully",
        context=[buy_task],
    )

    confirm_task = Task(
        description="Review the delivery and confirm if it meets the 200-word requirement. Confirm payment or dispute if not.",
        agent=buyer,
        expected_output="Payment confirmed or dispute opened with reason",
        context=[buy_task, sell_task],
    )

    crew = Crew(
        agents=[buyer, seller],
        tasks=[buy_task, sell_task, confirm_task],
        verbose=True,
    )

    result = crew.kickoff()
    print("\n=== Transaction Complete ===")
    print(result)


if __name__ == "__main__":
    run_demo()
