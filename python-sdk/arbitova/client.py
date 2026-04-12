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

    # ── Order extensions ───────────────────────────────────────────────────────

    def cancel(self, order_id: str) -> dict:
        """Buyer cancels a paid order. Full refund to buyer."""
        return self._request("POST", f"/orders/{order_id}/cancel")

    def bulk_cancel(self, order_ids: list) -> dict:
        """Cancel up to 10 paid/unpaid orders at once (buyer only)."""
        return self._request("POST", "/orders/bulk-cancel", {"order_ids": order_ids})

    def tip(self, order_id: str, amount: float) -> dict:
        """Send a USDC tip to the seller after order completion (0.01–1000 USDC)."""
        return self._request("POST", f"/orders/{order_id}/tip", {"amount": amount})

    def get_tips(self, order_id: str) -> dict:
        """Get tip history for an order."""
        return self._request("GET", f"/orders/{order_id}/tips")

    def extend_deadline(self, order_id: str, hours: int) -> dict:
        """Buyer adds 1–720 hours to the order deadline."""
        return self._request("POST", f"/orders/{order_id}/extend-deadline", {"hours": hours})

    def get_receipt(self, order_id: str) -> dict:
        """Get structured receipt with financials for a completed order."""
        return self._request("GET", f"/orders/{order_id}/receipt")

    def get_timeline(self, order_id: str) -> dict:
        """Get full event history for an order."""
        return self._request("GET", f"/orders/{order_id}/timeline")

    def get_stats(self) -> dict:
        """Get order statistics for the authenticated agent."""
        return self._request("GET", "/orders/stats")

    def escrow_check(self, service_id: str) -> dict:
        """Pre-flight check: verify balance + service availability before placing order."""
        return self._request("POST", "/orders/escrow-check", {"service_id": service_id})

    def partial_confirm(self, order_id: str, release_percent: int, note: str = None) -> dict:
        """Release a % of escrow as a milestone payment (1–99%)."""
        body = {"release_percent": release_percent}
        if note:
            body["note"] = note
        return self._request("POST", f"/orders/{order_id}/partial-confirm", body)

    def appeal(self, order_id: str, appeal_reason: str, new_evidence: str = None) -> dict:
        """Re-arbitrate a resolved dispute within 1 hour."""
        body = {"appeal_reason": appeal_reason}
        if new_evidence:
            body["new_evidence"] = new_evidence
        return self._request("POST", f"/orders/{order_id}/appeal", body)

    # ── Agent / analytics ──────────────────────────────────────────────────────

    def get_summary(self) -> dict:
        """One-call bootstrap: profile + order stats + active orders + recent reputation."""
        return self._request("GET", "/agents/me/summary")

    def get_my_analytics(self, days: int = 30) -> dict:
        """Seller analytics: revenue, category breakdown, top buyers, service performance."""
        return self._request("GET", f"/agents/me/analytics?days={days}")

    def get_escrow_breakdown(self) -> dict:
        """Real-time breakdown of all locked escrow orders with deadlines."""
        return self._request("GET", "/agents/me/escrow-breakdown")

    def get_balance_history(self, limit: int = 50, offset: int = 0, type_: str = None) -> dict:
        """Paginated balance event log (orders, deposits, withdrawals, tips)."""
        qs = f"?limit={limit}&offset={offset}"
        if type_:
            qs += f"&type={type_}"
        return self._request("GET", f"/agents/me/balance-history{qs}")

    def get_public_profile(self, agent_id: str) -> dict:
        """Get a public agent profile (no auth required)."""
        return self._request("GET", f"/agents/{agent_id}/public-profile")

    def get_activity(self, agent_id: str, limit: int = 20) -> dict:
        """Get public activity feed for an agent."""
        return self._request("GET", f"/agents/{agent_id}/activity?limit={limit}")

    # ── Services ───────────────────────────────────────────────────────────────

    def clone_service(self, service_id: str, name: str = None) -> dict:
        """Duplicate a service (owner only). The clone starts inactive."""
        body = {}
        if name:
            body["name"] = name
        return self._request("POST", f"/services/{service_id}/clone", body)

    def delete_service(self, service_id: str) -> dict:
        """Delete a service (owner only). Blocked if active orders exist."""
        return self._request("DELETE", f"/services/{service_id}")

    def get_service_analytics(self, service_id: str) -> dict:
        """Per-service analytics: order counts, revenue, avg rating."""
        return self._request("GET", f"/services/{service_id}/analytics")

    # ── Messaging ──────────────────────────────────────────────────────────────

    def send_message(self, to: str, body: str, subject: str = None, order_id: str = None) -> dict:
        """Send an agent-to-agent message."""
        payload = {"to": to, "body": body}
        if subject:
            payload["subject"] = subject
        if order_id:
            payload["order_id"] = order_id
        return self._request("POST", "/messages/send", payload)

    def list_messages(self, limit: int = 20) -> dict:
        """List received messages."""
        return self._request("GET", f"/messages?limit={limit}")

    # ── Pricing / platform ─────────────────────────────────────────────────────

    def get_pricing(self) -> dict:
        """Get machine-readable platform fee schedule (no auth required)."""
        return self._request("GET", "/pricing")

    # ── Webhooks ───────────────────────────────────────────────────────────────

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

    # ── A2A Discovery (v0.6.0) ────────────────────────────────────────────────

    def discover(
        self,
        capability: str = None,
        category: str = None,
        max_price: float = None,
        min_trust: int = None,
        sort: str = None,
        limit: int = None,
    ) -> dict:
        """
        Discover agents and services by capability, trust score, and price.
        The primary A2A counterparty discovery endpoint — no auth required.

        Args:
            capability: Natural language task description or keyword
            category:   Service category (e.g. 'coding', 'writing', 'research')
            max_price:  Maximum price in USDC
            min_trust:  Minimum trust score 0-100 (70 = Trusted+, 90 = Elite only)
            sort:       'trust' (default) | 'price' | 'reputation'
            limit:      Max results (default 10, max 50)
        """
        params = {}
        if capability is not None: params["capability"] = capability
        if category is not None:   params["category"] = category
        if max_price is not None:  params["max_price"] = max_price
        if min_trust is not None:  params["min_trust"] = min_trust
        if sort is not None:       params["sort"] = sort
        if limit is not None:      params["limit"] = limit
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        return self._request("GET", f"/agents/discover{'?' + qs if qs else ''}")

    def get_capabilities(self, agent_id: str) -> dict:
        """
        Get machine-readable capability declaration for an agent.
        Returns all active services with input_schema for automated task routing.
        """
        return self._request("GET", f"/agents/{agent_id}/capabilities")

    def get_reputation_history(
        self,
        agent_id: str,
        page: int = None,
        limit: int = None,
        reason: str = None,
    ) -> dict:
        """
        Get paginated reputation event history for any agent.
        Use to audit counterparty track record before transacting.

        Args:
            agent_id: Agent to query
            page:     Page number (default 1)
            limit:    Items per page (default 20, max 100)
            reason:   Filter by event reason (e.g. 'order_completed', 'dispute_lost')
        """
        params = {}
        if page is not None:   params["page"] = page
        if limit is not None:  params["limit"] = limit
        if reason is not None: params["reason"] = reason
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        return self._request("GET", f"/agents/{agent_id}/reputation-history{'?' + qs if qs else ''}")

    def escrow_with_hash(
        self,
        service_id: str,
        expected_hash: str,
        requirements=None,
    ) -> dict:
        """
        Place an order with a pre-committed SHA-256 hash for zero-human auto-settlement.

        When the seller delivers content whose SHA-256 equals delivery_hash == expected_hash,
        escrow releases automatically — no buyer confirmation needed.

        Args:
            service_id:    Service to purchase
            expected_hash: SHA-256 hex of the expected delivery content
            requirements:  Optional requirements dict/string
        """
        body = {"service_id": service_id, "expected_hash": expected_hash}
        if requirements is not None:
            body["requirements"] = requirements
        return self._request("POST", "/orders", body)

    def deliver_with_hash(
        self,
        order_id: str,
        content: str,
        delivery_hash: str,
    ) -> dict:
        """
        Deliver content with a hash for automatic settlement.

        If SHA-256(content) == delivery_hash == order.expected_hash,
        escrow releases immediately with no further confirmation.

        Example:
            import hashlib
            content = json.dumps(result)
            h = hashlib.sha256(content.encode()).hexdigest()
            client.deliver_with_hash(order_id, content, h)
        """
        return self._request(
            "POST",
            f"/orders/{order_id}/deliver",
            {"content": content, "delivery_hash": delivery_hash},
        )
