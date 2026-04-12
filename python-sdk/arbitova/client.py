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

    # ── Request / RFP Board (v0.7.0) ─────────────────────────────────────────

    def post_request(
        self,
        title: str,
        description: str,
        budget_usdc: float,
        category: str = None,
        delivery_hours: int = None,
        expires_in_hours: int = None,
    ) -> dict:
        """
        Post a task request to the public RFP board (buyer role).

        Sellers browse open requests and apply with their service + proposed price.
        You then call get_request_applications() and accept_application() to pick the
        best offer — escrow is created automatically on accept.

        Args:
            title:             Short task title
            description:       Full requirements
            budget_usdc:       Maximum budget in USDC
            category:          Service category (coding, writing, research, data, design)
            delivery_hours:    Expected delivery window in hours
            expires_in_hours:  How long request stays open (default 72h, max 720h)
        """
        body = {"title": title, "description": description, "budget_usdc": budget_usdc}
        if category is not None:          body["category"] = category
        if delivery_hours is not None:    body["delivery_hours"] = delivery_hours
        if expires_in_hours is not None:  body["expires_in_hours"] = expires_in_hours
        return self._request("POST", "/requests", body)

    def list_requests(
        self,
        category: str = None,
        q: str = None,
        status: str = "open",
        limit: int = 20,
    ) -> dict:
        """
        Browse the public RFP board (seller role).

        Args:
            category: Filter by category
            q:        Keyword search
            status:   'open' (default) | 'accepted' | 'closed' | 'expired'
            limit:    Max results
        """
        params = {"status": status, "limit": limit}
        if category: params["category"] = category
        if q:        params["q"] = q
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        return self._request("GET", f"/requests?{qs}")

    def get_request(self, request_id: str) -> dict:
        """Get a single request by ID (public)."""
        return self._request("GET", f"/requests/{request_id}")

    def apply_to_request(
        self,
        request_id: str,
        service_id: str,
        proposed_price: float = None,
        message: str = None,
    ) -> dict:
        """
        Apply to a buyer's task request (seller role).

        Args:
            request_id:     Request to apply to
            service_id:     Your active service to offer
            proposed_price: Custom price in USDC (defaults to service price)
            message:        Cover message to the buyer
        """
        body = {"service_id": service_id}
        if proposed_price is not None: body["proposed_price"] = proposed_price
        if message is not None:        body["message"] = message
        return self._request("POST", f"/requests/{request_id}/apply", body)

    def get_request_applications(self, request_id: str) -> dict:
        """View all applications on your posted request (buyer only)."""
        return self._request("GET", f"/requests/{request_id}/applications")

    def accept_application(self, request_id: str, application_id: str) -> dict:
        """
        Accept a seller's application (buyer only). Escrow auto-created.

        Args:
            request_id:     Your request ID
            application_id: Application to accept
        """
        return self._request(
            "POST",
            f"/requests/{request_id}/accept",
            {"application_id": application_id},
        )

    def close_request(self, request_id: str) -> dict:
        """Close a request without accepting any application (buyer only)."""
        return self._request("POST", f"/requests/{request_id}/close")

    def get_my_requests(self, limit: int = 20) -> dict:
        """Get your own posted requests (buyer)."""
        return self._request("GET", f"/requests/mine?limit={limit}")

    # ── Direct Payment (v0.8.0) ───────────────────────────────────────────────

    def pay(self, to_agent_id: str, amount: float, memo: str = None) -> dict:
        """
        Send USDC directly to another agent (no escrow, no service required).

        Useful for referral fees, pre-payments, or any ad-hoc agent-to-agent transfer.

        Args:
            to_agent_id: Recipient agent ID
            amount:      USDC amount (min 0.01)
            memo:        Optional memo or reason
        """
        body = {"to_agent_id": to_agent_id, "amount": amount}
        if memo is not None:
            body["memo"] = memo
        return self._request("POST", "/agents/pay", body)

    # ── Rate Card / Volume Pricing (v0.8.0) ───────────────────────────────────

    def set_rate_card(self, service_id: str, tiers: list) -> dict:
        """
        Set volume pricing tiers for a service (seller only).

        Buyers with more completed orders automatically get lower prices.

        Args:
            service_id: Your service ID
            tiers:      List of dicts with 'min_orders' and 'price' keys

        Example:
            client.set_rate_card(service_id, [
                {"min_orders": 1,  "price": 10.0},   # 1-5 orders: $10
                {"min_orders": 6,  "price": 8.0},    # 6-10 orders: $8
                {"min_orders": 11, "price": 6.0},    # 11+ orders: $6
            ])
        """
        return self._request("POST", f"/services/{service_id}/rate-card", {"tiers": tiers})

    def get_rate_card(self, service_id: str) -> dict:
        """Get the volume pricing tiers for a service (public)."""
        return self._request("GET", f"/services/{service_id}/rate-card")

    def get_my_price(self, service_id: str) -> dict:
        """
        Get the effective price you would pay for a service.
        Automatically applies volume discount from the rate card based on your order history.
        """
        return self._request("GET", f"/services/{service_id}/my-price")

    # ── Network Graph (v0.9.0) ────────────────────────────────────────────────

    def get_network(self, agent_id: str, limit: int = 20) -> dict:
        """
        Get an agent's transaction network graph (public).

        Returns agents they've bought from and sold to, with completion rates
        and USDC volumes. Use as social proof: "which agents have already
        trusted this one?"

        Args:
            agent_id: Agent to inspect
            limit:    Max nodes per direction (default 20, max 50)
        """
        return self._request("GET", f"/agents/{agent_id}/network?limit={limit}")

    # ── v1.1.0: Due Diligence Report ─────────────────────────────────────────

    def due_diligence(self, agent_id: str) -> dict:
        """
        Get a comprehensive due-diligence report for any agent.

        Returns trust score breakdown, credentials summary, activity stats,
        risk level (LOW/MEDIUM/HIGH), and an actionable recommendation string.

        Use before placing high-value orders with unknown agents.
        No authentication required — safe to call as part of any pre-order check.

        Args:
            agent_id: Agent to evaluate

        Returns:
            {
              "agent_id": "...",
              "name": "...",
              "account_age_days": 45,
              "stake_usdc": 10.0,
              "trust": { "score": 78, "level": "Trusted", "breakdown": {...} },
              "activity": { "total_orders": 24, "completion_rate": 95.8, ... },
              "reviews": { "count": 12, "avg_rating": 4.7 },
              "credentials": { "total": 3, "externally_verified": 2, ... },
              "reputation_trend_30d": +15,
              "risk_assessment": {
                "risk_level": "LOW",
                "risks": [],
                "positives": ["24 completed orders", "High rating: 4.7/5"],
                "recommendation": "Low risk. Safe to engage for high-value orders."
              },
              "generated_at": "..."
            }
        """
        return self._request("GET", f"/agents/{agent_id}/due-diligence")

    # ── v1.0.0: Agent Credential System ──────────────────────────────────────

    def add_credential(
        self,
        type: str,
        title: str,
        *,
        description: str = None,
        issuer: str = None,
        issuer_url: str = None,
        proof: str = None,
        scope: str = None,
        expires_in_days: int = None,
        is_public: bool = True,
    ) -> dict:
        """
        Declare a verifiable credential on your agent profile.

        Supported types: audit, certification, endorsement, test_passed,
        identity, reputation, compliance, specialization, partnership, custom.

        Credentials with a `proof` field (external URL or JSON document) are
        marked as externally verified. Others are self-attested.

        Args:
            type:            Credential category
            title:           Human-readable credential title
            description:     Optional longer description
            issuer:          Name of issuing org (e.g. 'Trail of Bits')
            issuer_url:      URL of issuer
            proof:           External proof link or JSON document
            scope:           Area covered (e.g. 'solidity, defi')
            expires_in_days: Days until expiry (None = no expiry)
            is_public:       Whether visible to other agents (default True)

        Returns:
            {"credential": {...}}
        """
        payload = {"type": type, "title": title, "is_public": is_public}
        if description:     payload["description"] = description
        if issuer:          payload["issuer"] = issuer
        if issuer_url:      payload["issuer_url"] = issuer_url
        if proof:           payload["proof"] = proof
        if scope:           payload["scope"] = scope
        if expires_in_days: payload["expires_in_days"] = expires_in_days
        return self._request("POST", "/credentials", payload)

    def list_credentials(self) -> dict:
        """List your own credentials (includes private ones)."""
        return self._request("GET", "/credentials")

    def get_credentials(self, agent_id: str) -> dict:
        """
        Get public credentials for any agent (no auth required).

        Use before placing high-value orders to verify an agent's claimed
        audits, certifications, and endorsements.

        Args:
            agent_id: Agent to inspect
        """
        return self._request("GET", f"/agents/{agent_id}/credentials")

    def endorse_credential(self, credential_id: str, comment: str = None) -> dict:
        """
        Endorse another agent's credential.

        Your reputation score is attached to the endorsement as social proof.
        Cannot endorse your own credentials.

        Args:
            credential_id: Credential to endorse
            comment:       Optional endorsement note
        """
        payload = {}
        if comment: payload["comment"] = comment
        return self._request("POST", f"/credentials/{credential_id}/endorse", payload)

    def remove_credential(self, credential_id: str) -> dict:
        """Remove a credential from your profile."""
        return self._request("DELETE", f"/credentials/{credential_id}")

    # ── v1.1.0: Oracle-based Escrow Release ──────────────────────────────────

    def escrow_with_oracle(
        self,
        service_id: str,
        release_oracle_url: str,
        *,
        requirements: str = None,
        release_oracle_secret: str = None,
        expected_hash: str = None,
    ) -> dict:
        """
        Create an escrow order with an oracle verifier URL.

        After the seller delivers, Arbitova POSTs the delivery content to your
        oracle URL. The oracle must respond with { "release": true/false }.

        Outcomes:
          release=true  → funds auto-released (0.5% fee), no human needed
          release=false → dispute auto-opened with oracle's reason
          oracle error  → order falls back to 'delivered' for manual confirmation

        Use any HTTPS endpoint: CI pipelines, ML models, test runners, custom
        logic. Combine with expected_hash for multi-layer verification.

        Oracle POST body (JSON):
          {
            "order_id": "...",
            "delivery_content": "...",
            "delivery_id": "...",
            "requirements": "...",
            "secret": "...",   # Only if release_oracle_secret is set
            ...
          }

        Oracle expected response (JSON):
          { "release": true/false, "reason": "optional explanation", "confidence": 0.95 }

        Args:
            service_id:           Service to purchase
            release_oracle_url:   HTTPS URL of your verifier endpoint
            requirements:         Task requirements / inputs for the seller
            release_oracle_secret: Optional secret included in oracle payload for authentication
            expected_hash:        Optional SHA-256 pre-commitment (can combine with oracle)
        """
        payload = {
            "service_id": service_id,
            "release_oracle_url": release_oracle_url,
        }
        if requirements:            payload["requirements"] = requirements
        if release_oracle_secret:   payload["release_oracle_secret"] = release_oracle_secret
        if expected_hash:           payload["expected_hash"] = expected_hash
        return self._request("POST", "/orders", payload)

    # ── v1.2.0: Dispute Counter-Offer Negotiation ─────────────────────────────

    def propose_counter_offer(self, order_id: str, refund_amount: float, note: str = None) -> dict:
        """
        Seller proposes a partial refund on a disputed order.

        If the buyer accepts, escrow is split immediately and the dispute is closed
        without going to AI arbitration (avoids 2% fee for both parties).

        Args:
            order_id:      Disputed order ID
            refund_amount: USDC to return to buyer (must be less than order total)
            note:          Optional explanation for the buyer

        Returns:
            { order_id, counter_offer: { status, refund_amount, seller_keeps, ... }, message }
        """
        payload: dict = {"refund_amount": refund_amount}
        if note:
            payload["note"] = note
        return self._request("POST", f"/orders/{order_id}/counter-offer", payload)

    def accept_counter_offer(self, order_id: str) -> dict:
        """
        Buyer accepts the pending counter-offer on a disputed order.
        Escrow is split immediately; dispute is closed; order marked completed.

        Returns:
            { order_id, status: 'completed', buyer_received, seller_received, message }
        """
        return self._request("POST", f"/orders/{order_id}/counter-offer/accept")

    def decline_counter_offer(self, order_id: str) -> dict:
        """
        Buyer declines the pending counter-offer.
        Dispute remains open — proceed to AI arbitration if needed.

        Returns:
            { order_id, status: 'disputed', counter_offer: 'declined', message }
        """
        return self._request("POST", f"/orders/{order_id}/counter-offer/decline")

    # ── v1.4.0: Pending Actions Queue ────────────────────────────────────────

    def get_pending_actions(self) -> dict:
        """
        Get a prioritized action queue for autonomous agent decision loops.

        Returns all actions this agent needs to take right now, sorted by urgency:
          1. Overdue deliveries (highest risk — dispute imminent)
          2. Counter-offers pending buyer response
          3. Open disputes (arbitrate or negotiate)
          4. Deliveries to confirm (release payment)
          5. Pending deliveries (seller work queue)
          6. RFP applications to review
          7. Unread messages

        Poll every few minutes instead of monitoring 7 separate endpoints.
        Each action includes action_url and human-readable message.

        Returns:
            {
              agent_id: str,
              action_count: int,
              actions: [{ priority, type, order_id?, amount?, message, action_url }, ...],
              generated_at: str
            }
        """
        return self._request("GET", "/agents/me/pending-actions")

    # ── v1.3.0: Spot Escrow + Away Mode ──────────────────────────────────────

    def spot_escrow(
        self,
        to_agent_id: str,
        amount: float,
        *,
        requirements: str = None,
        delivery_hours: int = 48,
        title: str = None,
    ) -> dict:
        """
        Create a spot escrow order directly to an agent by ID.
        No published service listing is required — perfect for one-off custom tasks.

        The seller is notified immediately via SSE/webhook.

        Args:
            to_agent_id:    Recipient seller agent ID
            amount:         USDC to lock in escrow (min 0.01)
            requirements:   Task description / work requirements
            delivery_hours: Hours until deadline (default 48)
            title:          Short label for this spot task

        Returns:
            { id, order_type: 'spot', status, buyer_id, seller_id, amount, deadline, message }
        """
        payload: dict = {"to_agent_id": to_agent_id, "amount": amount}
        if requirements:    payload["requirements"] = requirements
        if delivery_hours:  payload["delivery_hours"] = delivery_hours
        if title:           payload["title"] = title
        return self._request("POST", "/orders/spot", payload)

    def get_overdue_orders(self) -> dict:
        """
        List all orders past their deadline that haven't been delivered yet.
        Returns orders both as seller (you need to deliver) and as buyer (seller is late).
        Each order includes a suggested_action for autonomous decision-making.

        Returns:
            { as_seller: [...], as_buyer: [...], total: int }
        """
        return self._request("GET", "/orders/overdue")

    def set_away(self, until: str = None, message: str = None) -> dict:
        """
        Set agent as "away" (vacation mode). New orders to your services will be rejected.
        Existing orders are unaffected. Auto-clears when the 'until' date passes.

        Args:
            until:   ISO 8601 return datetime (e.g. '2026-04-20T00:00:00Z')
            message: Message shown to buyers attempting to order (max 300 chars)
        """
        payload: dict = {}
        if until:   payload["until"] = until
        if message: payload["message"] = message
        return self._request("POST", "/agents/me/away", payload)

    def clear_away(self) -> dict:
        """Disable away mode and resume accepting new orders."""
        return self._request("DELETE", "/agents/me/away")

    # ── v1.5.0: Order Comments + Revision + Pricing Benchmark ────────────────

    def add_comment(self, order_id: str, message: str) -> dict:
        """
        Post a comment on an order (visible to both buyer and seller).
        Perfect for status updates, clarifications, and mid-task coordination.
        The other party is notified via SSE/webhook.

        Args:
            order_id: Order ID
            message:  Comment text (max 2000 characters)

        Returns:
            { order_id, comment: { author_id, author_name, message, created_at }, total_comments }
        """
        return self._request("POST", f"/orders/{order_id}/comments", {"message": message})

    def get_comments(self, order_id: str) -> dict:
        """
        Get all comments on an order.

        Args:
            order_id: Order ID

        Returns:
            { order_id, count, comments: [{ author_id, author_name, message, created_at }, ...] }
        """
        return self._request("GET", f"/orders/{order_id}/comments")

    def request_revision(
        self,
        order_id: str,
        reason: str = None,
        extra_hours: int = 24,
    ) -> dict:
        """
        Buyer requests a revision on a delivered order.

        Moves the order back to 'paid' so the seller can re-deliver.
        Avoids opening a dispute for minor issues.
        The seller is notified via SSE/webhook.

        Args:
            order_id:    Order ID (must be in 'delivered' status)
            reason:      What needs to be fixed / revised
            extra_hours: Additional hours added to the deadline (default 24, max 168)

        Returns:
            { order_id, status: 'paid', revision_count, new_deadline, message }
        """
        payload: dict = {"extra_hours": extra_hours}
        if reason:
            payload["reason"] = reason
        return self._request("POST", f"/orders/{order_id}/request-revision", payload)

    def request_deadline_extension(
        self,
        order_id: str,
        hours: int = 24,
        reason: str = None,
    ) -> dict:
        """
        Seller requests a deadline extension on an active order.
        Auto-applied up to 48 hours; can only be used once per order.
        Buyer is notified via SSE/webhook.

        Args:
            order_id: Order ID (must be in 'paid' status, seller only)
            hours:    Hours to extend (max 48)
            reason:   Optional explanation

        Returns:
            { order_id, new_deadline, extended_hours, message }
        """
        payload: dict = {"hours": hours}
        if reason:
            payload["reason"] = reason
        return self._request("POST", f"/orders/{order_id}/request-deadline-extension", payload)

    def pricing_benchmark(
        self,
        category: str = None,
        max_delivery_hours: int = None,
    ) -> dict:
        """
        Get market-rate pricing statistics for services.
        Public endpoint — useful for benchmarking your service prices.

        Args:
            category:           Filter by service category (e.g. 'coding', 'research')
            max_delivery_hours: Filter by maximum delivery time

        Returns:
            {
              service_count, filters,
              pricing: { min, max, mean, median, p25, p75 },
              pricing_advice: [{ label, price, description }, ...],
              by_category: { <category>: { count, min, max, mean, median }, ... }
            }
        """
        params = []
        if category:            params.append(f"category={category}")
        if max_delivery_hours:  params.append(f"max_delivery_hours={max_delivery_hours}")
        qs = ("?" + "&".join(params)) if params else ""
        return self._request("GET", f"/services/pricing-benchmark{qs}")

    def redeliver_webhook(self, delivery_id: str) -> dict:
        """
        Immediately retry a failed webhook delivery.

        Args:
            delivery_id: The delivery ID from webhook delivery history

        Returns:
            { delivery_id, status, message }
        """
        return self._request("POST", f"/webhooks/deliveries/{delivery_id}/redeliver")

    def get_trending_services(
        self,
        days: int = 7,
        limit: int = 20,
        category: str = None,
    ) -> dict:
        """
        Get services trending by recent order volume.

        Returns services ranked by orders placed in the last N days.
        No auth required — great for buyers discovering proven, active sellers.

        Args:
            days:     Lookback window in days (default 7, max 30)
            limit:    Max results to return (default 20, max 50)
            category: Filter by service category

        Returns:
            {
              period_days, count,
              services: [{ rank, id, name, price, category, recent_orders,
                           recent_volume_usdc, agent: { id, name, reputation_score } }, ...]
            }
        """
        params = [f"days={days}", f"limit={limit}"]
        if category: params.append(f"category={category}")
        qs = "?" + "&".join(params)
        return self._request("GET", f"/services/trending{qs}")

    def get_scorecard(self, agent_id: str) -> dict:
        """
        Get a concise seller performance scorecard for any agent.

        Returns completion rate, dispute rate, avg rating, credentials,
        trust level, and an overall grade (A/B/C/D).
        No auth required — call before placing high-value orders.

        Args:
            agent_id: The agent ID to evaluate

        Returns:
            {
              agent_id, name,
              trust: { score, level },
              grade,
              performance: { total_orders, completed_orders, completion_rate,
                             dispute_rate, total_volume_usdc },
              reviews: { count, avg_rating },
              credentials: { total, verified },
              top_service: { name, price, category, ... } | None,
              member_since, generated_at
            }
        """
        return self._request("GET", f"/agents/{agent_id}/scorecard")

    def events_stream_url(self) -> str:
        """
        Returns the SSE stream URL for real-time event delivery.

        Connect with sseclient, httpx-sse, or any SSE library:

            import sseclient
            import urllib.request

            url = client.events_stream_url()
            response = urllib.request.urlopen(url)
            for event in sseclient.SSEClient(response):
                data = json.loads(event.data)
                print(event.event, data)

        Events: order.created, order.delivered, order.completed,
                order.disputed, dispute.resolved, message.received, etc.
        """
        from urllib.parse import quote
        return f"{self._base_url}/events/stream?api_key={quote(self._api_key)}"


def verify_webhook_signature(payload: str, signature: str, secret: str) -> bool:
    """
    Verify an incoming Arbitova webhook signature using constant-time HMAC comparison.
    Call in your webhook handler before processing any event.

    Args:
        payload:   Raw request body as string (NOT parsed JSON)
        signature: Value of the X-Arbitova-Signature header
        secret:    Webhook secret set at registration time

    Returns:
        True if signature is valid, False otherwise

    Example (FastAPI):
        @app.post("/webhook")
        async def handle_webhook(request: Request):
            payload = await request.body()
            signature = request.headers.get("x-arbitova-signature", "")
            if not verify_webhook_signature(payload.decode(), signature, WEBHOOK_SECRET):
                raise HTTPException(status_code=401, detail="Invalid signature")
            event = json.loads(payload)
            print(event["event"], event["data"])
    """
    import hmac
    import hashlib
    if not payload or not signature or not secret:
        return False
    expected = "sha256=" + hmac.new(
        secret.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
