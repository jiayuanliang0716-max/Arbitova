"""
Arbitova — Coinbase CDP adapter (v0.1-alpha)

Wrap a Coinbase Developer Platform (CDP) managed account so an agent
with no self-held private key can still create, confirm, and dispute
Arbitova escrows.

The adapter does not change Arbitova semantics. EscrowV1 still sees an
ordinary EOA; CDP just happens to be the backend producing its
signatures. From the contract's view, a CDP-signed transaction is
indistinguishable from a local-wallet-signed one.

Status: draft. Not importable from `arbitova` root until CDP SDK
pinning is finalized. Keep as `from arbitova.cdp_adapter import ...`.

Usage (conceptual):

    from arbitova.cdp_adapter import CdpEscrowClient

    client = CdpEscrowClient(
        cdp_api_key=os.environ["CDP_API_KEY_NAME"],
        cdp_api_secret=os.environ["CDP_API_KEY_PRIVATE"],
        cdp_account_id=os.environ["CDP_ACCOUNT_ID"],
        rpc_url="https://sepolia.base.org",
        escrow_address="0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC",
        usdc_address="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    )

    escrow_id = client.create_escrow(
        seller="0x...",
        amount_usdc=0.10,
        delivery_window_sec=3600,
        review_window_sec=86400,
        verification_uri="ipfs://spec.json",
    )
    client.confirm_delivery(escrow_id)

Design notes:
- No private key is stored in this process. All signing goes through
  the CDP API over TLS.
- Approvals for USDC spending follow the same rule — CDP signs, we
  send.
- We intentionally do NOT persist the CDP account id anywhere; caller
  is responsible for passing it on each instantiation. This keeps the
  surface area small and makes key rotation the caller's problem.
"""

from __future__ import annotations

import os
import json
from dataclasses import dataclass
from typing import Any, Callable, Optional

try:
    from cdp import Cdp, SmartContract, Asset  # type: ignore
    _CDP_AVAILABLE = True
except ImportError:  # CDP SDK not installed yet — adapter still importable
    _CDP_AVAILABLE = False
    Cdp = None  # type: ignore
    SmartContract = None  # type: ignore
    Asset = None  # type: ignore

from .path_b import ESCROW_ABI, ERC20_ABI, STATUS_NAMES


class CdpNotInstalled(RuntimeError):
    """Raised when the cdp Python SDK is not available."""


@dataclass
class CdpEscrowClient:
    """Thin, read-delegating wrapper around the CDP SDK for EscrowV1.

    Only the signing-affecting calls are routed through CDP. Read
    calls (``get_escrow``, ``next_escrow_id``) still use ``path_b``'s
    direct web3 path because there's no reason to pay CDP rate limits
    for a view function.
    """

    cdp_api_key: str
    cdp_api_secret: str
    cdp_account_id: str
    rpc_url: str
    escrow_address: str
    usdc_address: str
    usdc_decimals: int = 6
    _cdp_ready: bool = False

    def __post_init__(self) -> None:
        if not _CDP_AVAILABLE:
            raise CdpNotInstalled(
                "pip install 'coinbase-cdp-sdk' to use CdpEscrowClient"
            )
        Cdp.configure(api_key_name=self.cdp_api_key,
                      private_key=self.cdp_api_secret)
        self._cdp_ready = True

    # ----- CDP-routed writes --------------------------------------------------

    def create_escrow(
        self,
        *,
        seller: str,
        amount_usdc: float,
        delivery_window_sec: int,
        review_window_sec: int,
        verification_uri: str,
    ) -> int:
        """Approve USDC + createEscrow. Returns the new escrow id."""
        amount_raw = int(round(amount_usdc * (10 ** self.usdc_decimals)))
        self._sign_and_send(
            contract_address=self.usdc_address,
            abi=ERC20_ABI,
            method="approve",
            args={"spender": self.escrow_address, "amount": amount_raw},
        )
        receipt = self._sign_and_send(
            contract_address=self.escrow_address,
            abi=ESCROW_ABI,
            method="createEscrow",
            args={
                "seller": seller,
                "amount": amount_raw,
                "deliveryWindowSec": delivery_window_sec,
                "reviewWindowSec": review_window_sec,
                "verificationURI": verification_uri,
            },
        )
        return self._extract_escrow_id(receipt)

    def mark_delivered(self, escrow_id: int, delivery_hash: str) -> None:
        self._sign_and_send(
            contract_address=self.escrow_address,
            abi=ESCROW_ABI,
            method="markDelivered",
            args={"id": escrow_id, "deliveryHash": delivery_hash},
        )

    def confirm_delivery(self, escrow_id: int) -> None:
        self._sign_and_send(
            contract_address=self.escrow_address,
            abi=ESCROW_ABI,
            method="confirmDelivery",
            args={"id": escrow_id},
        )

    def dispute(self, escrow_id: int, reason: str) -> None:
        self._sign_and_send(
            contract_address=self.escrow_address,
            abi=ESCROW_ABI,
            method="dispute",
            args={"id": escrow_id, "reason": reason},
        )

    def cancel_if_not_delivered(self, escrow_id: int) -> None:
        self._sign_and_send(
            contract_address=self.escrow_address,
            abi=ESCROW_ABI,
            method="cancelIfNotDelivered",
            args={"id": escrow_id},
        )

    # ----- Read-path shim (delegates to path_b) -------------------------------

    def get_escrow(self, escrow_id: int) -> dict:
        from .path_b import arbitova_get_escrow
        return arbitova_get_escrow(
            escrow_id,
            rpc_url=self.rpc_url,
            escrow_address=self.escrow_address,
        )

    # ----- Internals ----------------------------------------------------------

    def _sign_and_send(
        self,
        *,
        contract_address: str,
        abi: list,
        method: str,
        args: dict,
    ) -> Any:
        """Dispatch a write through the CDP SDK's SmartContract.invoke."""
        if not self._cdp_ready or SmartContract is None:
            raise CdpNotInstalled("CDP SDK unavailable")
        account = Cdp.get_account(self.cdp_account_id)
        invocation = SmartContract.invoke_contract(
            network_id="base-sepolia",
            contract_address=contract_address,
            method=method,
            abi=abi,
            args=args,
            account=account,
        )
        invocation.wait()
        return invocation.transaction

    def _extract_escrow_id(self, receipt: Any) -> int:
        """Find the EscrowCreated event in the CDP receipt and return its id."""
        # CDP receipts expose decoded logs under different attribute names
        # across SDK versions. Try common shapes; caller can monkey-patch
        # this method if their SDK version differs.
        for candidate_attr in ("logs", "decoded_logs", "events"):
            logs = getattr(receipt, candidate_attr, None)
            if not logs:
                continue
            for log in logs:
                name = getattr(log, "name", None) or (
                    log.get("name") if isinstance(log, dict) else None
                )
                if name == "EscrowCreated":
                    args_attr = getattr(log, "args", None) or (
                        log.get("args") if isinstance(log, dict) else None
                    )
                    if args_attr is None:
                        continue
                    maybe_id = (
                        getattr(args_attr, "id", None)
                        if not isinstance(args_attr, dict)
                        else args_attr.get("id")
                    )
                    if maybe_id is not None:
                        return int(maybe_id)
        raise RuntimeError(
            "EscrowCreated event not found in CDP receipt; "
            "check cdp SDK version compatibility"
        )


__all__ = ["CdpEscrowClient", "CdpNotInstalled"]
