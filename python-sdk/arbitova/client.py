"""
Arbitova Python SDK

Official Python client for the Arbitova API.
Escrow, AI arbitration, and trust scoring for agent-to-agent payments.

Usage:
    from arbitova import Arbitova
    client = Arbitova(api_key="your-api-key")
    order = client.escrow("svc_abc123", requirements={"task": "summarize"})
"""

import httpx
from typing import Optional, Any

DEFAULT_BASE_URL = "https://a2a-system.onrender.com/api/v1"
DEFAULT_TIMEOUT = 30.0
DEFAULT_RETRIES = 2


class ArbitovaError(Exception):
    def __init__(self, message: str, status_code: int = None, body: dict = None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body or {}


class Arbitova:
    """
    Arbitova API client.

    Args:
        api_key (str): Your agent API key (X-API-Key).
        base_url (str): Override the API base URL.
        timeout (float): Request timeout in seconds (default: 30).
        retries (int): Auto-retry on 5xx errors (default: 2).
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        retries: int = DEFAULT_RETRIES,
    ):
        if not api_key:
            raise ValueError("Arbitova: api_key is required")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._retries = retries

    # ── Internal ─────────────────────────────────────────────────────────────

    def _request(self, method: str, path: str, body: dict = None) -> dict:
        url = f"{self._base_url}{path}"
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": self._api_key,
        }
        last_err = None
        for attempt in range(self._retries + 1):
            try:
                with httpx.Client(timeout=self._timeout) as client:
                    res = client.request(
                        method,
                        url,
                        headers=headers,
                        json=body,
                    )
                if res.status_code >= 500 and attempt < self._retries:
                    last_err = res
                    continue
                data = res.json()
                if res.status_code >= 400:
                    raise ArbitovaError(
                        data.get("error", f"HTTP {res.status_code}"),
                        status_code=res.status_code,
                        body=data,
                    )
                return data
            except ArbitovaError:
                raise
            except Exception as e:
                last_err = e
                if attempt >= self._retries:
                    raise ArbitovaError(str(e))
        raise ArbitovaError(str(last_err))

    # ── Core methods ──────────────────────────────────────────────────────────

    def escrow(self, service_id: str, requirements: Any = None) -> dict:
        """
        Place an order and lock funds in escrow.

        Args:
            service_id: The service ID to purchase.
            requirements: Requirements string or dict (matched against service input_schema).

        Returns:
            Order object with id, status, amount, deadline.
        """
        body = {"service_id": service_id}
        if requirements is not None:
            body["requirements"] = requirements if isinstance(requirements, str) else str(requirements)
        return self._request("POST", "/orders", body)

    def deliver(self, order_id: str, content: str) -> dict:
        """
        Submit delivery for an order (seller side).

        Args:
            order_id: The order ID.
            content: Delivery content string.

        Returns:
            Delivery object.
        """
        return self._request("POST", f"/orders/{order_id}/deliver", {"content": content})

    def confirm(self, order_id: str) -> dict:
        """
        Confirm delivery and release escrow funds to seller (buyer side).

        Args:
            order_id: The order ID.

        Returns:
            Updated order object.
        """
        return self._request("POST", f"/orders/{order_id}/confirm", {})

    def dispute(self, order_id: str, reason: str, evidence: str = None) -> dict:
        """
        Open a dispute on an order.

        Args:
            order_id: The order ID.
            reason: Reason for the dispute.
            evidence: Optional supporting evidence.

        Returns:
            Dispute object.
        """
        body = {"reason": reason}
        if evidence:
            body["evidence"] = evidence
        return self._request("POST", f"/orders/{order_id}/dispute", body)

    def arbitrate(self, order_id: str) -> dict:
        """
        Trigger N=3 AI arbitration for a disputed order.

        Returns:
            Verdict: {winner, confidence, method, votes, escalate_to_human, reasoning}
        """
        return self._request("POST", f"/orders/{order_id}/auto-arbitrate", {})

    def get_reputation(self, agent_id: str) -> dict:
        """
        Get reputation score for an agent.

        Returns:
            {score, level, category_scores, total_orders, ...}
        """
        return self._request("GET", f"/agents/{agent_id}/reputation")

    def get_order(self, order_id: str) -> dict:
        """Get order details and current status."""
        return self._request("GET", f"/orders/{order_id}")

    def search_services(
        self,
        q: str = None,
        category: str = None,
        max_price: float = None,
        market: str = None,
    ) -> list:
        """
        Search available agent services.

        Args:
            q: Keyword search.
            category: Filter by category.
            max_price: Maximum price in USD.
            market: 'a2a' or 'h2a'.

        Returns:
            List of service objects.
        """
        params = []
        if q:          params.append(f"q={q}")
        if category:   params.append(f"category={category}")
        if max_price:  params.append(f"max_price={max_price}")
        if market:     params.append(f"market={market}")
        qs = "?" + "&".join(params) if params else ""
        return self._request("GET", f"/services/search{qs}")

    def external_arbitrate(
        self,
        requirements: str,
        delivery_evidence: str,
        dispute_reason: str,
        escrow_provider: str = None,
        dispute_id: str = None,
        callback_url: str = None,
    ) -> dict:
        """
        Use Arbitova AI arbitration for a dispute from ANY escrow system.

        This is the arbitration-as-a-service endpoint. Pass in the context
        and get a binding AI verdict in <30 seconds.

        Args:
            requirements: Original contract requirements.
            delivery_evidence: Seller's delivery evidence.
            dispute_reason: Buyer's reason for disputing.
            escrow_provider: Name of your escrow system (optional, for tracking).
            dispute_id: Your internal dispute ID (optional).
            callback_url: Webhook URL to receive the verdict asynchronously (optional).

        Returns:
            {arbitration_id, winner, confidence, method, votes, reasoning, escalate_to_human}
        """
        body = {
            "requirements": requirements,
            "delivery_evidence": delivery_evidence,
            "dispute_reason": dispute_reason,
        }
        if escrow_provider: body["escrow_provider"] = escrow_provider
        if dispute_id:      body["dispute_id"] = dispute_id
        if callback_url:    body["callback_url"] = callback_url
        return self._request("POST", "/arbitrate/external", body)

    # ── Webhook management ────────────────────────────────────────────────────

    def create_webhook(self, url: str, events: list = None) -> dict:
        """Register a webhook endpoint."""
        body = {"url": url}
        if events:
            body["events"] = events
        return self._request("POST", "/webhooks", body)

    def list_webhooks(self) -> list:
        """List all registered webhooks."""
        return self._request("GET", "/webhooks")

    def delete_webhook(self, webhook_id: str) -> dict:
        """Delete a webhook."""
        return self._request("DELETE", f"/webhooks/{webhook_id}")
