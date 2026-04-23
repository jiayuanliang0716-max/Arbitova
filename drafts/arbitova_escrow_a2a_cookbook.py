# ---
# jupyter:
#   jupytext:
#     formats: py:percent
#     text_representation:
#       extension: .py
#       format_name: percent
#       format_version: '1.3'
#       jupytext_version: 1.16.4
#   kernelspec:
#     display_name: Python 3
#     language: python
#     name: python3
# ---
#
# Source of truth for the Anthropic Cookbook PR:
#   third_party/Arbitova/arbitova_escrow_a2a.ipynb
#
# This file uses jupytext percent format so diffs are reviewable in git.
# Convert to .ipynb before filing the cookbook PR:
#
#   pip install jupytext
#   jupytext --to ipynb drafts/arbitova_escrow_a2a_cookbook.py \
#     -o /path/to/anthropic-cookbook/third_party/Arbitova/arbitova_escrow_a2a.ipynb

# %% [markdown]
# # A2A commerce with Claude agents: non-custodial USDC escrow on Base
#
# When one Claude agent hires another — to summarize a page, translate a
# document, run a vision task — someone has to hold the money between
# "I want this" and "that was good, pay them." The obvious answer is a
# platform in the middle. The less obvious answer, and the one this
# notebook demonstrates, is a **smart contract** in the middle: funds
# locked on-chain, released by the buyer on acceptance, or split by a
# neutral arbiter on dispute.
#
# [Arbitova](https://arbitova.com) is a non-custodial USDC escrow
# protocol on Base built for exactly this case. There is no Arbitova
# account, no listing fee, no custody — the protocol is `EscrowV1.sol`
# and a Python / JS SDK that wraps it. This notebook walks a Claude
# agent (built with the Claude Agent SDK) through a full buyer-side
# workflow against **Base Sepolia testnet**:
#
# 1. Read a seller's public listing (price, delivery criteria).
# 2. Decide whether to hire given a budget.
# 3. Lock USDC on-chain via `createEscrow`.
# 4. Hire the seller (in-notebook demo: seller is an inline function;
#    in production it's another agent at another org behind an HTTP
#    endpoint, exactly like the real [a2a-system demo](https://github.com/jiayuanliang0716-max/a2a-system)).
# 5. Download the delivery, verify every criterion in the listing.
# 6. Call `confirmDelivery` on success, or `dispute` on failure.
#
# The dispute path resolves on-chain via an arbiter with a pre-committed
# [transparency policy](https://github.com/jiayuanliang0716-max/a2a-system/blob/master/docs/transparency-policy.md):
# every verdict, full arbiter reasoning, ensemble vote breakdown, and
# internal re-audit result is published per-case at
# [arbitova.com/verdicts](https://arbitova.com/verdicts). We demonstrate
# the happy path here; the dispute path is summarized in the closing
# section with links to the live examples.
#
# **Why cookbook-shaped.** The existing `tool_use/` cookbook entries
# show Claude calling tools; this shows Claude calling tools that
# **move money**, which is the hard part of A2A commerce, and a
# realistic demonstration of how non-custodial payments fit an agent
# loop.
#
# **Dependencies**
#
# | Package | Purpose |
# |---|---|
# | `arbitova>=2.5.2` | Python SDK for EscrowV1 — create/confirm/dispute wrappers |
# | `claude-agent-sdk>=0.1.0` | The agent loop this notebook is a cookbook entry for |
# | `anthropic>=0.40` | Used by the inline seller worker to generate the summary |
# | `httpx`, `python-dotenv` | Standard |
#
# **What you need before running**
#
# - A Base Sepolia RPC URL (`https://sepolia.base.org` works).
# - Two Base Sepolia private keys (buyer + seller — for this demo they
#   are both yours; in production they are two different organizations).
# - A few Sepolia USDC in the buyer wallet ([faucet here](https://faucet.circle.com)).
# - A pinch of Sepolia ETH in both wallets for gas.
# - An `ANTHROPIC_API_KEY`.
#
# **This notebook deploys nothing.** It talks to the production EscrowV1
# Arbitova deploys on Base Sepolia at
# `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC`.

# %%
# !pip install --quiet "arbitova>=2.5.2" "claude-agent-sdk>=0.1.0" "anthropic>=0.40" httpx python-dotenv

# %% [markdown]
# ## 1. Environment
#
# Keys are read from env vars. In a notebook, either export them before
# launching Jupyter, or fill the cell below (do **not** commit).

# %%
import os
import hashlib
import json
import pathlib
import asyncio

# Public Arbitova deployment on Base Sepolia — identical for everyone.
os.environ["ARBITOVA_RPC_URL"] = os.environ.get("ARBITOVA_RPC_URL", "https://sepolia.base.org")
os.environ["ARBITOVA_ESCROW_ADDRESS"] = "0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC"
os.environ["ARBITOVA_USDC_ADDRESS"] = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

# Your two Sepolia keys (buyer + seller for this demo). In production the
# seller would be another agent at a different organization.
BUYER_PK = os.environ["BUYER_PK"]          # your primary Sepolia key
SELLER_PK = os.environ["SELLER_PK"]        # your secondary Sepolia key
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]

# Where the seller will drop the delivery file (plus a tiny HTTP server
# is unnecessary for this demo — the buyer agent reads from the local
# path directly, and the on-chain pin is still a keccak256 of the bytes).
DELIVERY_DIR = pathlib.Path("./arbitova_deliveries")
DELIVERY_DIR.mkdir(exist_ok=True)

print("Arbitova EscrowV1:", os.environ["ARBITOVA_ESCROW_ADDRESS"])

# %% [markdown]
# ## 2. The seller side (inline for this demo)
#
# In the real A2A world the seller is another agent running on another
# server. For the cookbook we put it inline: a function that takes a
# URL, asks Claude Haiku to summarize it, saves the delivery to a local
# file, and pins the content hash on-chain via `markDelivered`.
#
# The important protocol detail: the seller pins the **keccak256 of
# the delivery content bytes**, not of the URL. That means swapping
# the file after handover is detectable — the buyer (and arbiter)
# recompute the hash from the bytes they see and compare.
#
# This is also the seller's public listing — price, delivery criteria,
# verification URL. The buyer agent reads this before deciding to hire.

# %%
SELLER_LISTING = {
    "agent_name": "summarizer-001 (cookbook demo)",
    "service": "Summarize a web page in 150-250 words",
    "price_usdc": 1.0,
    "delivery_window_hours": 1,
    "review_window_hours": 1,
    "verification_criteria": [
        "Exactly one summary, 150-250 words.",
        "References the source URL exactly once at the start.",
        "No markdown headers, no bullet points, no preamble.",
        "Same primary language as the source page.",
    ],
    "hire_endpoint": "in-notebook://seller",
}

# %%
from anthropic import Anthropic
import httpx

_anthropic = Anthropic(api_key=ANTHROPIC_API_KEY)


def simulate_seller_delivery(escrow_id: int, source_url: str) -> tuple[str, bytes]:
    """Seller-side worker.

    1. Fetches the source URL (truncated).
    2. Asks Claude Haiku for a summary meeting the listing criteria.
    3. Writes the delivery JSON to disk.
    4. Switches to the seller wallet and calls `markDelivered` on-chain,
       pinning keccak256(content_bytes) so the buyer can detect any
       post-handover tampering.

    Returns (local_delivery_uri, content_bytes). In production the URI
    would be a stable public URL the buyer can GET.
    """
    # Fetch source
    with httpx.Client(timeout=20.0, follow_redirects=True) as c:
        src = c.get(source_url, headers={"User-Agent": "ArbitovaCookbookDemo/1.0"}).text

    # Ask Claude for the summary
    criteria = "\n".join(f"- {c}" for c in SELLER_LISTING["verification_criteria"])
    prompt = (
        f"Source URL: {source_url}\n\n"
        f"Source content (truncated to 12000 chars):\n---\n{src[:12000]}\n---\n\n"
        f"Delivery criteria:\n{criteria}\n\n"
        f"Write ONLY the summary. No preamble."
    )
    msg = _anthropic.messages.create(
        model="claude-haiku-4-5",
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}],
    )
    summary = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text").strip()

    # Persist delivery
    payload = {
        "escrow_id": escrow_id,
        "source_url": source_url,
        "summary": summary,
        "word_count": len(summary.split()),
    }
    path = DELIVERY_DIR / f"delivery_{escrow_id}.json"
    content_bytes = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    path.write_bytes(content_bytes)
    delivery_uri = f"file://{path.resolve().as_posix()}"

    # Swap env to the seller key and pin the content hash on-chain.
    from arbitova.path_b import arbitova_mark_delivered
    saved_pk = os.environ.get("ARBITOVA_AGENT_PRIVATE_KEY")
    try:
        os.environ["ARBITOVA_AGENT_PRIVATE_KEY"] = SELLER_PK
        result = arbitova_mark_delivered(
            escrow_id,
            delivery_uri,
            delivery_content_bytes=content_bytes,
        )
    finally:
        if saved_pk is None:
            os.environ.pop("ARBITOVA_AGENT_PRIVATE_KEY", None)
        else:
            os.environ["ARBITOVA_AGENT_PRIVATE_KEY"] = saved_pk

    if not result.get("ok"):
        raise RuntimeError(f"markDelivered failed: {result}")
    print(f"[seller] wrote delivery to {path.name}; on-chain tx {result['tx_hash']}")
    return delivery_uri, content_bytes


# Quick address report so the buyer can target the seller correctly.
from eth_account import Account
SELLER_ADDRESS = Account.from_key(SELLER_PK).address
BUYER_ADDRESS = Account.from_key(BUYER_PK).address
print("Buyer:", BUYER_ADDRESS)
print("Seller:", SELLER_ADDRESS)

# %% [markdown]
# ## 3. The buyer agent (Claude Agent SDK)
#
# This is the cookbook's center of gravity: a Claude agent with six
# tools — enough to run the full A2A payment loop. The tools are thin
# wrappers around `arbitova.path_b` (create / confirm / dispute / read)
# plus two glue tools (fetch the seller's listing, trigger the seller
# worker).
#
# The agent is given a budget ceiling and the verification criteria
# discipline: it **must** run through every criterion before deciding
# to pay, and the `confirm_delivery` tool refuses to fire unless passed
# a structured verification report. This prevents the most obvious
# agent-payment failure mode — agent-pays-because-finished.

# %%
from claude_agent_sdk import (
    query,
    tool,
    create_sdk_mcp_server,
    ClaudeAgentOptions,
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
    ToolResultBlock,
)

from arbitova.path_b import (
    arbitova_create_escrow,
    arbitova_confirm_delivery,
    arbitova_dispute,
    arbitova_get_escrow,
    verify_delivery_hash,
)


def _ok(payload: dict) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]}


# Ensure the SDK uses the BUYER key while the agent is running.
os.environ["ARBITOVA_AGENT_PRIVATE_KEY"] = BUYER_PK


@tool(
    "fetch_seller_listing",
    "Fetch the seller agent's public listing (name, price, criteria, hire endpoint).",
    {},
)
async def fetch_seller_listing(args):
    return _ok({"listing": SELLER_LISTING})


@tool(
    "create_escrow",
    "Lock USDC on Arbitova EscrowV1. Returns escrow_id and tx_hash.",
    {
        "seller_address": str,
        "amount_usdc": float,
        "delivery_window_hours": int,
        "review_window_hours": int,
        "verification_uri": str,
    },
)
async def create_escrow(args):
    return _ok(arbitova_create_escrow(
        seller=args["seller_address"],
        amount=args["amount_usdc"],
        delivery_window_hours=args["delivery_window_hours"],
        review_window_hours=args["review_window_hours"],
        verification_uri=args["verification_uri"],
    ))


@tool(
    "hire_seller",
    "Trigger the seller to produce the delivery for this escrow. In prod this is an HTTP call; in this notebook it invokes the inline seller.",
    {"escrow_id": int, "task_url": str},
)
async def hire_seller(args):
    delivery_uri, _bytes = simulate_seller_delivery(args["escrow_id"], args["task_url"])
    return _ok({"ok": True, "delivery_uri": delivery_uri})


@tool(
    "get_escrow_status",
    "Read on-chain state (CREATED / DELIVERED / RELEASED / DISPUTED / RESOLVED / CANCELLED) and the pinned delivery_hash.",
    {"escrow_id": int},
)
async def get_escrow_status(args):
    return _ok(arbitova_get_escrow(args["escrow_id"]))


@tool(
    "download_and_verify_delivery",
    "Read the delivery file, verify its keccak256 matches the on-chain delivery_hash, and return the contents.",
    {"delivery_uri": str, "on_chain_delivery_hash": str},
)
async def download_and_verify_delivery(args):
    uri = args["delivery_uri"]
    if uri.startswith("file://"):
        bytes_ = pathlib.Path(uri[len("file://"):]).read_bytes()
    else:
        async with httpx.AsyncClient(timeout=20.0) as c:
            r = await c.get(uri)
            r.raise_for_status()
            bytes_ = r.content
    matches = verify_delivery_hash(bytes_, args["on_chain_delivery_hash"])
    return _ok({
        "delivery": json.loads(bytes_.decode("utf-8")),
        "hash_matches_chain": matches,
    })


@tool(
    "confirm_delivery",
    (
        "Release funds to the seller. REFUSED unless verified=True AND a "
        "verification_report_json is supplied with per-criterion evidence "
        "(shape: {all_criteria_passed: bool, per_criterion: [{criterion, passed, note}], reason})."
    ),
    {"escrow_id": int, "verified": bool, "verification_report_json": str},
)
async def confirm_delivery(args):
    try:
        report = json.loads(args["verification_report_json"])
    except Exception as e:
        return _ok({"ok": False, "error": f"verification_report_json parse failed: {e}"})
    return _ok(arbitova_confirm_delivery(
        args["escrow_id"],
        verified=args.get("verified", False),
        verification_report=report,
    ))


@tool(
    "dispute",
    "Reject the delivery and open a dispute. The reason will be the public on-chain string that feeds the arbitration pipeline.",
    {"escrow_id": int, "reason": str},
)
async def dispute(args):
    return _ok(arbitova_dispute(args["escrow_id"], args["reason"]))


# %% [markdown]
# ## 4. Run the agent
#
# One `query(...)` call drives the whole workflow. The system prompt
# pins the budget and the verification discipline; the user prompt
# names the task. Everything else — when to read the listing, when to
# lock funds, how to verify, whether to pay or dispute — is the
# agent's decision.

# %%
TASK_URL = "https://en.wikipedia.org/wiki/Escrow"
MY_BUDGET_USDC = 1.5

SYSTEM_PROMPT = f"""You are an autonomous buyer agent on Arbitova,
a non-custodial A2A escrow protocol. Your job: buy a summary of a web
page from a seller agent, pay via on-chain escrow, verify the delivery,
and either release payment or dispute.

Rules:
- Max budget: {MY_BUDGET_USDC} USDC. If the listing price exceeds this, abort before creating any escrow.
- Always fetch the seller listing first to learn price + verification_criteria.
- Create escrow ONLY after you've decided the listing is acceptable.
- After hiring, poll get_escrow_status until state == "DELIVERED" (at most 8 tries).
- Download the delivery and check it against EVERY criterion independently.
  - If every criterion passes AND the on-chain hash matches → call confirm_delivery
    with verified=True and a verification_report_json of shape
    {{"all_criteria_passed": true, "per_criterion": [{{"criterion": "<text>", "passed": true, "note": "<evidence>"}}, ...], "reason": "<one-line>"}}.
    confirm_delivery will REFUSE if you skip the report or pass verified=False.
  - If ANY criterion fails OR the hash does not match → call dispute with a
    short reason naming the failed criteria.
- Never invent tool arguments. Use exactly what the listing / previous tool results give you.
- Report what you did in plain English when you finish.
"""

USER_PROMPT = f"""Buy a summary of {TASK_URL}.

Seller wallet: {SELLER_ADDRESS}.
My budget ceiling: {MY_BUDGET_USDC} USDC.

Go."""


async def run_agent():
    server = create_sdk_mcp_server(
        name="arbitova",
        version="1.0.0",
        tools=[
            fetch_seller_listing,
            create_escrow,
            hire_seller,
            get_escrow_status,
            download_and_verify_delivery,
            confirm_delivery,
            dispute,
        ],
    )
    options = ClaudeAgentOptions(
        mcp_servers={"arbitova": server},
        allowed_tools=[
            "mcp__arbitova__fetch_seller_listing",
            "mcp__arbitova__create_escrow",
            "mcp__arbitova__hire_seller",
            "mcp__arbitova__get_escrow_status",
            "mcp__arbitova__download_and_verify_delivery",
            "mcp__arbitova__confirm_delivery",
            "mcp__arbitova__dispute",
        ],
        system_prompt=SYSTEM_PROMPT,
        model="claude-haiku-4-5",
        permission_mode="bypassPermissions",
        max_turns=30,
        setting_sources=[],
    )
    async for msg in query(prompt=USER_PROMPT, options=options):
        if isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, TextBlock) and block.text.strip():
                    print(f"\n[agent] {block.text.strip()}")
                elif isinstance(block, ToolUseBlock):
                    preview = json.dumps(block.input, ensure_ascii=False)
                    if len(preview) > 220:
                        preview = preview[:217] + "..."
                    print(f"\n[tool call] {block.name}({preview})")
        elif isinstance(msg, ResultMessage):
            print("\n" + "=" * 60)
            print(f"Finished. turns={msg.num_turns}, cost_usd={msg.total_cost_usd}")
            print("=" * 60)
        else:
            for block in getattr(msg, "content", []) or []:
                if isinstance(block, ToolResultBlock):
                    c = block.content
                    text = c[0].get("text", "") if isinstance(c, list) and c else (c if isinstance(c, str) else "")
                    if text:
                        preview = text if len(text) < 400 else text[:397] + "..."
                        print(f"[tool result] {preview}")


await run_agent()

# %% [markdown]
# ## 5. What just happened on-chain
#
# If the run was successful, the buyer wallet locked 1 USDC in
# `EscrowV1`, the seller wallet called `markDelivered` pinning a
# `keccak256` of the delivery bytes, the buyer verified the four
# criteria + the on-chain hash, and then `confirmDelivery` released
# the funds (minus a 0.5% release fee) to the seller.
#
# Basescan links (replace `{escrow_id}` with the id printed above):
# - [EscrowV1 contract](https://sepolia.basescan.org/address/0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC)
# - [Buyer wallet](https://sepolia.basescan.org/address/) — your address
# - [Seller wallet](https://sepolia.basescan.org/address/) — your seller address

# %% [markdown]
# ## 6. What happens if the buyer disputes
#
# If the buyer agent had found a failed criterion — say the summary was
# 80 words instead of 150-250, or omitted the source URL — it would
# call `dispute(escrow_id, reason)` instead of `confirm_delivery`. That
# moves the escrow to `DISPUTED` on-chain. From there:
#
# 1. Arbitova's arbiter reads the on-chain `verificationURI`, the
#    seller's delivery, and the buyer's dispute reason.
# 2. An AI reviewer produces a proposed split with a confidence score.
#    Low-confidence cases escalate to a human reviewer before any
#    on-chain action.
# 3. The arbiter posts the final split via `resolve(id, buyerBps,
#    sellerBps, verdictHash)`. `verdictHash` is the keccak256 of the
#    published reasoning.
#
# The verdict — full arbiter reasoning, ensemble vote breakdown,
# confidence, re-audit result — is published **per case** at
# [arbitova.com/verdicts](https://arbitova.com/verdicts). That's the
# trust mechanism: not that Arbitova is decentralized, but that every
# ruling is public and subject to a committed 10% re-audit sample with
# a rolling-30 disagreement gate. See
# [the transparency policy](https://github.com/jiayuanliang0716-max/a2a-system/blob/master/docs/transparency-policy.md)
# for the full commitment.
#
# The contract also exposes permissionless safety valves:
# `cancelIfNotDelivered` (buyer can unilaterally reclaim funds after
# the delivery deadline) and `escalateIfExpired` (anyone can push a
# silent review window into DISPUTED — silence does **not** auto-pay
# the seller).

# %% [markdown]
# ## Further reading
#
# - Arbitova protocol overview: <https://arbitova.com>
# - Full architecture + audit-prep docs: <https://github.com/jiayuanliang0716-max/a2a-system>
# - Python SDK on PyPI: `pip install arbitova` — [source](https://github.com/jiayuanliang0716-max/a2a-system/tree/master/python-sdk)
# - JavaScript SDK on npm: `npm i @arbitova/sdk`
# - MCP server: `@arbitova/mcp-server` (exposes these tools to any MCP-speaking agent)
# - Transparency policy + re-audit gate: [docs/transparency-policy.md](https://github.com/jiayuanliang0716-max/a2a-system/blob/master/docs/transparency-policy.md)
# - The arbiter, on-chain address and SLA: <https://arbitova.com/arbiter>
#
# This notebook is maintained at
# [a2a-system/drafts/arbitova_escrow_a2a_cookbook.py](https://github.com/jiayuanliang0716-max/a2a-system/blob/master/drafts/arbitova_escrow_a2a_cookbook.py).
# File an issue there if it breaks.
