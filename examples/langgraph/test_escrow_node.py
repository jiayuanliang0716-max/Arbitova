"""
Unit tests for the LangGraph escrow node reference integration.

These tests stub out ``arbitova.path_b`` so they run without network
access. End-to-end tests against live Base Sepolia live in the
separate ``examples/path_b/`` demos.
"""

from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import MagicMock


def _install_fake_path_b() -> types.ModuleType:
    """Create an ``arbitova.path_b`` stub module before importing the node."""
    arbitova = sys.modules.get("arbitova") or types.ModuleType("arbitova")
    sys.modules["arbitova"] = arbitova

    path_b = types.ModuleType("arbitova.path_b")
    path_b.arbitova_create_escrow = MagicMock(
        return_value={"escrow_id": 42, "tx_hash": "0xabc"}
    )
    path_b.arbitova_get_escrow = MagicMock(
        return_value={"state": "DELIVERED", "buyer": "0xB", "seller": "0xS"}
    )
    path_b.arbitova_confirm_delivery = MagicMock(return_value={"tx_hash": "0xdef"})
    path_b.arbitova_dispute = MagicMock(return_value={"tx_hash": "0xdis"})
    sys.modules["arbitova.path_b"] = path_b
    arbitova.path_b = path_b
    return path_b


class EscrowNodeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.path_b_stub = _install_fake_path_b()
        # Late import: node picks up the stub.
        from escrow_node import EscrowNode

        self.EscrowNode = EscrowNode
        self.node = EscrowNode(
            signer="0x" + "11" * 32,
            rpc_url="https://sepolia.base.org",
            escrow_address="0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC",
            usdc_address="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            poll_interval_sec=0.0,
            max_wait_sec=1,
        )

    def test_create_step_populates_escrow_id(self) -> None:
        state = self.node.create_step({
            "seller": "0xS",
            "amount_usdc": 0.10,
            "verification_uri": "ipfs://spec.json",
        })
        self.assertEqual(state["escrow_id"], 42)
        self.assertEqual(state["escrow_state"], "CREATED")
        self.path_b_stub.arbitova_create_escrow.assert_called_once()

    def test_create_step_reports_missing_required_state(self) -> None:
        state = self.node.create_step({"seller": "0xS"})
        self.assertIn("missing state keys", state.get("error", ""))
        self.path_b_stub.arbitova_create_escrow.assert_not_called()

    def test_wait_delivered_sees_delivered(self) -> None:
        state = self.node.wait_delivered_step({"escrow_id": 42})
        self.assertEqual(state["escrow_state"], "DELIVERED")

    def test_wait_delivered_detects_terminal_state(self) -> None:
        self.path_b_stub.arbitova_get_escrow.return_value = {
            "state": "CANCELLED",
        }
        state = self.node.wait_delivered_step({"escrow_id": 42})
        self.assertEqual(state["escrow_state"], "CANCELLED")
        self.assertIn("unexpected terminal state", state["error"])

    def test_confirm_step_happy_path(self) -> None:
        state = self.node.confirm_step({
            "escrow_id": 42,
            "escrow_state": "DELIVERED",
        })
        self.assertEqual(state["escrow_state"], "RELEASED")
        self.path_b_stub.arbitova_confirm_delivery.assert_called_once()

    def test_confirm_step_refuses_wrong_state(self) -> None:
        state = self.node.confirm_step({
            "escrow_id": 42,
            "escrow_state": "CREATED",
        })
        self.assertIn("not in DELIVERED state", state["error"])
        self.path_b_stub.arbitova_confirm_delivery.assert_not_called()

    def test_dispute_step_uses_default_reason(self) -> None:
        state = self.node.dispute_step({"escrow_id": 42})
        self.assertEqual(state["escrow_state"], "DISPUTED")
        call = self.path_b_stub.arbitova_dispute.call_args
        self.assertEqual(call.kwargs["reason"], "unspecified")


if __name__ == "__main__":
    unittest.main()
