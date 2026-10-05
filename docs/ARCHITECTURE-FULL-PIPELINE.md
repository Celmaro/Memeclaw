# Memeclaw Full-Pipeline Architecture

**Discovery → Emission → Enrichment → Screening → Signal → Publication**

Design document. Inspiration audited from `C:\Users\1\Documents\ChatGPT\Memeland\memeland-repo`
(referenced below as `memeland/<path>`), applied **without breaking Memeclaw's original wiring**.
Chains in scope: `sol`, `eth`, `base`, `bsc`, `robinhood` (GoPlus ids `1 / 56 / 8453 / 4663`, solana native).

---

## 1. Original-wiring invariants (non-negotiable)

Every phase below is additive. These lines of behavior must remain byte-equivalent after each phase:

1. **AVE throttle floor**: `main.mjs:45` `sharedRequestIntervalMs = 5 * 60_000` stays the
   `minimumGapMs` of `AveClient` (`main.mjs:51`). Ingest/emitters NEVER share this bucket —
   they run on their own `SOURCE_BUDGETS` table (`src/ingest/budget.mjs:315`).
2. **Screening thresholds**: `discoveryScreen` + `src/scoring.mjs` gates (10k–150k mcap,
   liquidity, age, volume, buy/sell balance) are untouched. New sources feed rows **into**
   the screen; they do not fork it.
3. **Audit pipeline**: `selectAuditQueue` / `riskExclusions` / `reviewRevision` /
   `updateOutcomeTracking` semantics untouched (`src/scanner.mjs:219,290,310,106`).
4. **Read-only contract**: `policy.execution: "disabled"` forever — no signing, no wallets.
5. **Server API**: `src/server.mjs` routes are additive-only; existing response shapes stable.
6. **State**: `RadarState` sections are append-only additions, versioned; `candidates[]` /
   `outcomes[]` field names unchanged (public UI reads them).
7. **Secondary path**: `SecondaryValidator` + `DexBatchMarketOverlay` (`src/secondary.mjs:541,324`)
   remain the security/market validation authority; ingest data is evidence, not a replacement.
8. **Identity authority**: `src/address.mjs` (`addressKey`/`tokenKey`) is the one normalization
   function. EVM addresses lowercase; Solana base58 stays **case-preserved** (memeland
   lowercases base58 in `canonical-key.ts:13-15` while its own `price-feed-service.ts:30-32`
   says base58 is case-sensitive — we keep the contradiction resolved in favor of correctness).
9. **Deep audits stay opt-in**: defaults `maxDeepAuditsPerCycle: 0`, `enrichLimit: 0`,
   `maxTrendingPages: 1` (`config.mjs:48,58,59`) — widened only via env, per existing comment.

## 2. Role taxonomy (borrowed from memeland's docs, enforced by module boundaries)

| Role | Meaning | Memeclaw owner |
|---|---|---|
| **TRANSPORT** | HTTP/RPC client, budget, breaker, throttle detection | `src/ingest/{http,budget}.mjs` |
| **CANONICAL INTRODUCER** | on-chain fact that a pool/token *exists* (logs, RPC) | AVE `trending` + PublicNode logs (P4) |
| **CANDIDATE EMITTER** | a feed that surfaces addresses (may be paid/promotional) | `GeckoTerminalAdapter` (P1), DexScreener profiles, DexPaprika, GMGN (hints) |
| **ENRICHER** | fills fields on an *already-known* address | `secondary.mjs`, GT pool fields, RPC size fields, Helius (sol, optional) |
| **SIGNAL** | computes analysis on an enriched candidate | convergence / wallet / bot / KOL (P3) |

A source must occupy exactly one role per module. DexScreener `token-boosts` is an EMITTER with
a **paid-ad** marker (`paid: true`) that can never promote by itself — memeland documents this
in-code (`memeland/src/adapters/dexscreener-boosts.ts:9-13`: "a boost is a PROMOTION signal,
NOT evidence of quality") and our own GeckoTerminal probe measured `token-boosts.totalAmount`
as raw ad spend.

## 3. Pipeline

```
EMISSION (out-of-band timers, never in the cycle critical path)
  PublicNode eth_getLogs  PairCreated/Initialize (EVM)      [P4]
  pump.fun feed (sol) · DexScreener token-profiles (paid)    [P4]
        │  append → hint registry
        ▼
DISCOVERY (per cycle, budgeted, fail-open)
  AVE trending  ──(5-min floor, untouched)──┐
  GT new_pools  ──(geckoterminal budget)───┤  DiscoveryCoordinator
  hint drain → existence oracle ───────────┘  observations BEFORE merge
        │  rows mapped to AVE row contract
        ▼
SCREEN (original, untouched)
  discoveryScreen + scoring.mjs + riskExclusions
        │
        ▼
ENRICH (overlay on known addresses only)
  AVE info/candles · secondary (DexScreener+GoPlus, all 5 chains)
  GT pool fields · PublicNode reserves/totalSupply → FDV · Helius holders (sol)
  rpc-risk structural risk (EIP-1967, EIP-170, ownership)   [shipped]
        │
        ▼
SIGNAL (deep-audit inputs — weighted evidence, NOT gates)     [P3]
  flowConvergence (pool txs / Transfer logs)
  walletScore + WalletGraph cohorts → smart-money history
  botRisk (transparent bounded signals)
  KOL/social gate (agent-reach X backend, hint authority only)
        │
        ▼
AUDIT QUEUE → deep audit → candidates[] → server/UI   (original)
PUBLISH with per-token dedup cooldown + signal ledger  [P3]
```

## 4. Stage designs

### 4.1 Discovery — the yield lever

**Why**: measured full-gate hit rates — AVE trending **1.0%** (98→1), GT `new_pools`
**10.2%** (59→6). AVE is a popularity list dominated by tokenized equities (MSTRc at $3M)
that correctly fail a 10k–150k screen; a chronological new-pool feed is a different
population, not a duplicate one.

**Contract** (adapted from `memeland/src/discovery/candidate-emitter.ts:55-69`):

```js
// src/ingest/emitter.mjs  (P1)
// { id, enabled(), discover(chain, { signal }) -> Record[] }   // fail-open: throw/timeout → []
```

- **Coordinator** (`src/ingest/coordinator.mjs`, P1) runs emitters **sequentially in a fixed
  priority order** (keyless budgets first), per-emitter timeout (15s, `DISCOVERY_EMITTER_TIMEOUT_MS`),
  dedupes on `addressKey(chain, address)`, and — the single best memeland idea —
  **emits one `DiscoveryObservation` per (source × token) BEFORE merging**
  (`candidate-emitter.ts:195-217`), so coverage/first-seen/latency per source survive the
  dedupe and later feed measured-priority (`proposeIntroducers`, `discovery-registry.ts:314`).
- **Row contract**: emitter output is mapped to the **AVE row shape** (`address, symbol, name,
  price, market_cap, liquidity, volume_5m, buy/sell, creation_timestamp, sourceUpdatedAt,
  chain, marketProvider`) by a mapper in the emitter module. `discoveryScreen` then needs
  zero changes.
- **Seam**: `src/scanner.mjs:618` currently drops everything with
  `row?.marketProvider !== 'AVE'`. Phase 1 changes this ONE line to consult a registry
  (config-gated: `DISCOVERY_EMITTERS=geckoterminal,...`, default empty = today's behavior).
  Everything else in `cycle()` is untouched.
- **Freshness** (P-later, product decision): memeland treats freshness structurally — a
  `freshLane` pair born inside the measurement window passes a low volume floor (3 000 USD/h)
  instead of the mature floor, and `isFreshAtBirth` (zero vol AND zero liq AND zero mcap)
  bypasses vol/liq/mcap gates but **never the security gate** (`gmgn-meme-helpers.ts:143-178`).
  Our `minAgeSec: 5*60` floor already admits newborns; adopting freshLane's *asymmetric
  volume floor* would change product behavior, so it ships only with an explicit knob.

**Hints**: KOL/social/promotional mentions enter as `CandidateHint` — "recall without
authority" — and are promoted only by the existence oracle (EVM: `eth_getCode` ≠ `0x`;
solana: mint account exists) per `memeland/src/discovery/hint-gate.ts:1-31`. **Transport
failure fails OPEN** (cooldown, never starve); **a non-existent address fails CLOSED**.

### 4.2 Emission — launch events out of band

- **EVM4**: `eth_getLogs` on factory `PairCreated` / V4 `Initialize` via PublicNode — but the
  probes established hard limits: address filter mandatory (`-32701`), free archive window tiny
  (span 200 OK, span 500 → `-32602 Archive requests require a personal token` on eth/base;
  `max results 20000` chunking on bsc). So this is a **targeted tracer** (watch known
  factories, small windows per timer), not a sweep. Absence of logs ≠ absence of pools.
- **sol**: pump.fun new-token feed (budget `pumpfun`, `perRotationRowCap: 1`).
- **Paid signals**: DexScreener `/token-profiles/latest/v1` + `token-boosts/top/v1` → hints
  carrying `paid: true`, never promotable alone.
- Emission timers append to the hint registry / observation store; the coordinator **drains**
  at cycle time so cycle latency is unchanged.

### 4.3 Enrichment — overlay on known addresses only

| Need | Source | Notes |
|---|---|---|
| Security (EVM incl. **robinhood**) | GoPlus | `4663` live-probed, 37 fields; already wired (commit `11193e6`) |
| Security (sol) | GoPlus solana branch | already at `secondary.mjs:577-578` |
| Real **1h** volume | DexPaprika `/pools/search` | the reason that feed exists in memeland (`dexpaprika-feed.ts:140`) |
| FDV/liquidity where `market_cap` is null (robinhood 20/20) | PublicNode pair reserves + `totalSupply` | closes the rh size hole; ~100 RPC calls per rotation max → needs its own budget slice |
| Holders (sol) | Helius `getAsset` top-owners | **solana-only, keyed** (`HELIUS_API_KEY`), optional; cannot serve EVM |
| Structural contract risk | `rpc-risk.mjs` (EIP-1967 slots, EIP-170, ownership shape) | shipped; `isHoneypot/buyTax/sellTax` stay `null` — **never** guessed |
| Cross-chain token identity | DexScreener `pairs` by address | pool address, dex, socials |

**Non-goals**: honeypot/tax simulation from free RPC is impossible (proven: `debug_traceCall`
`-32601` on all four EVM RPCs; `storageDiff` `-32602`) — GoPlus remains the honeypot authority
and must **fail closed to unknown** on robinhood.

### 4.4 Screening — unchanged

Original gates stay. The row contract guarantees new sources face identical scrutiny.

### 4.5 Signal layer (P3) — evidence, not gates

Memeclaw's failure mode has been **empty output**; importing memeland's flat `80%` consensus
floor (`swarm-consensus.ts:358,437`) would worsen it. Voter *signals* are adopted; the quorum
gate is not.

- **Wallet convergence** — port `flowConvergenceScore` verbatim semantics
  (`memeland/src/services/flow-convergence.ts:48-105`): 15-min window, ≥3 distinct wallets,
  single wallet >50% of window volume ⇒ "concentrated, not converged" (score 50, not a pass),
  empty window ⇒ neutral 50. BuyEvent source (free): GeckoTerminal `pool_txs` where probeable,
  else EVM `Transfer` logs for an already-known token address (targeted, budgeted).
- **Smart money** — no free historical PnL service exists (Nansen/Birdeye paid; unverified).
  Build it from local truth: `WalletGraph` co-trade cohorts
  (`memeland/src/services/wallet-graph.ts:54-90`, port as pure .mjs) + our `outcomes[]` →
  per-wallet/win-rate over time. Cold start: neutral 50 + `degraded: true`
  (`wallet-scoring.ts:40-101` rule: missing input degrades toward neutral, never confident).
- **Bot detection** — port `botRisk` as-is: 0–100, transparent named bounded signals,
  **fail-open on missing data** (`memeland/src/services/bot-detection.ts:1-60`); inputs we
  already get free: GoPlus bundler/top10/creator, GT concentration.
- **KOL** — `social.mjs:xCapability` (agent-reach read-only X backend) exists but
  `socialGate` returns `UNVERIFIED` (parser not integrated, `social.mjs:26-29`). KOL mention
  = hint with authority to boost **priority band only**, never to bypass security. memeland's
  X path (`x-api-adapter.ts:38-58`) needs a paid bearer token — out of scope until budgeted.
- **USD-vs-count**: adopt `buyUsd1h/sellUsd1h` alongside counts — "800×$20 buys = 80% BUY by
  count but net SELLER by USD" (`gmgn-adapter.ts:34-39`). Our screen's buy/sell balance check
  should read the USD variant when a source provides it.

### 4.6 Publication

- Per-token, per-alert-type cooldown map (port `ChatNotifier`, `chat-notifier.ts:33-77`),
  **persisted** (memeland's is in-process and dies on restart — ours goes to state).
- Append-only `signalLedger` + `dedupEntries` pattern (`state-store.ts:392-421`).

### 4.7 Persistence & learning (P5)

- **Append-only JSONL event log + replay**, not read-modify-write — memeland's Postgres
  migrations are exactly this (`003_decision_events.sql`, `005_graph_events.sql`: append-only
  JSONB events + hydrate/replay; comments say state "reset on every restart"). File-backed
  under `stateDir` (Zeabur `/data`), mirroring `atomic-file-store.ts`.
- Learning loop: weight ratchet with **clamps + renormalization** (`swarm-learning.ts:219-244`),
  and the one rule worth stealing verbatim: a realized exit must never be re-fed to the
  learner — drain with a truthful label instead (`opportunity-post-mortem.ts:56-60`,
  double-count guard). Terminal-only outcomes (`WIN_GAIN_RATIO 1.5 / LOSS_LOSS_RATIO 0.8`).

## 5. Source → job matrix + free-tier management

| Source | Role | Screening | Emission | Enrichment | Security | Tier (measured) |
|---|---|---|---|---|---|---|
| **AVE** | introductor | trending→rows | — | info/candles | — | shared key; **5-min floor + 24h rate-floor after 429** — untouched, its own lane |
| **GeckoTerminal** | emitter+enricher | ✅ new_pools 10.2% | ✅ | pool fields, `pool_txs` | — | keyless; budget `spacingMs 14s, cap 3/45s` |
| **DexScreener** | enricher (+paid emitter) | via new pairs | token-profiles (paid) | pairs/socials/boosts | — | budget `250ms, 20/2s` |
| **DexPaprika** | enricher | real 1h volume | pools search | cross-check | — | budget `7s, 2/60s` |
| **GoPlus** | security | — | — | — | ✅ all 5 (4663 fixed) | budget `2s, 5/4s` |
| **PublicNode** | introductor+transport | — | logs (targeted) | reserves→FDV, bytecode | structural | keyless, all 5; budget `400ms, 8/4s`; **never on AVE clock** |
| **Helius** | enricher (sol) | — | webhook (skip: no Redis) | holders/top-owners | — | keyed, `HELIUS_API_KEY`, optional, sol-only |
| **GMGN** | hint emitter | trenches/rank | hints | — | fallback (sol) | keyed; retry policy **extends** its own ban → gated off by default |
| **Ankr** | — | — | — | — | — | **parked**: keyless fails all 5; free key plan-gated on sol/rh (`403 -32052`) |
| **dRPC** | — | — | — | — | — | **parked**: free-tier `getLogs` blocked — the only unique capability |

Budget discipline (one table, `src/ingest/budget.mjs`): token bucket + circuit breaker per
host, `detectThrottle` reads status/body/Retry-After, per-rotation row caps. Add memeland's
**refund-on-5xx** semantics to `SourceBudget.report()` if not already charging post-call
(check `beginRotation`/`report` pairing), and its breaker rule that a 429 opens the circuit
**without blaming the tokens** (`provider-rate-limiter.ts:8-11`). Never a third parallel
rate-limit mechanism — memeland's governor/rate-limiter/source-quota overlap is explicitly
flagged as debt.

## 6. Phasing

| Phase | Deliverable | Acceptance |
|---|---|---|
| **P0** (security) | auth on `/api/ave-remove` + read `PASSWORD` | unauth'd POST rejected; existing tests green |
| **P1** (yield) | coordinator + GT emitter + row-contract mapper + registry seam at `scanner.mjs:618`, config-gated | tests: observation-before-merge, per-emitter fail-open, hint never promotes nonexistent; live: qualified yield ≥ 3× AVE-only on one rotation, AVE floor unchanged |
| **P2** (enrich) | PublicNode FDV/liquidity overlay (robinhood hole), DexPaprika 1h volume, optional Helius | rh candidates get size fields non-null; `isHoneypot` still `null`-safe |
| **P3** (signal) | convergence + walletScore + botRisk as deep-audit inputs; publish dedup | signals land in `deep` evidence; missing input ⇒ `degraded`, never gate |
| **P4** (emission) | logs/pump.fun timers → hint registry → existence oracle | hints promoted only by oracle; transport-down ⇒ fail-open cooldown |
| **P5** (learning) | JSONL event log + outcome ratchet with clamps | realized exit never re-fed; weights bounded ±30% |

## 7. Deliberately NOT copied from memeland

- The **80% consensus quorum** (empty-output amplifier for our funnel).
- **Three overlapping rate-limiters** — we keep exactly one budget table.
- **Dead registrations** (`pumpdev` registered but missing from priority → never runs);
  our registry validates ids at boot.
- **base58 lowercasing** (their own contradiction).
- **In-process-only cooldowns** — ours persist.
- **Helius webhook + Redis stream** — no Redis here; polls only.
- `Result<T,E>` half-migration — we throw-and-classify at the transport boundary only.
