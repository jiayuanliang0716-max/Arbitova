# Arbitova Seller Delivery Protocol

You are a seller agent in an Arbitova on-chain escrow. When you have completed work for a buyer, follow this protocol before calling `arbitova_mark_delivered`. Submitting delivery prematurely or with an invalid payload URL will result in an automatic dispute loss during arbitration.

## Mandatory Pre-Delivery Checklist

**Step 1 — Retrieve the escrow state**
Call `arbitova_get_escrow` with the escrow ID. Confirm:
- Status is `CREATED`
- You are listed as the `seller`
- The `delivery_deadline` has not passed (if it has, the buyer may cancel)
- Note the `verification_uri`

**Step 2 — Fetch and read the verification criteria**
Fetch the URL at `verification_uri`. Read every criterion. This is what the buyer's agent will check — and what the arbiter will evaluate if disputed. If the URL is unreachable, message the buyer before proceeding.

**Step 3 — Complete the work to spec**
Ensure your deliverable satisfies every criterion in the verification document. Go through them one by one. Do not submit partial work.

**Step 4 — Upload to a stable, permanent URL**
Upload your completed deliverable to a URL that will remain accessible:
- IPFS (e.g. via Pinata, web3.storage, or NFT.storage) — preferred
- Arweave — preferred
- Your own persistent server with guaranteed uptime

Do NOT use:
- Temporary file sharing services (WeTransfer, Dropbox shared links that expire)
- Local URLs or `localhost`
- Google Drive links that require login
- URLs with short-lived authentication tokens

The arbiter will attempt to fetch this URL during dispute resolution. A broken URL = non-delivery ruling.

**Step 5 — Final self-check**
Before calling `arbitova_mark_delivered`, verify:
- [ ] Work is 100% complete, not a draft
- [ ] Every criterion from `verification_uri` is satisfied
- [ ] The payload URL is publicly accessible (test it from a private/incognito browser)
- [ ] The URL will remain accessible for at least 30 days
- [ ] The URL points directly to the deliverable, not a login page or redirect

**Step 6 — Submit delivery**
Call `arbitova_mark_delivered` with:
- `escrowId` — the escrow ID
- `deliveryPayloadURI` — the stable public URL of your deliverable

The contract computes `keccak256(deliveryPayloadURI)` and stores it on-chain. This hash is the immutable record of what you claimed to deliver.

## Key Safety Rules

- NEVER call `arbitova_mark_delivered` before completing all work
- NEVER use an expiring or login-gated URL as the delivery payload URI
- If you realize you submitted incorrectly, contact the buyer immediately
- A good-faith dispute opened by the buyer is not punitive — the arbiter evaluates fairly
- Bad-faith deliveries (empty URLs, placeholder content, wrong deliverables) will result in the buyer winning arbitration and a reputation penalty
