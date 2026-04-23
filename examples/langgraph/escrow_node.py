"""
Arbitova escrow node for LangGraph (reference integration).

This is the reference implementation shipped with the LangChain
community PR (see .arbitova-gm/drafts/langgraph-pr.md in the
Arbitova repo). It wraps the EscrowV1 lifecycle as three LangGraph
nodes so a flow can reserve funds → wait for delivery → confirm (or
dispute) within one graph.

The node never holds a private key. Signing is delegated to the
signer passed in at construction — either a local wallet, a CDP
account via ``arbitova.cdp_adapter``, or any other eth_account-style
signer.

Usage sketch:

    from langgraph.graph import StateGraph
    from escrow_node import EscrowNode, BuyerState

    escrow = EscrowNode(
        signer=my_signer,
        rpc_url="https://sepolia.base.org",
        escrow_address="0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC",
        usdc_address="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    )

    graph = StateGraph(BuyerState)
    graph.add_node("reserve_funds", escrow.create_step)
    graph.add_node("await_delivery", escrow.wait_delivered_step)
    graph.add_node("confirm", escrow.confirm_step)
    graph.add_edge("reserve_funds", "await_delivery")
    graph.add_edge("await_delivery", "confirm")
    graph.set_entry_point("reserve_funds")

    app = graph.compile()
    final = app.invoke({"seller": "0x...", "amount_usdc": 0.10,
                        "verification_uri": "ipfs://spec.json"})
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Optional, TypedDict


class BuyerState(TypedDict, total=False):
    """Minimal LangGraph state for a buyer-side flow."""

    seller: str
    amount_usdc: float
    delivery_window_sec: int
    review_window_sec: int
    verification_uri: str

    # Populated by the node as the flow advances.
    escrow_id: Optional[int]
    escrow_state: Optional[str]
    dispute_reason: Optional[str]
    error: Optional[str]


@dataclass
class EscrowNode:
    """Reference LangGraph node for the Arbitova EscrowV1 lifecycle.

    All three step methods share the signature ``(state) -> state``
    that LangGraph expects. Each returns a *new* dict merged into the
    graph's state.
    """

    signer: Any
    rpc_url: str
    escrow_address: str
    usdc_address: str
    poll_interval_sec: float = 2.0
    max_wait_sec: int = 600

    _client: Any = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        # Lazy import so the node can be re-exported from a package
        # init file without eagerly pulling web3.
        from arbitova import path_b as _path_b

        self._path_b = _path_b

    # ----- step 1 -------------------------------------------------------------

    def create_step(self, state: BuyerState) -> BuyerState:
        """Approve USDC + createEscrow. Populates ``escrow_id``."""
        required = ("seller", "amount_usdc", "verification_uri")
        missing = [k for k in required if state.get(k) is None]
        if missing:
            return {"error": f"missing state keys: {missing}"}

        amount = state["amount_usdc"]
        delivery = int(state.get("delivery_window_sec", 3600))
        review = int(state.get("review_window_sec", 86400))

        result = self._path_b.arbitova_create_escrow(
            seller=state["seller"],
            amount_usdc=amount,
            delivery_window_sec=delivery,
            review_window_sec=review,
            verification_uri=state["verification_uri"],
            rpc_url=self.rpc_url,
            escrow_address=self.escrow_address,
            usdc_address=self.usdc_address,
            private_key=self._private_key(),
        )
        return {
            "escrow_id": result["escrow_id"],
            "escrow_state": "CREATED",
        }

    # ----- step 2 -------------------------------------------------------------

    def wait_delivered_step(self, state: BuyerState) -> BuyerState:
        """Poll until seller calls markDelivered() or we time out."""
        escrow_id = state.get("escrow_id")
        if escrow_id is None:
            return {"error": "wait_delivered_step: no escrow_id in state"}

        deadline = time.time() + self.max_wait_sec
        while time.time() < deadline:
            snapshot = self._path_b.arbitova_get_escrow(
                escrow_id,
                rpc_url=self.rpc_url,
                escrow_address=self.escrow_address,
            )
            current = snapshot.get("state")
            if current == "DELIVERED":
                return {"escrow_state": "DELIVERED"}
            if current in ("CANCELLED", "RESOLVED", "RELEASED"):
                return {
                    "escrow_state": current,
                    "error": f"unexpected terminal state {current}",
                }
            time.sleep(self.poll_interval_sec)

        return {"error": "wait_delivered_step: timed out waiting for DELIVERED"}

    # ----- step 3 -------------------------------------------------------------

    def confirm_step(self, state: BuyerState) -> BuyerState:
        """Call confirmDelivery on the happy path."""
        if state.get("escrow_state") != "DELIVERED":
            return {"error": "confirm_step: escrow not in DELIVERED state"}
        escrow_id = state["escrow_id"]
        self._path_b.arbitova_confirm_delivery(
            escrow_id,
            rpc_url=self.rpc_url,
            escrow_address=self.escrow_address,
            private_key=self._private_key(),
        )
        return {"escrow_state": "RELEASED"}

    def dispute_step(self, state: BuyerState) -> BuyerState:
        """Alternative step 3: raise a dispute instead of confirming."""
        reason = state.get("dispute_reason") or "unspecified"
        escrow_id = state.get("escrow_id")
        if escrow_id is None:
            return {"error": "dispute_step: no escrow_id"}
        self._path_b.arbitova_dispute(
            escrow_id,
            reason=reason,
            rpc_url=self.rpc_url,
            escrow_address=self.escrow_address,
            private_key=self._private_key(),
        )
        return {"escrow_state": "DISPUTED"}

    # ----- internals ----------------------------------------------------------

    def _private_key(self) -> Optional[str]:
        """Resolve the signer into a private key for path_b.

        path_b's current API expects a hex private key string. If the
        caller passed an eth_account LocalAccount, extract it. For CDP
        accounts, they should use ``arbitova.cdp_adapter`` directly
        rather than this node.
        """
        signer = self.signer
        if signer is None:
            return None
        if isinstance(signer, str):
            return signer
        if hasattr(signer, "key"):
            try:
                return signer.key.hex()
            except Exception:
                return str(signer.key)
        raise TypeError(
            "EscrowNode.signer must be a hex private key string or an "
            "eth_account LocalAccount; for CDP-managed accounts use "
            "arbitova.cdp_adapter.CdpEscrowClient instead."
        )


__all__ = ["EscrowNode", "BuyerState"]
