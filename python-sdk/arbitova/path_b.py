"""
Arbitova Path B — On-chain Escrow SDK (EscrowV1)

Agent-owned wallet mode: funds flow directly through the EscrowV1 smart contract.
Your private key never leaves this process. Arbitova is not a custodian.

Required env vars:
    ARBITOVA_RPC_URL           — e.g. https://mainnet.base.org
    ARBITOVA_ESCROW_ADDRESS    — deployed EscrowV1 address
    ARBITOVA_USDC_ADDRESS      — USDC token address
                                 mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
                                 sepolia: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
    ARBITOVA_AGENT_PRIVATE_KEY — your agent wallet private key (hex, 0x-prefixed)

Dependencies: web3>=6, eth-account, eth-hash[pycryptodome] — installed automatically as of arbitova 2.5.2.

Usage:
    from arbitova.path_b import arbitova_create_escrow, arbitova_dispute, get_tool_definitions
"""

import os
import json
import hashlib
import time
from typing import Any, Dict, List, Optional

__all__ = [
    "arbitova_create_escrow",
    "arbitova_mark_delivered",
    "arbitova_confirm_delivery",
    "arbitova_dispute",
    "arbitova_cancel_if_not_delivered",
    "arbitova_escalate_if_expired",
    "arbitova_get_escrow",
    "arbitova_resolve",
    "get_tool_definitions",
    "verify_delivery_hash",
    "ESCROW_ABI",
    "ERC20_ABI",
    "ESCROW_CREATED_TOPIC",
    "STATUS_NAMES",
]

# ── Try web3, fall back to raw JSON-RPC ──────────────────────────────────────

try:
    from web3 import Web3
    from web3.middleware import ExtraDataToPOAMiddleware
    from eth_account import Account
    _WEB3_AVAILABLE = True
except ImportError:
    _WEB3_AVAILABLE = False

# ── Minimal ABIs ──────────────────────────────────────────────────────────────

ESCROW_ABI = [
    {
        "name": "createEscrow",
        "type": "function",
        "inputs": [
            {"name": "seller", "type": "address"},
            {"name": "amount", "type": "uint256"},
            {"name": "deliveryWindowSec", "type": "uint64"},
            {"name": "reviewWindowSec", "type": "uint64"},
            {"name": "verificationURI", "type": "string"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "nonpayable",
    },
    {
        "name": "resolve",
        "type": "function",
        "inputs": [
            {"name": "id", "type": "uint256"},
            {"name": "buyerBps", "type": "uint16"},
            {"name": "sellerBps", "type": "uint16"},
            {"name": "verdictHash", "type": "bytes32"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "markDelivered",
        "type": "function",
        "inputs": [
            {"name": "id", "type": "uint256"},
            {"name": "deliveryHash", "type": "bytes32"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "confirmDelivery",
        "type": "function",
        "inputs": [{"name": "id", "type": "uint256"}],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "dispute",
        "type": "function",
        "inputs": [
            {"name": "id", "type": "uint256"},
            {"name": "reason", "type": "string"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "cancelIfNotDelivered",
        "type": "function",
        "inputs": [{"name": "id", "type": "uint256"}],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "escalateIfExpired",
        "type": "function",
        "inputs": [{"name": "id", "type": "uint256"}],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "getEscrow",
        "type": "function",
        "inputs": [{"name": "id", "type": "uint256"}],
        "outputs": [
            {
                "name": "",
                "type": "tuple",
                "components": [
                    {"name": "buyer", "type": "address"},
                    {"name": "seller", "type": "address"},
                    {"name": "amount", "type": "uint256"},
                    {"name": "deliveryDeadline", "type": "uint64"},
                    {"name": "reviewDeadline", "type": "uint64"},
                    {"name": "reviewWindowSec", "type": "uint64"},
                    {"name": "state", "type": "uint8"},
                    {"name": "deliveryHash", "type": "bytes32"},
                    {"name": "verificationURI", "type": "string"},
                ],
            }
        ],
        "stateMutability": "view",
    },
]

ERC20_ABI = [
    {
        "name": "approve",
        "type": "function",
        "inputs": [
            {"name": "spender", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
    },
    {
        "name": "decimals",
        "type": "function",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
        "stateMutability": "view",
    },
    {
        "name": "balanceOf",
        "type": "function",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    },
]

if _WEB3_AVAILABLE:
    # Raw 32 bytes of keccak — compare byte-wise downstream, not via .hex() strings.
    # hexbytes v1.0+ dropped the '0x' prefix from .hex(); comparing stringified hex
    # silently broke escrow_id extraction on web3.py 6.x + hexbytes <1 pins.
    ESCROW_CREATED_TOPIC_BYTES = Web3.keccak(
        text="EscrowCreated(uint256,address,address,uint256,uint64,string)"
    )
else:
    ESCROW_CREATED_TOPIC_BYTES = None

# Back-compat alias (deprecated): some users imported this. Always 0x-prefixed now.
ESCROW_CREATED_TOPIC = (
    "0x" + ESCROW_CREATED_TOPIC_BYTES.hex().removeprefix("0x")
    if ESCROW_CREATED_TOPIC_BYTES is not None else None
)

STATUS_NAMES = ["CREATED", "DELIVERED", "RELEASED", "DISPUTED", "RESOLVED", "CANCELLED"]

# ── Helpers ───────────────────────────────────────────────────────────────────


def _get_env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        raise EnvironmentError(f"PathB: env var {key} is required")
    return val


def _err(error, hint: str = "") -> Dict[str, Any]:
    return {"ok": False, "error": str(error), "hint": hint}


def _get_web3_context():
    """Return (w3, account, escrow_contract, usdc_contract)."""
    if not _WEB3_AVAILABLE:
        raise ImportError(
            "web3 package is required for Path B. Reinstall with: pip install --upgrade arbitova"
        )
    rpc_url = _get_env("ARBITOVA_RPC_URL")
    escrow_addr = _get_env("ARBITOVA_ESCROW_ADDRESS")
    usdc_addr = _get_env("ARBITOVA_USDC_ADDRESS")
    private_key = _get_env("ARBITOVA_AGENT_PRIVATE_KEY")

    w3 = Web3(Web3.HTTPProvider(rpc_url))
    # PoA chain support (e.g. Base)
    try:
        w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
    except Exception:
        pass

    account = Account.from_key(private_key)
    escrow = w3.eth.contract(
        address=Web3.to_checksum_address(escrow_addr), abi=ESCROW_ABI
    )
    usdc = w3.eth.contract(
        address=Web3.to_checksum_address(usdc_addr), abi=ERC20_ABI
    )
    return w3, account, escrow, usdc


def _send_tx(w3, account, fn, *args):
    """Build, sign, send a transaction and return the receipt."""
    nonce = w3.eth.get_transaction_count(account.address, "pending")
    tx = fn(*args).build_transaction({
        "from": account.address,
        "nonce": nonce,
        "gas": 300_000,
        "gasPrice": w3.eth.gas_price,
    })
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    return receipt


def _keccak_uri(uri: str) -> bytes:
    """Compute keccak256 of URI bytes — mirrors ethers.keccak256(toUtf8Bytes(uri))."""
    from eth_hash.auto import keccak
    return keccak(uri.encode("utf-8"))


# ── Tool implementations ──────────────────────────────────────────────────────


def arbitova_create_escrow(
    seller: str,
    amount: float,
    delivery_window_hours: int = 24,
    review_window_hours: int = 24,
    verification_uri: str = "",
) -> Dict[str, Any]:
    """
    Buyer locks USDC into EscrowV1. Calls USDC.approve() then createEscrow() on-chain.
    Returns {ok, tx_hash, escrow_id} or {ok: False, error, hint}.
    """
    try:
        w3, account, escrow, usdc = _get_web3_context()

        decimals = usdc.functions.decimals().call()
        amount_wei = int(amount * (10 ** decimals))

        # Approve
        approve_receipt = _send_tx(w3, account, usdc.functions.approve, escrow.address, amount_wei)
        if approve_receipt["status"] != 1:
            return _err("USDC approve() reverted", "Check USDC balance and allowance.")

        delivery_sec = delivery_window_hours * 3600
        review_sec = review_window_hours * 3600

        receipt = _send_tx(
            w3, account, escrow.functions.createEscrow,
            Web3.to_checksum_address(seller),
            amount_wei,
            delivery_sec,
            review_sec,
            verification_uri,
        )
        if receipt["status"] != 1:
            return _err("createEscrow() reverted", "Check seller address and contract state.")

        # Parse EscrowCreated log for escrow id. Compare bytes, not hex strings —
        # HexBytes.hex() output differs between hexbytes <1.0 ('0x…') and >=1.0 ('…').
        escrow_id = None
        if ESCROW_CREATED_TOPIC_BYTES is not None:
            expected = bytes(ESCROW_CREATED_TOPIC_BYTES)
            for log in receipt.get("logs", []):
                topics = log.get("topics", [])
                if topics and bytes(topics[0]) == expected:
                    escrow_id = int.from_bytes(bytes(topics[1]), "big")
                    break

        return {"ok": True, "tx_hash": "0x" + receipt["transactionHash"].hex(), "escrow_id": escrow_id}
    except Exception as e:
        return _err(e, "Check USDC balance, RPC URL, and that seller address is valid.")


def arbitova_mark_delivered(
    escrow_id: int,
    delivery_payload_uri: str,
    delivery_content_bytes: Optional[bytes] = None,
) -> Dict[str, Any]:
    """
    Seller marks delivery. Pins a hash of the delivery CONTENT (not just the URI) so the
    seller cannot swap the file after handover. If delivery_content_bytes is omitted,
    falls back to hashing the URI — caller should always prefer content hashing.

    Returns {ok, tx_hash, delivery_hash} or {ok: False, error, hint}.
    """
    try:
        w3, account, escrow, _ = _get_web3_context()

        if delivery_content_bytes is not None:
            from eth_hash.auto import keccak
            delivery_hash = keccak(delivery_content_bytes)
            hash_basis = "content"
        else:
            delivery_hash = _keccak_uri(delivery_payload_uri)
            hash_basis = "uri"

        receipt = _send_tx(w3, account, escrow.functions.markDelivered, escrow_id, delivery_hash)

        if receipt["status"] != 1:
            return _err("markDelivered() reverted", "Ensure you are the seller and escrow is in CREATED state.")

        return {
            "ok": True,
            "tx_hash": "0x" + receipt["transactionHash"].hex(),
            "delivery_hash": "0x" + delivery_hash.hex(),
            "hash_basis": hash_basis,
        }
    except Exception as e:
        return _err(
            e,
            "Ensure the escrow exists and you are the seller. "
            "delivery_payload_uri must be a stable URL pointing to completed work.",
        )


def verify_delivery_hash(delivery_content_bytes: bytes, on_chain_delivery_hash: str) -> bool:
    """
    Check that the content at delivery_uri still matches the hash the seller pinned on-chain.
    Returns True if bytes keccak matches on_chain_delivery_hash (hex, 0x-prefixed).
    """
    from eth_hash.auto import keccak
    local = keccak(delivery_content_bytes)
    return ("0x" + local.hex()).lower() == on_chain_delivery_hash.lower()


def arbitova_confirm_delivery(
    escrow_id: int,
    verified: bool = False,
    verification_report: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Buyer releases funds to seller. The SDK refuses to call confirmDelivery unless
    the caller passes verified=True AND a verification_report documenting that every
    criterion in the listing was checked. This prevents thoughtless auto-release.

    Returns {ok, tx_hash} or {ok: False, error, hint}.
    """
    if not verified:
        return _err(
            "refused: verified=False",
            "confirm_delivery requires an explicit verified=True after the buyer has "
            "checked the delivery against every criterion. If any criterion failed, "
            "call arbitova_dispute instead.",
        )
    if not verification_report or not verification_report.get("all_criteria_passed"):
        return _err(
            "refused: verification_report missing or not all criteria passed",
            "Pass verification_report={'all_criteria_passed': True, 'per_criterion': [...]}. "
            "If any criterion failed, call arbitova_dispute instead.",
        )
    try:
        w3, account, escrow, _ = _get_web3_context()

        receipt = _send_tx(w3, account, escrow.functions.confirmDelivery, escrow_id)

        if receipt["status"] != 1:
            return _err("confirmDelivery() reverted", "Only the buyer can confirm. Escrow must be DELIVERED.")

        return {"ok": True, "tx_hash": "0x" + receipt["transactionHash"].hex()}
    except Exception as e:
        return _err(e, "Only the buyer can confirm. Escrow must be in DELIVERED state and within review window.")


def arbitova_resolve(
    escrow_id: int,
    buyer_bps: int,
    seller_bps: int,
    verdict_hash_hex: str,
) -> Dict[str, Any]:
    """
    Arbiter settles a DISPUTED escrow by splitting funds buyer_bps/seller_bps (must sum to 10000).
    verdict_hash_hex is a 0x-prefixed 32-byte hash of the arbiter's verdict metadata JSON
    (prompt, evidence, AI output, confidence) — pinned on-chain for off-chain audit.

    Caller must be the arbiter EOA set at contract deploy. Returns {ok, tx_hash}.
    """
    if buyer_bps + seller_bps != 10000:
        return _err(
            f"bps must sum to 10000, got {buyer_bps} + {seller_bps}",
            "buyerBps + sellerBps must equal 10000 (100% in basis points).",
        )
    if not verdict_hash_hex.startswith("0x") or len(verdict_hash_hex) != 66:
        return _err(
            "verdict_hash_hex must be 0x-prefixed 32-byte hex",
            "Compute keccak256(json_bytes) of the verdict document and pass as 0x-prefixed hex.",
        )
    try:
        w3, account, escrow, _ = _get_web3_context()

        verdict_hash = bytes.fromhex(verdict_hash_hex[2:])
        receipt = _send_tx(
            w3, account, escrow.functions.resolve,
            escrow_id, buyer_bps, seller_bps, verdict_hash,
        )

        if receipt["status"] != 1:
            return _err("resolve() reverted", "Only the arbiter can resolve. Escrow must be DISPUTED.")

        return {"ok": True, "tx_hash": "0x" + receipt["transactionHash"].hex()}
    except Exception as e:
        return _err(
            e,
            "Only the arbiter wallet (see contract deploy) can call resolve. "
            "Ensure the escrow is in DISPUTED state and bps split sums to 10000.",
        )


def arbitova_dispute(escrow_id: int, reason: str) -> Dict[str, Any]:
    """
    Either party opens a dispute.
    Returns {ok, tx_hash} or {ok: False, error, hint}.
    """
    try:
        w3, account, escrow, _ = _get_web3_context()

        receipt = _send_tx(w3, account, escrow.functions.dispute, escrow_id, reason)

        if receipt["status"] != 1:
            return _err("dispute() reverted", "Check that the escrow is in a disputable state.")

        return {"ok": True, "tx_hash": "0x" + receipt["transactionHash"].hex()}
    except Exception as e:
        return _err(
            e,
            "Either buyer or seller can dispute. "
            "The reason field will be recorded on-chain and reviewed by the arbiter.",
        )


def arbitova_get_escrow(escrow_id: int) -> Dict[str, Any]:
    """
    View current on-chain state of an escrow.
    Returns full escrow data dict or {ok: False, error, hint}.
    """
    try:
        w3, _, escrow, _ = _get_web3_context()

        data = escrow.functions.getEscrow(escrow_id).call()
        # data is a tuple: (buyer, seller, amount, deliveryDeadline, reviewDeadline, reviewWindowSec, state, deliveryHash, verificationURI)
        buyer, seller, amount, delivery_deadline, review_deadline, _review_window, status, delivery_hash, verification_uri = data

        ZERO_HASH = b"\x00" * 32
        return {
            "ok": True,
            "escrow_id": str(escrow_id),
            "buyer": buyer,
            "seller": seller,
            "amount_usdc": amount / 1e6,
            "delivery_deadline": delivery_deadline,
            "review_deadline": review_deadline if review_deadline > 0 else None,
            "state": STATUS_NAMES[status] if status < len(STATUS_NAMES) else str(status),
            "verification_uri": verification_uri,
            "delivery_hash": "0x" + delivery_hash.hex() if delivery_hash != ZERO_HASH else None,
        }
    except Exception as e:
        return _err(e, "Check that escrow_id is valid and the contract address is correct.")


def arbitova_cancel_if_not_delivered(escrow_id: int) -> Dict[str, Any]:
    """
    Buyer cancels if seller has not delivered after the delivery deadline.
    Returns {ok, tx_hash} or {ok: False, error, hint}.
    """
    try:
        w3, account, escrow, _ = _get_web3_context()

        receipt = _send_tx(w3, account, escrow.functions.cancelIfNotDelivered, escrow_id)

        if receipt["status"] != 1:
            return _err(
                "cancelIfNotDelivered() reverted",
                "Cancel only works after deliveryDeadline has passed and state is CREATED.",
            )

        return {"ok": True, "tx_hash": "0x" + receipt["transactionHash"].hex()}
    except Exception as e:
        return _err(
            e,
            "Cancel is only possible after the delivery deadline has passed and the escrow is still in CREATED state.",
        )


def arbitova_escalate_if_expired(escrow_id: int) -> Dict[str, Any]:
    """
    Either party (or any watcher) escalates a DELIVERED escrow to DISPUTED after the
    review window has expired without the buyer confirming. This is the core
    Path B invariant: silence never releases funds — expiry goes to arbitration, not payout.

    Anyone can call this; it is permissionless. Returns {ok, tx_hash}.
    """
    try:
        w3, account, escrow, _ = _get_web3_context()

        receipt = _send_tx(w3, account, escrow.functions.escalateIfExpired, escrow_id)

        if receipt["status"] != 1:
            return _err(
                "escalateIfExpired() reverted",
                "Escalate only works after reviewDeadline has passed and state is DELIVERED.",
            )

        return {"ok": True, "tx_hash": "0x" + receipt["transactionHash"].hex()}
    except Exception as e:
        return _err(
            e,
            "Escalate requires: state=DELIVERED, reviewDeadline < now. "
            "Anyone can trigger — buyer, seller, or a neutral watcher.",
        )


# ── Tool definitions (OpenAI-style) ──────────────────────────────────────────


def get_tool_definitions() -> List[Dict[str, Any]]:
    """
    Returns OpenAI-style tool definitions for use with AutoGen, LangChain,
    direct Anthropic function calling, or any OpenAI-compatible framework.
    The description fields encode the safety policy — they are the second line of defense.
    """
    return [
        {
            "type": "function",
            "function": {
                "name": "arbitova_create_escrow",
                "description": (
                    "Buyer locks USDC into the Arbitova EscrowV1 smart contract. "
                    "Calls USDC.approve() then createEscrow() on-chain. "
                    "REQUIRES: USDC balance >= amount. "
                    "delivery_window_hours = how long the seller has to deliver (default 24). "
                    "review_window_hours = how long the buyer has to verify after delivery is marked (default 24). "
                    "verification_uri must point to a publicly fetchable JSON document listing every criterion "
                    "the delivery will be checked against — this is the verification contract between buyer and seller. "
                    "If the review window expires without confirmation or dispute, funds auto-escalate to arbitration. "
                    "Silence protects the buyer; you do NOT need to confirm promptly."
                ),
                "parameters": {
                    "type": "object",
                    "required": ["seller", "amount", "verification_uri"],
                    "properties": {
                        "seller": {
                            "type": "string",
                            "description": "Seller Ethereum address (0x-prefixed)",
                        },
                        "amount": {
                            "type": "number",
                            "description": "USDC amount to lock (human-readable, e.g. 50.0 for 50 USDC)",
                        },
                        "delivery_window_hours": {
                            "type": "integer",
                            "description": "Hours the seller has to deliver (default 24)",
                            "default": 24,
                        },
                        "review_window_hours": {
                            "type": "integer",
                            "description": "Hours the buyer has to review after delivery (default 24)",
                            "default": 24,
                        },
                        "verification_uri": {
                            "type": "string",
                            "description": (
                                "Publicly fetchable URL of a JSON document listing every delivery criterion "
                                '(e.g. {"criteria": ["word count >= 1000", "includes executive summary"]})'
                            ),
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "arbitova_mark_delivered",
                "description": (
                    "Called by the SELLER after completing the work and uploading the deliverable to a stable URL. "
                    "delivery_payload_uri must point to the completed, publicly fetchable deliverable — "
                    "the contract hashes this URI on-chain. "
                    "Do NOT call this before the work is actually done. Do NOT use a temporary or expiring URL. "
                    "The arbiter will fetch this URI during dispute resolution — "
                    "a broken or mismatched URL counts as non-delivery. "
                    "Before calling: (1) complete all work to spec, "
                    "(2) upload to a stable URL (IPFS or persistent storage), "
                    "(3) verify the content matches every criterion in verification_uri."
                ),
                "parameters": {
                    "type": "object",
                    "required": ["escrow_id", "delivery_payload_uri"],
                    "properties": {
                        "escrow_id": {
                            "type": "integer",
                            "description": "The escrow ID returned by arbitova_create_escrow",
                        },
                        "delivery_payload_uri": {
                            "type": "string",
                            "description": "Stable public URL pointing to the completed deliverable",
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "arbitova_confirm_delivery",
                "description": (
                    "Confirm that the seller has delivered and the output meets ALL criteria in the escrow's verification_uri. "
                    "ONLY call this AFTER you have: (1) fetched the delivery payload from delivery_payload_uri, "
                    "(2) fetched and parsed the verification_uri criteria document, "
                    "(3) compared the payload against EVERY criterion, "
                    "(4) are fully confident every criterion is satisfied. "
                    "If ANYTHING is missing, wrong, ambiguous, incomplete, or the seller did not deliver the agreed output — "
                    "DO NOT call this. Call arbitova_dispute instead with a specific reason citing the failed criterion. "
                    "Silence is safer than a wrong confirmation: if you do not confirm within the review window, "
                    "funds auto-escalate to AI arbitration, which protects the buyer by independently evaluating delivery."
                ),
                "parameters": {
                    "type": "object",
                    "required": ["escrow_id"],
                    "properties": {
                        "escrow_id": {
                            "type": "integer",
                            "description": "The escrow ID to confirm delivery for",
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "arbitova_dispute",
                "description": (
                    "Open a dispute when delivery is missing, incorrect, incomplete, or violates the verification criteria. "
                    "Disputes trigger AI arbitration which independently evaluates the delivery and can split funds fairly. "
                    "Call this whenever arbitova_confirm_delivery feels uncertain — when in doubt, dispute. "
                    "The reason field MUST cite specific criteria from verification_uri that were not met, "
                    'e.g. "Delivery at [URI] is missing criterion 3: word count is 400 but spec requires >= 1000." '
                    "Either the buyer OR the seller can open a dispute. "
                    "This is the correct action for: missing delivery, partial delivery, wrong format, "
                    "criteria mismatch, broken payload URL, expired URL, or any ambiguity."
                ),
                "parameters": {
                    "type": "object",
                    "required": ["escrow_id", "reason"],
                    "properties": {
                        "escrow_id": {
                            "type": "integer",
                            "description": "The escrow ID to dispute",
                        },
                        "reason": {
                            "type": "string",
                            "description": (
                                "Specific reason citing which verification criteria were not met. "
                                "Include the criterion text and what was observed."
                            ),
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "arbitova_get_escrow",
                "description": (
                    "Fetch the current on-chain state of an escrow: buyer, seller, amount, deadlines, status, "
                    "verification_uri, and delivery_hash. "
                    "Use this to check whether delivery has been marked before fetching the payload, "
                    "and to verify the review_deadline before deciding to confirm or dispute. "
                    "Status values: CREATED (awaiting delivery), DELIVERED (seller marked done, review window open), "
                    "RELEASED (funds released to seller), DISPUTED (in arbitration), RESOLVED (arbiter resolved), CANCELLED."
                ),
                "parameters": {
                    "type": "object",
                    "required": ["escrow_id"],
                    "properties": {
                        "escrow_id": {
                            "type": "integer",
                            "description": "The escrow ID to query",
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "arbitova_cancel_if_not_delivered",
                "description": (
                    "Buyer cancels an escrow after the delivery deadline has passed and the seller has not marked delivery. "
                    "Full USDC refund to buyer. Only callable by the buyer, only after delivery_deadline has elapsed, "
                    "and only when escrow is still in CREATED state. "
                    "Call arbitova_get_escrow first to verify the deadline has passed and state is CREATED."
                ),
                "parameters": {
                    "type": "object",
                    "required": ["escrow_id"],
                    "properties": {
                        "escrow_id": {
                            "type": "integer",
                            "description": "The escrow ID to cancel",
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "arbitova_escalate_if_expired",
                "description": (
                    "Escalates a DELIVERED escrow to DISPUTED after the review window expires without buyer action. "
                    "Permissionless — anyone can call, including neutral watchers. "
                    "This is the safety net that enforces 'silence never releases funds': if the buyer neither "
                    "confirms nor disputes, expiry routes the escrow to arbitration, not to seller payout. "
                    "Only works when state=DELIVERED and reviewDeadline < now. "
                    "Call arbitova_get_escrow first to confirm both conditions before calling."
                ),
                "parameters": {
                    "type": "object",
                    "required": ["escrow_id"],
                    "properties": {
                        "escrow_id": {
                            "type": "integer",
                            "description": "The escrow ID whose review window has expired",
                        },
                    },
                },
            },
        },
    ]
