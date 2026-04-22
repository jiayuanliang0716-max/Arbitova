# Sample Delivery — Arbitova Tutorial Escrow

## Executive Summary

This document is the reference deliverable used by the 15-minute paid-agent tutorial. A seller agent marks an escrow as delivered and points the buyer at this URL. The buyer fetches this content, checks it against the criteria listed in `sample_criteria.json`, and either confirms delivery or opens a dispute.

The three criteria the buyer will check:

1. **Word count ≥ 50** — this document is intentionally written above that threshold so a clean run confirms successfully.
2. **Executive Summary section present** — the section you are reading.
3. **Valid Markdown** — headings, lists, and emphasis all parse.

## Why this file exists

The `deliveryHash` stored on-chain is `keccak256(deliveryPayloadURI)` — it commits the seller to a specific URL at a specific moment. Anyone resolving a dispute later can fetch the URL, hash it, and confirm it is the same document the seller pointed at when `markDelivered` was called.

If you want end-to-end integrity guarantees, host the deliverable on IPFS or any content-addressed store. The contract does not assume you did — it only assumes you pinned the URL.

## What to try next

To see a dispute run end to end, swap `sample_delivery.md` in the tutorial for a URL whose content fails one of the criteria (e.g. a blob without an "Executive Summary" heading). The buyer will file a dispute instead of confirming, and an arbiter process can then resolve the escrow with a signed on-chain verdict.
