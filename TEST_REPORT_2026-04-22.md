# Arbitova Path B Launch Validation Report

**Started:** 2026-04-22
**Scope:** Validate `@arbitova/sdk@3.0.0` + `@arbitova/mcp-server@4.0.0` + `arbitova@2.5.1` + docs + demos after publish
**Philosophy:** every public string is a contract; docs are products; on-chain is truth

---

## Findings log

Entries append as tests run. Each entry: **[severity] test-id — title** → evidence → fix status.

Severity: **P0** (must fix before calling launch "done") · **P1** (fix this week) · **P2** (track) · **OK** (verified).

---

## T1 — API Surface Contract (P0.2)

### [P0] F-1 Python SDK escrow_id extraction silently breaks on web3.py 6.x / hexbytes <1.0
- `arbitova_create_escrow` parses `EscrowCreated` via hard-coded topic string compare:
  ```python
  if topics[0].hex() == ESCROW_CREATED_TOPIC:   # no 0x prefix
  ```
- `hexbytes` package changed `HexBytes.hex()` semantics in v1.0.0 (2023-11): pre-1.0 returned `'0x...'`, v1.0+ returns `'...'` (no prefix)
- web3.py 6.x pins `hexbytes<1.0`; web3.py 7.x pins `hexbytes>=1.2`
- Package declares `web3>=6`, so pip will resolve web3 6.x for users with older ecosystem pins
- On web3 6.x + hexbytes <1: `topics[0].hex()` = `'0x15a966…'`, `ESCROW_CREATED_TOPIC` = `'15a966…'` → never equal → **`escrow_id` silently returns `None`** → caller can't chain further operations
- Tested locally on web3 7.15.0 + hexbytes 1.3.1: works (both prefix-less)
- Fix: replace equality-on-hex with byte-level comparison, e.g.:
  ```python
  from hexbytes import HexBytes
  EXPECTED = HexBytes('0x' + ESCROW_CREATED_TOPIC)
  if HexBytes(topics[0]) == EXPECTED: …
  ```

### [P1] F-1b Python SDK ABI has zero events
- `path_b.ESCROW_ABI` → 7 functions, **0 events**
- Impact: if a user wants to subscribe to or decode events from receipts beyond the hard-coded `EscrowCreated` path, they must bring their own ABI
- Less severe than F-1 because the SDK works around it with `ESCROW_CREATED_TOPIC` constant
- Fix: port the 6 event entries from `EscrowV1.sol` into the ABI list

### [P1] F-2 Python SDK missing `escalateIfExpired`
- User-facing action: either party can call after review deadline to force arbitration
- Present in JS ABI + JS class method `escalateIfExpired()`; absent in Python ABI + Python function surface
- Result: Python users have no way to escalate a stale DELIVERED escrow from the SDK
- Fix: add `escalateIfExpired(uint256)` to Python ABI + wrap as `arbitova_escalate_if_expired()` function

### [P1] F-3 MCP server missing `escalateIfExpired` tool
- Same gap as F-2, surfaced to MCP-using agents
- An agent that wants to self-rescue after buyer/seller go silent cannot
- Fix: add `arbitova_escalate_if_expired` to `mcp-server/index.js`

### [P1] F-4 JS SDK Arbitova class has no `resolve()` method
- Python has `arbitova_resolve(escrow_id, buyer_bps, seller_bps, verdict_hash_hex)` — arbiter-only
- JS ABI doesn't even include `resolve()` selector
- Consequence: any arbiter running in JS has to build raw calls; SDK doesn't help
- Contract reality: `resolve(uint256, uint16, uint16, bytes32)` — selector `0x3cf29974`, verified from Python keccak
- Fix: add `resolve()` to JS ABI + `Arbitova.prototype.resolve(...)` arbiter-side helper (keep private-key-required, keep out of buyer/seller demos)

### [P0] F-5 MIGRATION_PATH_A_TO_B.md lies about JS flat helpers
- Line (after JS v3 code block): *"Low-level helpers (`arbitova_create_escrow(...)`) are also exported for frameworks that prefer a flat function surface."*
- Actual JS exports (v3.0.0, verified from registry tarball): `Arbitova, ERC20_ABI, ESCROW_ABI, NETWORKS, STATES`
- No `arbitova_create_escrow` JS export exists
- Fix: either add the flat helpers to JS SDK, or reword the MIGRATION guide to clarify these only exist in Python

### [P1] F-6 Python SDK leaks imports into public namespace
- `dir(path_b)` includes: `Account, Any, Dict, ExtraDataToPOAMiddleware, List, Optional, Web3, hashlib, json, os, time`
- These are module imports that appear as public attributes because no `__all__` is defined
- Autocomplete noise for users; bind risk if we switch web3 library
- Fix: add `__all__` to `python-sdk/arbitova/path_b.py`

### [OK] F-7 State enum aligned
- JS `STATES` = `["CREATED","DELIVERED","RELEASED","DISPUTED","RESOLVED","CANCELLED"]`
- Python `STATUS_NAMES` = `['CREATED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'RESOLVED', 'CANCELLED']`
- Contract enum = same order (confirmed in `contracts/src/EscrowV1.sol` historically)
- ✅ Three-way aligned

### [OK] F-8 Shared-function selectors aligned JS↔Python
- createEscrow `0x8cc107ec`, markDelivered `0x70f0fff1`, confirmDelivery `0xfd84cb97`, dispute `0x66c85dee`, cancelIfNotDelivered `0xe1e2a5f5`, getEscrow `0x7d19e596`
- Both SDKs will encode calldata identically for the 6 shared functions

### [OK] F-9 MCP server tool naming consistent with Python
- MCP: `arbitova_create_escrow, arbitova_mark_delivered, arbitova_confirm_delivery, arbitova_dispute, arbitova_get_escrow, arbitova_cancel_if_not_delivered`
- Python exposes identical names as free functions (plus extra `arbitova_resolve`)
- Frame-of-reference for LLM agents is consistent between Python and MCP

---

## T2 — Documentation Code-Block Truth Test (P0.5)

### [P0] F-10 Broken GitHub repo URL in `@arbitova/sdk` package.json
- `repository.url` = `https://github.com/jiayuanliang0716/a2a-system` → **404**
- Actual repo is `https://github.com/jiayuanliang0716-max/Arbitova`
- User-facing impact: npmjs.com page's "Repository" link is dead; GitHub-to-npm traffic breaks
- MCP server package.json is correct (`jiayuanliang0716-max/Arbitova`)
- Fix: correct `packages/sdk-js/package.json` → `repository.url`, bump to 3.0.1 or unpublish + republish

### [P1] F-11 Broken `/tree/master/demo` link in two doc files
- `packages/sdk-js/README.md` and `docs/tutorials/15-min-paid-agent.md` link to `github.com/.../tree/master/demo` → **404**
- Root cause: `demo/` is listed in `.gitignore`, so it never lands on master
- Actual demos live at `examples/demo/` (`buyer.py`, `seller.py`) + `examples/path_b/` + framework-specific files under `examples/`
- Fix: redirect links to `tree/master/examples/demo` or `tree/master/examples` (whichever matches the doc's context)

### [P1] F-12 MIGRATION.md fails to note v3 is ESM-only
- `@arbitova/sdk@3.0.0` has `"type": "module"` and no CJS build
- v2.x was almost certainly CJS; users upgrading who `require()` will hit `ERR_REQUIRE_ESM` on Node 18–21
- Doc claims "engines: node>=18" — technically works via `import`, but a silent gotcha for legacy CJS codebases
- Fix: add explicit "v3 is ESM-only; in CJS codebases use dynamic `import()` or upgrade to Node 22+ which supports `require()` of ESM" to MIGRATION.md

### [OK] F-13 JS SDK method signatures match README + MIGRATION examples
- `Arbitova.fromPrivateKey({ privateKey, network, rpcUrl })` ✅
- `buyer.createEscrow({ seller, amount, deliveryHours, reviewHours, verificationURI })` ✅ returns `{escrowId, txHash, buyer, seller, amount, deliveryDeadline, verificationURI}` (docs destructure `{escrowId, txHash}` — subset OK)
- `buyer.markDelivered({ escrowId, deliveryPayloadURI })` ✅
- `buyer.confirmDelivery(escrowId)` ✅ (bare param, not object — inconsistent but matches docs)
- `buyer.dispute(escrowId, reason)` ✅

### [OK] F-14 Python SDK signatures match MIGRATION example
- `arbitova_create_escrow(seller, amount, delivery_window_hours=24, review_window_hours=24, verification_uri='')` ✅
- Returns `{"ok", "tx_hash", "escrow_id"}` ✅

### [OK] F-15 URL health (25 URLs extracted from 5 doc files)
- 22/25 return 200
- 2/25 return 405 (Base RPC HEAD not supported — expected; GET works)
- 1/25 returns 404 → F-11 above
- 2/25 return 403 (npmjs.com anti-scrape HEAD — GET works)
- No silently broken links beyond F-11

### [OK] F-16 README lifecycle diagram + copy matches contract
- `CREATED → DELIVERED → {RELEASED | DISPUTED → RESOLVED | CANCELLED}` matches EscrowV1 state machine
- "No auto-release after timeout" claim matches `escalateIfExpired` contract implementation (expired review window → DISPUTED not RELEASED)
- "Non-custodial, contract holds funds" messaging consistent with Path B

---

## T6 — ABI Drift vs Deployed Bytecode (P0.3)

### [OK] F-17 All 10 SDK function selectors present in deployed bytecode
- Contract: `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC` (Base Sepolia, production)
- Bytecode length: 15,344 bytes
- Selectors verified by grep in `eth_getCode` output:
  - `0x8cc107ec createEscrow(address,uint256,uint64,uint64,string)` ✅
  - `0x70f0fff1 markDelivered(uint256,bytes32)` ✅
  - `0xfd84cb97 confirmDelivery(uint256)` ✅
  - `0x66c85dee dispute(uint256,string)` ✅
  - `0xe1e2a5f5 cancelIfNotDelivered(uint256)` ✅
  - `0x3cf29974 resolve(uint256,uint16,uint16,bytes32)` ✅
  - escalateIfExpired ✅
  - `0x7d19e596 getEscrow(uint256)` ✅
  - `nextEscrowId()` ✅
  - `releaseFeeBps()` / `resolveFeeBps()` ✅
- No ABI drift between published SDK and on-chain code

### [OK] F-18 Fee parameters match RFC
- On-chain `releaseFeeBps()` = **50** → 0.5% release fee ✅ (matches spec)
- On-chain `resolveFeeBps()` = **200** → 2% dispute-resolution fee ✅ (matches spec)

### [P1] F-19 Production contract has zero observed usage
- `nextEscrowId()` on prod `0xA8a0…88fC` returns **1** → no escrows have ever been created on the production address
- All Sepolia E2E validation in `SEPOLIA_E2E_REPORT.md` was run against **test** contract `0x331cE65982Dd879920fA00195e70bF77f18AB61A` with Mock USDC, not the prod address pinned in docs
- Implication: docs direct users to `0xA8a0…88fC` + real Circle USDC `0x036CbD…CF7e`, but we've never proven a full happy-path + fee-split against that pairing on-chain
- Risk: a currency-decimal or approval-path bug in real Circle USDC (vs Mock which we wrote ourselves) would ship undetected
- Fix: run at least one end-to-end flow on the prod pairing (even a tiny 0.01 USDC) before public launch, OR flag the test-contract caveat explicitly in docs

### [P2] F-20 ABI format divergence JS vs Python
- JS SDK ships ABI as **ethers v6 human-readable strings** (16 entries), Python ships as **solc-style JSON fragments** (7 entries, no events)
- Both encode to identical calldata — not a correctness issue
- But cross-language tooling (e.g., a Go agent borrowing our ABI) has to pick a format
- Fix: publish `ESCROW_ABI_SOLC_JSON` as a resource on the MCP server + in `@arbitova/sdk` for parity; already half-done (MCP has `arbitova://resources/escrow-abi`)

---

## T5 — MCP Server Cold-Boot Smoke (P0.4)

### [OK] F-21 `npx -y @arbitova/mcp-server@4.0.0` cold-boot succeeds
- Environment: clean /tmp dir, no prior install, env set to `ARBITOVA_RPC_URL=sepolia.base.org` + escrow/usdc addresses, **no private key** (forces read-only mode)
- Driven via stdio handshake: `initialize` → `notifications/initialized` → `tools/list` → `resources/list`
- Server stderr: `[Arbitova MCP] v4.0.0 started. Mode: READ-ONLY. Escrow: 0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC` ✅
- `initialize` result: `server: arbitova@4.0.0, proto: 2024-11-05` ✅
- `tools/list` returns exactly 6 tools with correct names: `create_escrow, mark_delivered, confirm_delivery, dispute, get_escrow, cancel_if_not_delivered` ✅
- `resources/list` returns exactly 4 resources: 3 prompt docs + ABI JSON ✅
- No crash, no unhandled rejection, no mismatched schema
- Conclusion: Glama sandbox introspection path is safe — server boots without keys and surfaces full schema

---

## T7 — Secrets Scan (P1.8)

### [OK] F-22 Published tarballs contain zero live secrets
- Downloaded `@arbitova/sdk@3.0.0` + `@arbitova/mcp-server@4.0.0` tarballs from npm registry
- Scanned all files against patterns: `sk-ant-*, sk-proj-*, npm_*, pypi-*, rnd_*, xsmtpsib-*, eyJ0eXAi (JWT), postgres(ql)://, 0x[hex]{64} (private keys), arbitovaadmin*, a2a-admin-*`
- **0 hits.** All `apiKey`/`privateKey`/`token` references are documentation examples using `process.env.*` or README placeholders like `"0x..."`

### [P1] F-23 Pre-rotation `ADMIN_KEY` leaked to master git history (already rotated)
- Commit `58d5c929934879929a5f01317b487f6d10ee7654` ("Update progress log and demo for 2026-04-11") on branch `master` contains the literal string `ADMIN_KEY：a2a-admin-2026` in a progress doc
- ⚠️ **Mitigated**: per `project_arbitova_path_b.md`, user rotated this key in Render on 2026-04-21 → current value is `arbitovaadmin2026`. The leaked string is a dead credential.
- Remaining concern: establishes a bad precedent; scanning bots (TruffleHog, GitGuardian) may still flag the repo
- Fix options: (a) do nothing — key is rotated; (b) rewrite history with `git filter-repo --replace-text`; (c) publish a `SECURITY.md` that acknowledges rotation. **Recommend (a)+(c)**: rewriting public history on `jiayuanliang0716-max/Arbitova` forces everyone with a clone to rebase, and the credential is already dead.

### [P0] F-24 Current live `ADMIN_KEY` exists in plain text on Desktop
- File: `C:\Users\perfu\Desktop\api keys.txt` (unencrypted, readable by any local process)
- Contains live: `ADMIN_KEY=arbitovaadmin2026`, live npm token, live PyPI token, live Render API key, live DB connection string with password, Anthropic + OpenAI keys, Telegram bot token, Brevo SMTP key, wallet encryption key, Supabase service role key
- Risk: any local exploit (malware, supply-chain attack on any installed tool, even a typosquatted npm package run in a different dir) can read this file
- Fix: migrate to a password manager (1Password / Bitwarden), delete the plaintext file, confirm .claude auto-memory `~/redact-claude-secrets.sh` still runs as documented in `reference_redact_script.md`

### [P2] F-25 Git stash commit `bfad8472` contains CLAUDE.md with operational assistant config (personal)
- Reachable via reflog, references local paths `C:\Users\perfu\a2a-system\`
- No secrets embedded but leaks personal OS layout and assistant persona
- Not on public remote (verified: that SHA is not in `origin/master` or any pushed branch's tip ancestors — it's a local WIP stash)
- Fix: `git stash drop` or let it garbage-collect after 90 days

---

## T10 — Legal / Brand Surface Scan (P2.12)

### [OK] F-26 Live user-facing docs have zero uncontextualized legacy-Path-A terms
- Scanned all `*.md` in repo + `packages/` for forbidden terms: `custody, custodial, subscription, plan, tier, quota, marketplace, 60 tools, 49 tools`
- All hits fall into three legitimate buckets:
  1. **Comparative narrative** — "v2 was custodial, v3 is non-custodial", "This is NOT a marketplace", "no Pro tier, no subscription" (`README.md:27, 157` / `packages/sdk-js/README.md:30, 179` / `spec/A2A-ESCROW-RFC-v0.1.md`)
  2. **Migration guides** — v2→v3 and Path A→Path B docs legitimately describe the old model
  3. **Historical** — `CHANGELOG.md` (intentionally immutable), `reports/overnight-handoff-2026-04-22.md` (internal handoff log)
- No live-facing page claims the current product is custodial, has tiers, or is a marketplace

### [P2] F-27 `examples/claude_managed_agents.md` is Path A legacy + properly flagged
- File leads with `⚠️ This example targets Arbitova Path A (the deprecated custodial API) and will not run against @arbitova/mcp-server@4.x`
- Flag is prominent; user-action: either port to Path B or delete after one more release cycle to shed legacy

### [P2] F-28 `CHANGELOG.md` line 14 reads "MCP v3.3.0: … (60 tools total)"
- This is a historical entry and factually correct for that version
- Risk: someone grepping "60 tools" on GitHub might quote it out of context
- Fix: add a note at top of CHANGELOG: "v4.0.0 is Path B — 6 tools. Entries below describe deprecated Path A versions."

---

## T3 — Fresh Install Matrix (P0.1)

### [OK] F-29 JS SDK clean-dir install passes on Node 24.14.0
- `npm init -y && npm install @arbitova/sdk@3.0.0` in empty dir → 10 transitive packages, 0 vulnerabilities
- `npm audit` clean

### [P0] F-30 `pip install arbitova` yields silently-degraded client — web3 is an optional extra
- PyPI metadata declares `web3>=6` only under `extras_require['path-b']` (+ `eth-hash[pycryptodome]>=0.5`, `eth-account>=0.9`)
- Default `pip install arbitova==2.5.1` installs only `httpx` and friends. **No web3.**
- `arbitova.path_b` module imports web3 in a `try/except` → silently sets `_WEB3_AVAILABLE=False`
- Effect:
  - `import arbitova.path_b` succeeds
  - `arbitova_create_escrow(...)` succeeds calling but returns `{'ok': False, 'error': 'web3 package is required for Path B. Install with: pip install web3'}`
  - Error message is technically correct but users following the doc's `pip install arbitova` + quickstart will see a generic "ok: False" JSON dict and only notice by reading the `error` field — easy to miss in LLM agent loops where JSON responses are summarized
- Also: the hint `pip install web3` is **incomplete** — user still needs `eth-account` for key derivation; correct command is `pip install 'arbitova[path-b]'`
- Fix options, in order of preference:
  1. Promote web3 + eth-account + eth-hash to **required** dependencies in 2.5.2 (recommended — there is no reason to install arbitova without Path B)
  2. At minimum, fix the error hint to say `pip install 'arbitova[path-b]'` instead of `pip install web3`
  3. Update README/quickstart to document the extra: `pip install 'arbitova[path-b]'`
- Tested on: Python 3.14.0 (classifier only declares 3.9–3.12 — add 3.13/3.14 to classifiers)

### [P1] F-31 `Project-URL: Documentation` in PyPI metadata points at Path A
- METADATA: `Project-URL: Documentation, https://a2a-system.onrender.com/docs`
- That URL serves the legacy Path A REST docs; Path B users should be routed to `https://arbitova.com/learn` or `https://github.com/jiayuanliang0716-max/Arbitova#readme`
- PyPI project page shows that link under "Documentation"; click-through leads users to an API-key signup flow that no longer maps to the SDK they just installed
- Fix: update `pyproject.toml` `[project.urls]` `Documentation` → repo README, bump to 2.5.2

### [P2] F-32 Classifiers claim 3.9–3.12 but 2.5.1 works on 3.14
- Not a bug, but PyPI's search/filter picks the declared classifiers; 3.13 and 3.14 users won't find arbitova via version filter
- Fix: add `Programming Language :: Python :: 3.13` and `3.14` classifiers in 2.5.2

---

## Running tally (post-T3)

- **P0 open:** 6 (F-1, F-5, F-10, F-24, F-30, prod-contract E2E gap in F-19)
- **P1 open:** 9 (F-1b, F-2, F-3, F-4, F-6, F-11, F-12, F-23, F-31)
- **P2 open:** 5 (F-20, F-25, F-27, F-28, F-32)
- **OK verified:** 13

---

## T4 — Sepolia E2E Four Flows (P0.3)

Live chain state verified via `scripts/e2e-verify.js` against both test and prod contracts. No new gas spent.

### [OK] F-33 Test contract `0x331cE65982Dd879920fA00195e70bF77f18AB61A` has 6 prior escrows in consistent states
- nextEscrowId = 7 → 6 escrows executed
- Escrows 1, 3, 5: **RELEASED** (happy path — create → mark → confirm → release)
- Escrows 4, 6: **RESOLVED** (full arbitration — create → mark → dispute → resolve with bps split)
- Escrows 1/3/5 match `SEPOLIA_E2E_REPORT.md:happy-flow`; 4/6 match dispute-flow
- Escrow 2 is in **DISPUTED** state — never resolved. Not a contract bug; arbiter `resolve()` was not invoked for that one. Cosmetic loose end on the test contract.
- Fee parameters on-chain: `releaseFeeBps=50` / `resolveFeeBps=200` ✅
- This confirms two of the four P0 flows (RELEASED via confirm; RESOLVED via dispute+resolve) are live-verified on Base Sepolia

### [P1] F-34 CANCEL flow not live-tested on Sepolia (tested locally on anvil only)
- Contract has minimum 3600-sec delivery window (`sepolia_e2e.js:121` comment: "1h delivery window (MIN)")
- Firing cancel flow on Sepolia requires a real 1-hour wait for `deliveryDeadline` to pass before `cancelIfNotDelivered` can be called
- Memory confirms: "47/47 Foundry tests pass, 100% line coverage" + "local Anvil e2e: happy / dispute 70-30 / timeout escalation — all PASS" — so the flow is covered by unit + local-integration tests
- Gap: no on-chain Sepolia tx proving the cancel state transition works on a real RPC with real gas accounting
- Recommend: before mainnet, schedule a single Sepolia cancel test (one `create` + one-hour wait + one `cancelIfNotDelivered`) and pin the tx in the E2E report

### [P1] F-35 Review-expiry → DISPUTED (no-auto-release) flow not live-tested on Sepolia
- Same 3600-sec minimum-window constraint applies to `reviewDeadline`
- Total real-time to execute end-to-end = ≥2 hours (1h delivery window + 1h review window)
- Memory confirms local Anvil `timeout escalation` flow passes — critical invariant ("silence ≠ release") is unit-tested
- Gap: no Sepolia proof of the `escalateIfExpired` state machine transition (expired DELIVERED → DISPUTED, not RELEASED)
- This flow is the **single most important differentiator from Path A** (silence is safer than wrong confirmation). It should have a named Sepolia tx before Stage-3 mainnet gate.
- Recommend: script a "nightly overnight" Sepolia test that creates escrow with min-windows, marks delivered, and calls `escalateIfExpired` 1h+1h later; publish tx hashes in a `SEPOLIA_E2E_REPORT_v2.md`

### [P0] F-36 Production contract `0xA8a0…88fC` has zero observed state transitions (reaffirms F-19)
- `nextEscrowId() = 1` → not a single escrow has ever been created on the address that docs + npm READMEs + grants applications all point users toward
- All E2E validation ran against the **test** EscrowV1 + Mock USDC pair, not the prod EscrowV1 + real Circle USDC pair
- Pre-mainnet risk: an approval-path bug specific to real Circle USDC's 6-decimal transfer semantics, permit support, or `transferFrom` hooks would not have been exercised
- Minimum-viable closure: one full happy-path with 0.01 real Circle USDC on the prod contract before declaring "Path B is live on Sepolia"

---

## Running tally (post-T4)

- **P0 open:** 6 (F-1, F-5, F-10, F-24, F-30, F-36)
- **P1 open:** 11 (F-1b, F-2, F-3, F-4, F-6, F-11, F-12, F-23, F-31, F-34, F-35)
- **P2 open:** 5 (F-20, F-25, F-27, F-28, F-32)
- **OK verified:** 14

---

## What still hasn't been tested

- **T8** Semantic alignment JS/Python/MCP (cross-language equivalence test — create escrow in JS, read in Python, cancel via MCP — verify all three produce identical on-chain state)
- **T9** Integration demo replays (LangGraph / CrewAI / Claude Agent SDK demos against v3 SDK)
- Load / concurrency: how does arbitova_create_escrow behave under 10+ simultaneous txs from the same wallet? (Nonce management untested)
- Real Circle USDC approval flow (blocked on faucet captcha; F-36)
- Contract-level reentrancy / re-org / malleability — these are Foundry-test territory, already 47/47 pass

---

## Fixes applied in-repo (awaiting republish)

**Doc / metadata (safe to push without republish — docs-only):**
- F-5 → `sdk/MIGRATION_PATH_A_TO_B.md` line 57: removed false "JS flat helpers exist" claim, replaced with correct JS-class-vs-Python-flat distinction
- F-11 → `packages/sdk-js/README.md` + `docs/tutorials/15-min-paid-agent.md`: `tree/master/demo` → `tree/master/examples` (links now resolve)
- F-28 → `CHANGELOG.md` top: added architecture note flagging that all below-entries describe deprecated Path A

**Source changes (require republish to take effect):**
- F-10 → `packages/sdk-js/package.json` repository URL: `a2a-system` → `Arbitova` (canonical; old URL 404s on npm registry page)
  - **Republish needed:** `@arbitova/sdk@3.0.1` — user must run `npm publish` from `packages/sdk-js/` with npm token
- F-1 + F-6 + F-30 → `python-sdk/arbitova/path_b.py` + `pyproject.toml`:
  - Version bump 2.5.1 → 2.5.2
  - `web3>=6, eth-hash, eth-account` promoted from `[path-b]` extra to **required** deps
  - Byte-level comparison for `EscrowCreated` topic (not `HexBytes.hex()` string compare) — works across hexbytes <1.0 and >=1.0
  - Added `__all__` to stop leaking `Web3, Account, os, json, time, hashlib` as public attrs
  - Docstring `Dependencies:` line updated
  - Error hint now says `pip install --upgrade arbitova`, not `pip install web3`
  - Documentation URL in `[project.urls]`: `a2a-system.onrender.com/docs` (Path A) → GitHub README
  - Added Python 3.13 + 3.14 classifiers
  - **Republish needed:** `arbitova==2.5.2` — user must run `python -m build && twine upload dist/*` with PyPI token

**Still open, user-action required:**
- F-24 — plaintext keys on `C:\Users\perfu\Desktop\api keys.txt`: move to password manager, delete file
- F-36 — one real-USDC happy-path flow on prod EscrowV1 before mainnet gate
- F-34, F-35 — Sepolia cancel + review-expiry flows (need 1-2h real-time waits)
- F-2, F-3, F-4 — `escalateIfExpired` added to Python SDK + MCP + JS `resolve()` helper (separate follow-up PR)
