# Arbitova User Accumulation System (Design v0.1)

Status: **DRAFT 2026-04-24** — awaiting founder review, nothing implemented yet
Decision context: conversation 2026-04-24 following demand-reconnaissance report (zero external wallets in 7 days)
Related: `transparency-policy.md` (opt-in attribution builds on the public /verdicts commitment)

---

## The problem in one sentence

**Arbitova has anonymous touchpoints but no way to see which anonymous
visitor turned into a real user, which means the 30-day validation
sprint is running blind.**

Today the system has seven places where a user can interact with
Arbitova (site visit, API call, on-chain tx, npm install, GitHub star,
MCP session, blog read). Each records different evidence. None of
them talk to each other. A developer who reads two blog posts,
downloads the SDK, and eventually creates a Sepolia escrow appears as
four unrelated signals — so we cannot tell whether any campaign works,
who to follow up with, or whether the same dev is returning.

This document specifies the minimal system that fixes that, in a way
compatible with Arbitova's Type-C (infrastructure) positioning and
the privacy expectations of crypto-native developers.

---

## Design principles

1. **Capture anonymously, resolve opportunistically.** Never require
   signup to use the product. Instead, record what we see and
   correlate later when identifiers surface.
2. **Hash at the edge.** Raw IPs never enter the database. We store
   only `sha256(ip || daily_salt)` so daily sessions are aggregatable
   but long-term tracking is impossible by design.
3. **Opt-in attribution is the identity lever, not tracking.** The
   system that turns anonymous wallets into named customers is the
   attribution flow (§6), not a fingerprinting pipeline.
4. **No auto-outreach.** The system surfaces candidates. Humans write
   messages.
5. **Minimum viable before fancy.** Everything in §5 before anything
   in §6 or §7.

---

## Non-goals

- Not a marketing automation platform. No email sequences, no drip
  campaigns, no retargeting pixels.
- Not a CRM. A flat HTML table of the top 50 entities by heat is the
  whole UI — no pipelines, no stages, no Salesforce-shaped data.
- Not a fraud-detection system. Spam and sybil handling is out of
  scope for v0.1 (relevant later if volume ever forces it).
- Not cross-device tracking. We don't fingerprint. A developer on
  laptop and phone will look like two entities until one of them
  touches an on-chain tx or uses an attribution key.

---

## Architecture (one picture in text)

```
                  ┌───────────────────────────────────────────┐
                  │  Arbitova entry points (anonymous signal) │
                  ├───────────────────────────────────────────┤
   site visit ────┤ Express middleware (every /api/* route)   │
   /arbitrate ────┤                                           │
   on-chain  ────►│ events_sse.js indexer (EscrowV1 events)   │
   GitHub    ────►│ daily cron (REST pull: stars/forks/issues)│
   npm/PyPI  ────►│ daily cron (registry stats with bot mask) │
   attrib-key ───►│ /partners signup + key-gated API call     │
                  └────────────────────┬──────────────────────┘
                                       │
                                       ▼
                  ┌───────────────────────────────────────────┐
                  │  user_events (append-only event log)      │
                  └────────────────────┬──────────────────────┘
                                       │ every 6h
                                       ▼
                  ┌───────────────────────────────────────────┐
                  │  resolve.js (identity merge + heat calc)  │
                  └────────────────────┬──────────────────────┘
                                       │
                                       ▼
                  ┌───────────────────────────────────────────┐
                  │  user_entities (one row per merged person)│
                  └────────────────────┬──────────────────────┘
                                       │
                                       ▼
                  ┌───────────────────────────────────────────┐
                  │  /admin/users — HTML table sorted by heat │
                  └───────────────────────────────────────────┘
```

---

## 1. Data model

Two tables, both PostgreSQL (already in use), both idempotent
migrations.

### `user_events` — append-only event log

```sql
CREATE TABLE IF NOT EXISTS user_events (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type     TEXT NOT NULL,
  -- identity hints (all nullable; resolve.js uses whatever is present)
  ip_hash        TEXT,
  wallet         TEXT,
  github         TEXT,
  email          TEXT,
  api_key_id     TEXT,
  -- context
  path           TEXT,
  referrer       TEXT,
  ua_family      TEXT,      -- parsed user-agent family only, not raw
  -- payload
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  heat_points    INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_user_events_ts           ON user_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_user_events_wallet       ON user_events (wallet)     WHERE wallet IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_events_ip_hash      ON user_events (ip_hash)    WHERE ip_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_events_github       ON user_events (github)     WHERE github IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_events_api_key      ON user_events (api_key_id) WHERE api_key_id IS NOT NULL;
```

### `user_entities` — one row per resolved person

```sql
CREATE TABLE IF NOT EXISTS user_entities (
  id             TEXT PRIMARY KEY,    -- canonical id (wallet > github > api_key > ip_hash)
  first_seen     TIMESTAMPTZ NOT NULL,
  last_seen      TIMESTAMPTZ NOT NULL,
  total_heat     INT NOT NULL DEFAULT 0,
  state          TEXT NOT NULL DEFAULT 'cold'
                   CHECK (state IN ('cold','warm','hot','customer','reference','ignored')),
  -- identity unions (any/all may be populated as evidence accumulates)
  wallets        TEXT[] NOT NULL DEFAULT '{}',
  githubs        TEXT[] NOT NULL DEFAULT '{}',
  emails         TEXT[] NOT NULL DEFAULT '{}',
  api_key_ids    TEXT[] NOT NULL DEFAULT '{}',
  ip_hashes      TEXT[] NOT NULL DEFAULT '{}',
  -- attribution (populated when they opt in via /partners)
  project_name   TEXT,
  project_url    TEXT,
  project_logo   TEXT,
  -- human notes (manual; appended when we DM them)
  notes          TEXT NOT NULL DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_entities_heat  ON user_entities (total_heat DESC);
CREATE INDEX IF NOT EXISTS idx_user_entities_state ON user_entities (state);
```

Canonical-id rule: when resolving, pick the strongest identifier
present, in this order: `wallet > github > api_key_id > ip_hash`.
If a later event surfaces a stronger identifier for an entity, merge:
keep both rows' arrays unioned, delete the weaker id.

---

## 2. Event capture: middleware & handlers

### 2.1 HTTP middleware (all Express routes)

File: `src/middleware/userEvents.js`

```js
// Fires on every /api/* request. Writes a minimal event row.
// IP is hashed with a daily-rotating salt — long-term tracking
// across days requires correlation through a stronger identifier.
module.exports = function userEventsMiddleware(pool, daySalt) {
  return (req, res, next) => {
    const ipHash = hashIp(req.ip, daySalt.current());
    const event = {
      event_type:  classifyPath(req.path),   // 'site_visit' | 'api_call' | 'arbitrate_external' | ...
      ip_hash:     ipHash,
      path:        req.path,
      referrer:    req.get('referer') || null,
      ua_family:   parseUaFamily(req.get('user-agent')),
      api_key_id:  hashedApiKey(req.get('x-api-key')),
      metadata:    { method: req.method, query: safeQuery(req.query) },
      heat_points: heatFor(req.path),
    };
    // Fire and forget — must not block request path.
    pool.query(INSERT_EVENT_SQL, toRow(event)).catch(err => {
      log.warn('user_events insert failed', err.message);
    });
    next();
  };
};
```

Notes:

- Daily salt rotates at 00:00 UTC; last 2 days' salts kept in memory
  so the resolve job can still correlate "yesterday's" events.
- `heat_points` computed from path (see §4).
- `api_key_id` is a hash, never the raw key.

### 2.2 On-chain events

Extend `src/events_sse.js` (already indexing EscrowV1). Every time a
parsed event fires, also insert into `user_events`:

```js
// Inside dispatchEvent() after fanOut():
await pool.query(INSERT_EVENT_SQL, {
  event_type:  `onchain_${name.toLowerCase()}`,  // onchain_escrowcreated, etc.
  wallet:      ev.buyer || ev.seller,
  metadata:    { escrow_id: ev.id, tx: log.transactionHash },
  heat_points: heatForOnchain(name, isMainnet),
});
```

### 2.3 GitHub pull (daily cron)

File: `scripts/track_github.js`, run 04:00 UTC.

Pulls `/repos/jiayuanliang0716-max/Arbitova/stargazers` and compares
against last snapshot. New stars → one `github_star` event per new
handle. Same for forks and new issues.

### 2.4 Package registries (daily cron)

File: `scripts/track_registries.js`. Pulls npmjs download-range API
and pypistats daily endpoint. Masks the bot-like pattern (publish-day
spike + 2-35/day baseline) and records only anomaly-flagged days as
an `npm_download_anomaly` event. This is a weak signal but better
than nothing.

### 2.5 Attribution-key usage (§6)

Every call to `/arbitrate/external` with a valid `attribution_key`
header writes an `arbitrate_attributed` event with `api_key_id`,
`wallet` (if tx-linked), and `email` (from the signup row).

---

## 3. Identity resolution (`resolve.js`)

Run every 6 hours via existing Render cron mechanism.

### Algorithm

```
for each event in user_events WHERE processed_at IS NULL (last 48h):
  candidates = find_existing_entities(event.wallet, event.github,
                                      event.api_key_id, event.ip_hash)
  if candidates is empty:
      create new entity with canonical id from strongest field
  elif candidates is one entity:
      merge event's identifiers into entity.arrays
      entity.total_heat += event.heat_points
      entity.last_seen = event.ts
  elif candidates is multiple entities:
      # Two previously-separate entities just got linked — merge them.
      survivor = entity with strongest canonical id
      for e in other entities: merge e into survivor, delete e
      survivor.total_heat += event.heat_points

update entity.state based on heat thresholds (see §4)
mark event.processed_at = NOW()
```

### Merge conflict handling

- Canonical-id collision (two wallets for what we think is same entity):
  do **not** merge — wallets are strong enough to be distinct by
  default. Require an explicit `resolve_hint` event (which attribution
  signup creates) before bridging two wallets.
- ip_hash-only matches never trigger cross-entity merges. They're too
  weak. Used only to group within-session activity.

---

## 4. Heat scoring

Event → point table. Tuned for Arbitova's funnel where real
on-chain use is the goal:

| Event | Points | Why |
|-------|-------:|-----|
| site_visit (home/blog/docs) | 1 | cheap, mostly bots |
| site_visit (/verdicts, dwell > 60s) | 3 | engaged with core differentiator |
| blog_read (dwell > 120s) | 5 | serious reader |
| api_call (/arbitrate/external, public) | 15 | tried the API |
| api_call (/arbitrate/external, attribution) | 25 | identified dev |
| onchain_escrowcreated (Sepolia, external wallet) | 30 | real testnet use |
| onchain_escrowcreated (Sepolia, same wallet again, 24h+ later) | 50 | retention |
| onchain_escrowcreated (Mainnet) | 100 | real money |
| github_star | 10 | handle surfaced |
| github_fork | 20 | intent to use |
| github_issue_opened | 40 | deep engagement |
| github_pr_opened | 80 | contributor |
| npm_download_anomaly | 5 | possible real dev |
| cold_email_reply | 20 | conversation started |
| attribution_key_requested | 40 | opted in to identify |

### State transitions

- `cold`: 0–20
- `warm`: 21–60
- `hot`: 61–150 — surface on /admin/users with red highlight
- `customer`: 151+ — manual promotion by founder
- `reference`: manual set — entities who agreed to be named case studies
- `ignored`: manual set — spam, bots that slipped through

State is derived, not stored as truth. The cron writes derived state
after each heat update. Founder can manually override to `customer`,
`reference`, or `ignored`.

---

## 5. MVP scope (the minimum that produces signal)

Everything §5.x ships **before** §6 and §7.

| Task | Est | What it does |
|------|-----|--------------|
| 5.1 Migration: `user_events` + `user_entities` | 30m | Two tables, two indices |
| 5.2 `src/middleware/userEvents.js` + wire into `server.js` | 60m | Capture HTTP |
| 5.3 Extend `events_sse.js` dispatch to insert events | 30m | Capture on-chain |
| 5.4 `scripts/track_github.js` + Render cron entry | 60m | Daily GH pull |
| 5.5 `scripts/resolve.js` identity resolution job | 90m | 6-hourly merge |
| 5.6 `/api/v1/admin/users` endpoint (JSON, X-Admin-Key gated) | 30m | Founder API |
| 5.7 `public/admin-users.html` simple table | 45m | Sortable list |
| 5.8 README docs/analytics-transparency.md | 30m | What we log, what we don't |

**Total: ~6 hours.**

Acceptance test: after 48h in production, `/admin/users` shows a
non-empty list where at least one entity has `total_heat > 10` and
at least one event fires per hour of traffic.

---

## 6. The attribution opt-in flow (Arbitova's Type-C growth engine)

This is the piece that makes the system more than analytics. §5 gives
us measurement; §6 gives us a reason for developers to identify
themselves voluntarily.

### 6.1 The deal

When a developer integrates Arbitova into their agent product, they
can opt in to public attribution. Opted-in cases display:

> Arbitrated for [AgentCo] — built by [Dev handle]

…on the `/verdicts` page, with the project's logo. This trades:

- **Arbitova gets:** a named case, identity (email + wallet + project),
  a reason to talk to a real customer.
- **The dev gets:** free exposure on a page that Coinbase/Anthropic/
  Merit engineers check for ecosystem signal. Their agent project's
  name appears next to a real dispute resolution, which signals
  "this is a real product with real users."

Both sides want the other's audience. Attribution is the visible
artifact of that swap.

### 6.2 Flow

```
1. Dev visits /partners
2. Fills form: project name, URL, logo, email, wallet (optional)
3. System issues attribution_key (opaque 32-byte token)
4. Dev passes key as X-Attribution-Key header on /arbitrate/external
5. System records case with attribution metadata
6. /verdicts/<case_id> page shows attribution block
7. Dev can opt out at any time via /partners/revoke — past cases
   become anonymous again (subject to §6.5 permanence rules)
```

### 6.3 Schema additions (in v0.2 after MVP)

```sql
CREATE TABLE IF NOT EXISTS attribution_keys (
  id              TEXT PRIMARY KEY,
  key_hash        TEXT UNIQUE NOT NULL,     -- sha256(raw_key)
  project_name    TEXT NOT NULL,
  project_url     TEXT NOT NULL,
  project_logo    TEXT,                     -- url to logo (we don't host images in v1)
  contact_email   TEXT NOT NULL,
  contact_wallet  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  verified_at     TIMESTAMPTZ               -- manual verification by founder (avoid spam)
);

-- /verdicts verdict record gets two new fields:
ALTER TABLE verdicts
  ADD COLUMN attribution_key_id TEXT REFERENCES attribution_keys(id),
  ADD COLUMN attribution_verified BOOLEAN NOT NULL DEFAULT FALSE;
```

### 6.4 Anti-gaming

- Manual verification required before the attribution badge appears
  publicly. `verified_at IS NULL` → case shows up as anonymous even
  if key was used.
- Rate-limit: one key can attribute max 100 cases per 30 days in v1.
- Keys are not transferrable. Terms of use at `/partners/terms`
  say so explicitly.
- If a single key's cases are manifestly synthetic (identical
  payloads), founder manually flags the entity `ignored` and the
  badge is removed.

### 6.5 Permanence rules

Once published, an attribution badge can be removed by the dev at any
time, but the case itself stays public (per the transparency policy).
We never retroactively rewrite history — we only remove the badge.

---

## 7. Dashboard (`/admin/users`)

Not a BI tool. A single sortable HTML table:

| ID | State | Heat | First seen | Last seen | Wallets | GitHub | Project | Notes |

Buttons per row:
- "Set state" dropdown
- "Add note" textarea
- "Export" → dump entity + all its events as JSON

That's it. No charts in v1. If the founder wants graphs later,
export to CSV and use whatever tool.

---

## 8. Privacy & security

### What we log (published at `/docs/analytics`)

- IP address, hashed with a daily-rotating salt, kept 30 days
- Path visited, referrer, user-agent family (e.g., "Chrome on macOS")
- On-chain events (already public)
- Wallet addresses used against Arbitova (already public)
- GitHub handles of stargazers (already public on GitHub)
- Package download counts (already public on npm/PyPI)
- For attribution keys: project name, URL, logo, contact email, wallet

### What we don't log

- Raw IPs (only hashed)
- Request bodies of `/arbitrate/external` (cases themselves go to
  /verdicts per transparency policy; metadata for tracking does not)
- Cookies beyond a session cookie for the admin UI
- Anything from visitors who set `DNT: 1` beyond the daily hash
  (we honor DNT: only the `event_type` and day-bucket are stored,
  no ip_hash)

### Security

- `user_events` and `user_entities` are admin-only tables. No public
  API exposes them.
- Attribution keys are stored hashed. Raw keys shown once at creation.
- `/admin/users` behind `X-Admin-Key` header (same as existing
  `/api/v1/admin/*` routes).
- Founder cannot SELECT raw event rows by default — only aggregated
  entity view. This is a soft guard; founder can bypass via direct DB
  access. The goal is behavioral, not technical.

---

## 9. What this system does NOT do

- Does not identify "real users" with certainty. A dev behind a VPN
  who never stars the repo and never uses an attribution key is
  invisible. That's a feature, not a bug — it keeps the system
  compatible with crypto-dev privacy norms.
- Does not replace judgement. Heat scores prioritize, they don't
  decide. Founder reads notes, writes DMs, makes calls.
- Does not prove causality. We can see the AgentKit PR correlates
  with a spike in entities, but we cannot prove A caused B.
  Fine for our scale.

---

## 10. Rollout plan

### Phase 0 — design review (now)
- Founder reads this document, comments, signs off.

### Phase 1 — MVP (week 1 of 30-day sprint)
- Implement §5. Ship behind feature flag `USER_TRACKING_ENABLED=1`.
- Let it run 48h, verify events flow, check no perf regression.
- Announce in next Dev Log with the `/docs/analytics` disclosure.

### Phase 2 — Attribution flow (week 2)
- Implement §6 schema + `/partners` signup page.
- Add `attribution_key` parsing to `/arbitrate/external`.
- Modify `/verdicts/:id` page renderer to show attribution block when
  present and verified.

### Phase 3 — Iterate based on data (week 3+)
- If §5 shows 0 entities after 2 weeks: the sprint is failing at
  discovery, not conversion. Refocus on SPRINT-A/B (RFC issue + cold
  DM). Don't touch §6.
- If §5 shows entities but 0 attribution keys requested: §6 flow has
  friction. Simplify signup, reduce fields.
- If attribution keys requested but cases not running through:
  integration documentation gap. Write a walk-through.

---

## 11. Open questions for founder review

Each question has a **default** (what v1 will do unless founder says otherwise)
and an **alternative**. Decisions are checked off in `project_arbitova_30day_sprint.md`
when answered; v1 implements defaults today and migrates on the later answer.

### Q1. Daily salt storage

- **Default (v1 shipped 2026-04-24):** derived per-process at UTC midnight via
  `sha256(ATTRIBUTION_SALT_SEED || UTC_DATE)`. `ATTRIBUTION_SALT_SEED` is a
  Render env var; if unset, a per-process random salt is used. Works for
  single-instance Render; breaks if we ever scale to multiple workers.
- **Alternative:** Postgres table `daily_salts(date PRIMARY KEY, salt TEXT)` with a
  cron that rotates it. Works with multiple workers; needs a rotation job.
- **Pick one:** `[ ] default  [ ] alternative`

### Q2. IP geo-lookup

- **Default (v1):** off. We hash IPs and never resolve them to country/region.
- **Alternative:** use free MaxMind GeoLite2; store country-only (not city) next to
  `ip_hash`. Lets us say "HN drove 40 US visitors" in Dev Logs. More retention.
- **Pick one:** `[ ] default  [ ] alternative`

### Q3. Attribution logo hosting

- **Default (v1 shipped):** URL-only. Dev provides a logo URL; `/verdicts` renders
  `<img src="...">` with `onerror` fallback. Zero storage on our side.
- **Alternative:** require upload to our S3 / R2 bucket; we resize and serve. Nicer
  consistency. Non-trivial to build; also more cost.
- **Pick one:** `[ ] default  [ ] alternative`

### Q4. Manual verification SLA

- **Default proposed:** 24 hours. On signup we send ourselves an email; we verify
  and flip `verified_at` within 24h or the signup stays visible in `/admin/users`
  but not on the public strip.
- **Alternative:** 48h (easier on founder, weaker promise).
- **Pick one:** `[ ] 24h (proposed)  [ ] 48h`

### Q5. Cold DM tracking

- **Default (v1 shipped):** yes — `POST /admin/users/log_outreach` records channel,
  target, target_kind, subject, body_excerpt, and optional entity_id. Viewable at
  `GET /admin/users/outreach`. The workflow doc `drafts/sprint-2026-04-24/06-cold-dm-drafts.md`
  has the curl example.
- **Alternative:** don't log; keep it in my head. Doesn't scale past 5 DMs.
- **Pick one:** `[ ] default  [ ] alternative`

---

## 12. Stage 2 — Wallet-connect API keys (prototyped, not shipped)

### 12.1 When Stage 2 activates

The sprint plan keeps Stage 1 (optional `X-Attribution-Key`) as the only auth
surface through the 30-day window. Stage 2 activates when:

- `/admin/users` shows **10+ non-founder entities** (strip `ip:*` entries
  from the same /24 as the founder's home IP), AND
- at least one external wallet has transacted on EscrowV1 (any net), AND
- founder has answered Q4 + Q5 above.

### 12.2 Surface

- `GET /api/wallet/nonce` → returns a 10-minute SIWE nonce.
- `POST /api/wallet/verify` with `{ message, signature }` → mints an API key
  scoped to the signing address. `ark_*` plaintext, sha256 hash stored.
- `POST /api/wallet/revoke` → revoke (auth by presenting a still-valid key
  from the same address).
- No email. No password. No "account". The wallet address **is** the account.

### 12.3 Key design choices (locked-in, not open)

- SIWE / EIP-4361 only. No OAuth, no Supabase, no Clerk.
- Keys are free; rate limiting by address (default 100 read/hr, 20 write/hr).
- Keys are never auto-rotated. Leaked key → user revokes and re-mints.
- Keys do NOT create an `agents` row. Stage 2 is wallet-only; `agents` is legacy.

### 12.4 Prototype status

Full prototype (schema + SIWE verification + routes) lives in
`drafts/sprint-2026-04-24/07-stage2-api-keys-prototype.md`. Not committed
to `src/` yet — promotion checklist is in that doc.

### 12.5 What Stage 2 explicitly is NOT

- Not a "profile" or "dashboard" for end users. It's an API key issuer.
- Not a sign-up funnel. It's a friction-reduction for repeat callers.
- Not gated by plan/tier. Still free — the `feedback_arbitova_no_tier` memory
  still applies and always will.

---

## Appendix A — What this unlocks that we don't have today

1. **The 30-day sprint has a verdict.** Today, "did AgentKit PR
   work?" requires reading GitHub manually and correlating with
   blog traffic we don't measure. After this, the founder opens
   `/admin/users`, sorts by `first_seen > 2026-04-29`, and sees
   exactly who showed up.

2. **Cold DMs become follow-ups.** Today, "did the dev I emailed
   last week actually come look?" is unanswerable. After this, the
   entity row shows their heat trajectory since the DM was sent.

3. **Attribution flywheel.** The transparency policy becomes a
   distribution channel. Previously, `/verdicts` was a commitment;
   now it's also a marketing surface — for users, not for us.

4. **Acquisition data story.** When Merit or Nevermined BD looks at
   Arbitova in month 6+, the founder can say "here are the 12 dev
   orgs that have run attributed disputes through us" — and produce
   the list on demand. This is the kind of artifact that shifts
   acqui-hire conversations into product-acquisition conversations.

---

*Document status: **v1 MVP implemented 2026-04-24**. §5 is live:
migrations applied via `user_accumulation/db.js#ensureSchema`,
middleware mounted in `server.js`, admin surface at `/admin/users`,
public `/partners` signup, `/api/partners/verified` feeds the logo
strip on `/verdicts`. §11 defaults are shipped; founder answers
migrate specific behaviors as needed. §12 Stage 2 prototype only.
Next action: 30-day sprint execution per `project_arbitova_30day_sprint.md`.*
