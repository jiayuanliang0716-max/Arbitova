# Arbitova × LangGraph — reference integration

This folder holds the files that get contributed to the LangChain
community repo when the user opens the PR described in
`.arbitova-gm/drafts/langgraph-pr.md`.

## Files

- `escrow_node.py` — `EscrowNode` + `BuyerState` TypedDict. Three
  step methods (`create_step`, `wait_delivered_step`, `confirm_step`)
  plus `dispute_step` for the unhappy path. Every step is a pure
  `(state) -> state` function compatible with `langgraph.graph.StateGraph`.
- `test_escrow_node.py` — `unittest` suite that stubs
  `arbitova.path_b` so the tests run without network access.
- (This README) — where the integration is documented.

## Running tests

```bash
cd examples/langgraph
python -m unittest test_escrow_node.py -v
```

Stubs are installed by `_install_fake_path_b()` before the node is
imported — no real `arbitova` install is required for the tests.

## Running against live Sepolia

1. `pip install arbitova langgraph eth-account`
2. Fund your wallet with Sepolia ETH (for gas) + Circle test USDC.
3. Set `ARBITOVA_AGENT_PRIVATE_KEY` and a seller address.
4. Run a minimal graph:

```python
from langgraph.graph import StateGraph, END
from escrow_node import EscrowNode, BuyerState

node = EscrowNode(
    signer=os.environ["ARBITOVA_AGENT_PRIVATE_KEY"],
    rpc_url="https://sepolia.base.org",
    escrow_address="0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC",
    usdc_address="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
)

graph = StateGraph(BuyerState)
graph.add_node("create", node.create_step)
graph.add_node("wait", node.wait_delivered_step)
graph.add_node("confirm", node.confirm_step)
graph.set_entry_point("create")
graph.add_edge("create", "wait")
graph.add_edge("wait", "confirm")
graph.add_edge("confirm", END)

app = graph.compile()
final = app.invoke({
    "seller": "0xSELLER...",
    "amount_usdc": 0.10,
    "verification_uri": "ipfs://demo-spec.json",
})
print(final)
```

## Non-goals

- **Seller-side node.** The current integration is buyer-only.
  Seller would just call `arbitova.path_b.arbitova_mark_delivered`
  from a tool; LangGraph wrapping is unnecessary.
- **CDP-signed accounts via this node.** The node expects an
  `eth_account`-compatible signer. If you want CDP, import
  `arbitova.cdp_adapter.CdpEscrowClient` and drive it from whatever
  orchestration layer you prefer.
- **External appeal layer.** v1 EscrowV1 uses a single
  Arbitova-operated arbiter with a confidence gate and per-case
  public verdicts at arbitova.com/verdicts. External appeal (UMA
  Optimistic Oracle) is Phase 6 research targeting a possible V2
  contract, not on the v1 path.

## What the upstream PR claims

See `.arbitova-gm/drafts/langgraph-pr.md`. The PR body is deliberately
modest: Sepolia only, pre-audit contract, signer-delegated, no
custody. Do not remove any of those qualifiers when submitting.
