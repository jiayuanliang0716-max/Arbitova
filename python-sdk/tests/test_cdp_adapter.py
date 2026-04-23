"""
Unit tests for arbitova.cdp_adapter.

The Coinbase CDP SDK (`coinbase-cdp-sdk`) is an optional peer dependency.
These tests inject a stub `cdp` module into sys.modules before importing
the adapter, so the suite runs in CI without the real SDK installed.
"""

from __future__ import annotations

import sys
import types
import unittest
from dataclasses import dataclass
from typing import Any


# ---------------------------------------------------------------------------
# Fake cdp module — minimum surface the adapter touches
# ---------------------------------------------------------------------------

def _install_fake_cdp() -> "FakeCdpState":
    """Install a stub `cdp` module so cdp_adapter can import it.

    Returns the shared state object so tests can assert on calls.
    """
    state = FakeCdpState()

    class FakeAsset:
        pass

    class FakeAccount:
        def __init__(self, account_id: str):
            self.account_id = account_id

    class FakeInvocation:
        def __init__(self, transaction: Any):
            self.transaction = transaction

        def wait(self) -> None:
            pass

    class FakeSmartContract:
        @staticmethod
        def invoke_contract(**kwargs: Any) -> FakeInvocation:
            state.invocations.append(kwargs)
            return FakeInvocation(state.next_receipt)

    class FakeCdp:
        @staticmethod
        def configure(**kwargs: Any) -> None:
            state.configured = kwargs

        @staticmethod
        def get_account(account_id: str) -> FakeAccount:
            state.account_lookups.append(account_id)
            return FakeAccount(account_id)

    module = types.ModuleType("cdp")
    module.Cdp = FakeCdp
    module.SmartContract = FakeSmartContract
    module.Asset = FakeAsset
    sys.modules["cdp"] = module

    for key in [k for k in list(sys.modules) if k.startswith("arbitova")]:
        sys.modules.pop(key, None)

    return state


@dataclass
class FakeCdpState:
    configured: dict | None = None
    account_lookups: list | None = None
    invocations: list | None = None
    next_receipt: Any = None

    def __post_init__(self) -> None:
        self.account_lookups = []
        self.invocations = []


# ---------------------------------------------------------------------------
# Receipt builders for _extract_escrow_id
# ---------------------------------------------------------------------------

class _ObjLog:
    def __init__(self, name: str, args: Any):
        self.name = name
        self.args = args


class _ObjArgs:
    def __init__(self, escrow_id: int):
        self.id = escrow_id


class _ObjReceipt:
    def __init__(self, attr: str, logs: list):
        setattr(self, attr, logs)


def _receipt_obj_style(escrow_id: int, attr: str = "logs") -> Any:
    return _ObjReceipt(attr, [_ObjLog("EscrowCreated", _ObjArgs(escrow_id))])


def _receipt_dict_style(escrow_id: int, attr: str = "events") -> Any:
    return _ObjReceipt(attr, [{"name": "EscrowCreated", "args": {"id": escrow_id}}])


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestCdpAdapterImportability(unittest.TestCase):
    """If the real cdp SDK is absent, the adapter must still import
    and raise CdpNotInstalled only when the client is instantiated."""

    def test_raises_when_cdp_not_installed(self) -> None:
        sys.modules.pop("cdp", None)
        for key in [k for k in list(sys.modules) if k.startswith("arbitova")]:
            sys.modules.pop(key, None)

        from arbitova.cdp_adapter import CdpEscrowClient, CdpNotInstalled

        with self.assertRaises(CdpNotInstalled):
            CdpEscrowClient(
                cdp_api_key="k",
                cdp_api_secret="s",
                cdp_account_id="acct_1",
                rpc_url="https://sepolia.base.org",
                escrow_address="0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC",
                usdc_address="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            )


class TestCdpAdapterWrites(unittest.TestCase):
    """With the fake cdp module installed, writes should route through
    SmartContract.invoke_contract with the expected argument shape."""

    def setUp(self) -> None:
        self.state = _install_fake_cdp()
        from arbitova.cdp_adapter import CdpEscrowClient

        self.client = CdpEscrowClient(
            cdp_api_key="k",
            cdp_api_secret="s",
            cdp_account_id="acct_1",
            rpc_url="https://sepolia.base.org",
            escrow_address="0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC",
            usdc_address="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        )

    def test_configure_called_on_init(self) -> None:
        self.assertEqual(self.state.configured, {"api_key_name": "k", "private_key": "s"})

    def test_create_escrow_sends_approve_then_create(self) -> None:
        self.state.next_receipt = _receipt_obj_style(42)

        escrow_id = self.client.create_escrow(
            seller="0x000000000000000000000000000000000000BEEF",
            amount_usdc=0.10,
            delivery_window_sec=3600,
            review_window_sec=86400,
            verification_uri="ipfs://spec.json",
        )

        self.assertEqual(escrow_id, 42)
        self.assertEqual(len(self.state.invocations), 2)

        approve_call, create_call = self.state.invocations
        self.assertEqual(approve_call["method"], "approve")
        self.assertEqual(approve_call["contract_address"], self.client.usdc_address)
        self.assertEqual(approve_call["args"]["spender"], self.client.escrow_address)
        self.assertEqual(approve_call["args"]["amount"], 100000)  # 0.10 USDC * 10^6

        self.assertEqual(create_call["method"], "createEscrow")
        self.assertEqual(create_call["contract_address"], self.client.escrow_address)
        self.assertEqual(create_call["args"]["seller"], "0x000000000000000000000000000000000000BEEF")
        self.assertEqual(create_call["args"]["amount"], 100000)
        self.assertEqual(create_call["args"]["verificationURI"], "ipfs://spec.json")

    def test_confirm_delivery_routes_through_cdp(self) -> None:
        self.state.next_receipt = None
        self.client.confirm_delivery(7)
        self.assertEqual(self.state.invocations[-1]["method"], "confirmDelivery")
        self.assertEqual(self.state.invocations[-1]["args"], {"id": 7})

    def test_dispute_passes_reason(self) -> None:
        self.state.next_receipt = None
        self.client.dispute(7, "delivery did not match spec")
        call = self.state.invocations[-1]
        self.assertEqual(call["method"], "dispute")
        self.assertEqual(call["args"]["reason"], "delivery did not match spec")

    def test_mark_delivered_carries_hash(self) -> None:
        self.state.next_receipt = None
        delivery_hash = "0x" + "a" * 64
        self.client.mark_delivered(7, delivery_hash)
        call = self.state.invocations[-1]
        self.assertEqual(call["method"], "markDelivered")
        self.assertEqual(call["args"]["deliveryHash"], delivery_hash)

    def test_cancel_if_not_delivered_routes(self) -> None:
        self.state.next_receipt = None
        self.client.cancel_if_not_delivered(7)
        self.assertEqual(self.state.invocations[-1]["method"], "cancelIfNotDelivered")

    def test_amount_roundtrip_for_six_decimals(self) -> None:
        self.state.next_receipt = _receipt_obj_style(1)
        self.client.create_escrow(
            seller="0x000000000000000000000000000000000000BEEF",
            amount_usdc=1.234567,
            delivery_window_sec=60,
            review_window_sec=60,
            verification_uri="ipfs://",
        )
        approve_call = self.state.invocations[0]
        # 1.234567 * 10^6 = 1_234_567
        self.assertEqual(approve_call["args"]["amount"], 1_234_567)


class TestEscrowIdExtraction(unittest.TestCase):
    """_extract_escrow_id must tolerate several receipt shapes because
    the CDP SDK has shifted them across versions."""

    def setUp(self) -> None:
        self.state = _install_fake_cdp()
        from arbitova.cdp_adapter import CdpEscrowClient

        self.client = CdpEscrowClient(
            cdp_api_key="k",
            cdp_api_secret="s",
            cdp_account_id="acct_1",
            rpc_url="https://sepolia.base.org",
            escrow_address="0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC",
            usdc_address="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        )

    def test_obj_style_logs(self) -> None:
        receipt = _receipt_obj_style(99, attr="logs")
        self.assertEqual(self.client._extract_escrow_id(receipt), 99)

    def test_obj_style_decoded_logs(self) -> None:
        receipt = _receipt_obj_style(100, attr="decoded_logs")
        self.assertEqual(self.client._extract_escrow_id(receipt), 100)

    def test_dict_style_events(self) -> None:
        receipt = _receipt_dict_style(101, attr="events")
        self.assertEqual(self.client._extract_escrow_id(receipt), 101)

    def test_missing_event_raises(self) -> None:
        empty = _ObjReceipt("logs", [])
        with self.assertRaises(RuntimeError):
            self.client._extract_escrow_id(empty)

    def test_unrelated_event_raises(self) -> None:
        receipt = _ObjReceipt("logs", [_ObjLog("SomethingElse", _ObjArgs(5))])
        with self.assertRaises(RuntimeError):
            self.client._extract_escrow_id(receipt)


if __name__ == "__main__":
    unittest.main()
