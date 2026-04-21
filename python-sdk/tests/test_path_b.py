"""
Path B Python SDK tests.

Run: pytest python-sdk/tests/test_path_b.py -v

Tests cover:
  - get_tool_definitions() structure and schema correctness
  - Safety policy presence in description fields
  - Error result shapes for missing env vars
  - ABI exports
  - Tool function exports
  - Parameter requirements in schemas
"""

import os
import sys
import json
import importlib
import unittest
from unittest.mock import MagicMock, patch

# Add python-sdk to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Set required env vars before import (some checks happen at import-time helpers)
os.environ.setdefault('ARBITOVA_RPC_URL', 'https://mock.rpc')
os.environ.setdefault('ARBITOVA_ESCROW_ADDRESS', '0x1234000000000000000000000000000000001234')
os.environ.setdefault('ARBITOVA_USDC_ADDRESS', '0x5678000000000000000000000000000000005678')
os.environ.setdefault('ARBITOVA_AGENT_PRIVATE_KEY', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')

from arbitova.path_b import (
    get_tool_definitions,
    ESCROW_ABI,
    ERC20_ABI,
    STATUS_NAMES,
    arbitova_create_escrow,
    arbitova_mark_delivered,
    arbitova_confirm_delivery,
    arbitova_dispute,
    arbitova_get_escrow,
    arbitova_cancel_if_not_delivered,
)


# ── Tool definition structure tests ──────────────────────────────────────────

class TestGetToolDefinitions(unittest.TestCase):

    def setUp(self):
        self.defs = get_tool_definitions()

    def test_returns_six_definitions(self):
        self.assertEqual(len(self.defs), 6)

    def test_all_have_type_function(self):
        for d in self.defs:
            self.assertEqual(d['type'], 'function', f"Expected type=function for {d['function']['name']}")

    def test_all_have_non_empty_name(self):
        for d in self.defs:
            self.assertGreater(len(d['function']['name']), 0)

    def test_all_have_long_descriptions(self):
        for d in self.defs:
            desc = d['function']['description']
            self.assertGreater(len(desc), 50, f"Description too short for {d['function']['name']}")

    def test_confirm_delivery_description_mentions_dispute(self):
        defs_by_name = {d['function']['name']: d for d in self.defs}
        desc = defs_by_name['arbitova_confirm_delivery']['function']['description'].lower()
        self.assertIn('dispute', desc, "confirm_delivery must mention dispute as the alternative")

    def test_confirm_delivery_description_mentions_arbitration(self):
        defs_by_name = {d['function']['name']: d for d in self.defs}
        desc = defs_by_name['arbitova_confirm_delivery']['function']['description'].lower()
        has_ref = 'arbitration' in desc or 'escalat' in desc
        self.assertTrue(has_ref, "confirm_delivery must explain auto-escalation to arbitration")

    def test_dispute_description_mentions_criteria(self):
        defs_by_name = {d['function']['name']: d for d in self.defs}
        desc = defs_by_name['arbitova_dispute']['function']['description'].lower()
        has_criteria = 'criteria' in desc or 'criterion' in desc
        self.assertTrue(has_criteria, "dispute description must mention criteria")

    def test_mark_delivered_warns_about_stable_url(self):
        defs_by_name = {d['function']['name']: d for d in self.defs}
        desc = defs_by_name['arbitova_mark_delivered']['function']['description'].lower()
        has_stable = 'stable' in desc or 'ipfs' in desc or 'permanent' in desc
        self.assertTrue(has_stable, "mark_delivered must warn about stable URL requirement")

    def test_required_params_exist_in_properties(self):
        for d in self.defs:
            fn = d['function']
            required = fn['parameters'].get('required', [])
            properties = fn['parameters'].get('properties', {})
            for param in required:
                self.assertIn(param, properties, f"{fn['name']}: required param '{param}' not in properties")

    def test_dispute_requires_reason(self):
        defs_by_name = {d['function']['name']: d for d in self.defs}
        required = defs_by_name['arbitova_dispute']['function']['parameters']['required']
        self.assertIn('reason', required)

    def test_create_escrow_requires_verification_uri(self):
        defs_by_name = {d['function']['name']: d for d in self.defs}
        required = defs_by_name['arbitova_create_escrow']['function']['parameters']['required']
        self.assertIn('verification_uri', required)


# ── Safety policy text tests ──────────────────────────────────────────────────

class TestSafetyPolicyInDescriptions(unittest.TestCase):

    def setUp(self):
        self.defs_by_name = {d['function']['name']: d for d in get_tool_definitions()}

    def test_confirm_delivery_says_only(self):
        desc = self.defs_by_name['arbitova_confirm_delivery']['function']['description']
        self.assertRegex(desc, r'(?i)only', "confirm_delivery must say ONLY call after verification")

    def test_confirm_delivery_says_do_not(self):
        desc = self.defs_by_name['arbitova_confirm_delivery']['function']['description']
        self.assertRegex(desc, r'(?i)do not|don\'t', "confirm_delivery must say DO NOT call if uncertain")

    def test_dispute_says_when_in_doubt(self):
        desc = self.defs_by_name['arbitova_dispute']['function']['description']
        self.assertRegex(desc, r'(?i)in doubt|uncertain|doubt', "dispute must say to call when in doubt")

    def test_mark_delivered_says_do_not_before_done(self):
        desc = self.defs_by_name['arbitova_mark_delivered']['function']['description']
        self.assertRegex(desc, r'(?i)do not|not.*done', "mark_delivered must warn not to call before work is done")

    def test_cancel_mentions_pending_or_deadline(self):
        desc = self.defs_by_name['arbitova_cancel_if_not_delivered']['function']['description']
        self.assertRegex(desc, r'(?i)pending|deadline', "cancel must mention pending state or deadline")

    def test_create_escrow_explains_silence_protection(self):
        desc = self.defs_by_name['arbitova_create_escrow']['function']['description']
        has_protection = 'arbitration' in desc.lower() or 'escalat' in desc.lower() or 'silence' in desc.lower()
        self.assertTrue(has_protection, "create_escrow must explain the silence = arbitration safety net")


# ── ABI exports ───────────────────────────────────────────────────────────────

class TestAbiExports(unittest.TestCase):

    def test_escrow_abi_is_list(self):
        self.assertIsInstance(ESCROW_ABI, list)
        self.assertGreater(len(ESCROW_ABI), 0)

    def test_erc20_abi_is_list(self):
        self.assertIsInstance(ERC20_ABI, list)
        self.assertGreater(len(ERC20_ABI), 0)

    def test_escrow_abi_has_create_escrow(self):
        names = [item.get('name') for item in ESCROW_ABI]
        self.assertIn('createEscrow', names)

    def test_escrow_abi_has_mark_delivered(self):
        names = [item.get('name') for item in ESCROW_ABI]
        self.assertIn('markDelivered', names)

    def test_escrow_abi_has_dispute(self):
        names = [item.get('name') for item in ESCROW_ABI]
        self.assertIn('dispute', names)

    def test_erc20_abi_has_approve(self):
        names = [item.get('name') for item in ERC20_ABI]
        self.assertIn('approve', names)


# ── Function exports ──────────────────────────────────────────────────────────

class TestFunctionExports(unittest.TestCase):

    def test_all_tools_are_callable(self):
        fns = [
            arbitova_create_escrow,
            arbitova_mark_delivered,
            arbitova_confirm_delivery,
            arbitova_dispute,
            arbitova_get_escrow,
            arbitova_cancel_if_not_delivered,
        ]
        for fn in fns:
            self.assertTrue(callable(fn), f"{fn} is not callable")

    def test_get_tool_definitions_is_callable(self):
        self.assertTrue(callable(get_tool_definitions))


# ── Error result shape tests ──────────────────────────────────────────────────

class TestErrorResultShape(unittest.TestCase):

    def test_missing_env_var_returns_ok_false(self):
        saved = os.environ.pop('ARBITOVA_RPC_URL', None)
        try:
            result = arbitova_create_escrow(
                seller='0x1234000000000000000000000000000000001234',
                amount=1.0,
                verification_uri='https://example.com/criteria.json',
            )
            self.assertEqual(result['ok'], False)
            self.assertIn('error', result)
            self.assertIn('hint', result)
        finally:
            if saved:
                os.environ['ARBITOVA_RPC_URL'] = saved

    def test_error_result_has_string_error(self):
        saved = os.environ.pop('ARBITOVA_RPC_URL', None)
        try:
            result = arbitova_dispute(escrow_id=1, reason='test')
            self.assertEqual(result['ok'], False)
            self.assertIsInstance(result['error'], str)
        finally:
            if saved:
                os.environ['ARBITOVA_RPC_URL'] = saved


# ── Status names ──────────────────────────────────────────────────────────────

class TestStatusNames(unittest.TestCase):

    def test_status_names_contains_expected_values(self):
        expected = ['PENDING', 'DELIVERED', 'CONFIRMED', 'DISPUTED', 'CANCELLED', 'RESOLVED']
        for s in expected:
            self.assertIn(s, STATUS_NAMES)

    def test_pending_is_index_zero(self):
        self.assertEqual(STATUS_NAMES[0], 'PENDING')

    def test_delivered_is_index_one(self):
        self.assertEqual(STATUS_NAMES[1], 'DELIVERED')


if __name__ == '__main__':
    unittest.main(verbosity=2)
