import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideSponsorship,
  ESCROW_SELECTORS,
  USDC_APPROVE_SELECTOR,
} from "../src/index.js";

const ESCROW = "0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC";
const USDC   = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const OTHER  = "0x000000000000000000000000000000000000dEaD";

const baseCfg = {
  escrowAddress: ESCROW,
  usdcAddress: USDC,
  perOpGasCeilingWei: 10_000_000_000_000_000n.toString(), // 0.01 ETH
};

const baseBudget = {
  spentTodayWei: "0",
  dailyBudgetWei: 100_000_000_000_000_000n.toString(), // 0.1 ETH
};

test("sponsors valid createEscrow call", () => {
  const result = decideSponsorship(
    {
      callTarget: ESCROW,
      callSelector: ESCROW_SELECTORS.createEscrow,
      estGasCostWei: "1000000000000000", // 0.001 ETH
    },
    baseCfg,
    baseBudget,
  );
  assert.equal(result.sponsor, true);
});

test("sponsors valid USDC approve(escrow)", () => {
  const result = decideSponsorship(
    {
      callTarget: USDC,
      callSelector: USDC_APPROVE_SELECTOR,
      callApproveSpender: ESCROW,
      estGasCostWei: "500000000000000",
    },
    baseCfg,
    baseBudget,
  );
  assert.equal(result.sponsor, true);
});

test("rejects USDC approve to non-escrow spender", () => {
  const result = decideSponsorship(
    {
      callTarget: USDC,
      callSelector: USDC_APPROVE_SELECTOR,
      callApproveSpender: OTHER,
      estGasCostWei: "500000000000000",
    },
    baseCfg,
    baseBudget,
  );
  assert.equal(result.sponsor, false);
  assert.match(result.reason, /approve must target escrow/);
});

test("rejects non-approve USDC call", () => {
  const result = decideSponsorship(
    {
      callTarget: USDC,
      callSelector: "0xa9059cbb", // transfer
      estGasCostWei: "500000000000000",
    },
    baseCfg,
    baseBudget,
  );
  assert.equal(result.sponsor, false);
  assert.match(result.reason, /must be approve/);
});

test("rejects escrow call with unknown selector", () => {
  const result = decideSponsorship(
    {
      callTarget: ESCROW,
      callSelector: "0xdeadbeef",
      estGasCostWei: "500000000000000",
    },
    baseCfg,
    baseBudget,
  );
  assert.equal(result.sponsor, false);
  assert.match(result.reason, /not in allow-list/);
});

test("rejects arbitrary third-party target", () => {
  const result = decideSponsorship(
    {
      callTarget: OTHER,
      callSelector: ESCROW_SELECTORS.createEscrow,
      estGasCostWei: "500000000000000",
    },
    baseCfg,
    baseBudget,
  );
  assert.equal(result.sponsor, false);
  assert.match(result.reason, /neither escrow nor usdc/);
});

test("rejects when per-op gas exceeds ceiling", () => {
  const result = decideSponsorship(
    {
      callTarget: ESCROW,
      callSelector: ESCROW_SELECTORS.confirmDelivery,
      estGasCostWei: "50000000000000000", // 0.05 ETH, > ceiling 0.01
    },
    baseCfg,
    baseBudget,
  );
  assert.equal(result.sponsor, false);
  assert.match(result.reason, /exceeds ceiling/);
});

test("rejects when daily budget would overflow", () => {
  const result = decideSponsorship(
    {
      callTarget: ESCROW,
      callSelector: ESCROW_SELECTORS.confirmDelivery,
      estGasCostWei: "5000000000000000", // 0.005 ETH
    },
    baseCfg,
    {
      spentTodayWei: "99000000000000000", // 0.099 ETH already spent
      dailyBudgetWei: "100000000000000000", // 0.1 ETH cap
    },
  );
  assert.equal(result.sponsor, false);
  assert.match(result.reason, /daily budget exceeded/);
});

test("handles mixed-case addresses", () => {
  const result = decideSponsorship(
    {
      callTarget: ESCROW.toUpperCase(),
      callSelector: ESCROW_SELECTORS.dispute,
      estGasCostWei: "500000000000000",
    },
    {
      escrowAddress: ESCROW.toLowerCase(),
      usdcAddress: USDC.toLowerCase(),
      perOpGasCeilingWei: baseCfg.perOpGasCeilingWei,
    },
    baseBudget,
  );
  assert.equal(result.sponsor, true);
});

test("rejects empty op", () => {
  const result = decideSponsorship(null, baseCfg, baseBudget);
  assert.equal(result.sponsor, false);
});

test("rejects when cfg missing addresses", () => {
  const result = decideSponsorship(
    {
      callTarget: ESCROW,
      callSelector: ESCROW_SELECTORS.createEscrow,
      estGasCostWei: "500000000000000",
    },
    { escrowAddress: "", usdcAddress: USDC },
    baseBudget,
  );
  assert.equal(result.sponsor, false);
  assert.match(result.reason, /missing contract addresses/);
});
