// Hints, the existence oracle, and the ONE path from a hint to a discovery row.
//
// The problem this solves, stated plainly: a launch-event feed (a DEX factory
// log, a paid DexScreener profile, a KOL mention) is a *claim* that a token
// exists, not a measurement that it does. A paid feed will happily list an
// address that was never deployed, and a "trending profile" feed is sold by the
// people who want you to buy. So a hint is admitted with "recall without
// authority" (ARCHITECTURE-FULL-PIPELINE.md §Hints, :124-127) and it may ONLY
// become a discovery row through one gate:
//
//     promoteChecked()  ->  existenceOracle()  ->  exists === true
//
// Two failure directions, deliberately NOT symmetric (same doc, :127):
//
//   * A NON-EXISTENT address fails CLOSED. exists === false drops the hint
//     permanently. Treating "we could not find it" as "it is fine" is how a
//     fake launch reaches a screen.
//   * A TRANSPORT failure fails OPEN. exists === null + transportDown puts the
//     HINT'S OWN SOURCE into a cooldown and leaves the hint in place for the
//     next round. It does not block, and it does not starve the funnel: the
//     cooldown is keyed per source, so a dead source silences only itself while
//     every other source keeps promoting.
//
// `exists` is a tri-state on purpose: true / false / null. Collapsing null into
// false (the "no harm, mark it absent" shortcut) would delete real candidates
// every time PublicNode hiccups; collapsing null into true (the "optimistic"
// shortcut) would publish tokens nobody has verified exists. The tri-state is
// the whole point of the module.
//
// Measured constraints this file is shaped by (live probes, PublicNode):
//   * JSON-RPC errors arrive as HTTP 200 with an `error` member. A transport
//     check that only reads the HTTP status sees a "success" that carries no
//     result. rpcCall() (adapters/rpc-risk.mjs:80) already unwraps that, and is
//     reused rather than reimplemented so there is one place that knows it.
//   * solana-rpc.publicnode.com answers getAccountInfo and getHealth, but
//     eth_getLogs with `Method not found` (-32601) — so the EVM oracle and the
//     sol oracle are genuinely different calls, not one address check.
//   * A random 32-byte base58 account returns `value: null` (probed ×4), which
//     is the only honest sol "does not exist" signal: null, not false-by-default.

import { readFileSync, appendFileSync } from 'node:fs';

import { createRecord } from './record.mjs';
import { normalizeTokenAddress } from '../address.mjs';
import { rpcCall, rpcUrlFor, isEvmChain } from './adapters/rpc-risk.mjs';

// Default hint life: a launch hint that has not been promoted within half an
// hour is no longer news, and holding it forever turns the registry into a
// backlog nobody reads.
export const DEFAULT_HINT_TTL_MS = 30 * 60_000;

// Ceiling so a runaway emitter cannot grow the registry without bound. Dropped
// are the OLDEST (a launch feed's freshest rows are the valuable ones).
export const DEFAULT_MAX_HINTS = 500;

// Same 30 s floor the source budgets use. Not tunable per source on purpose:
// this is the smallest window in which a free public RPC has been observed to
// come back.
export const HINT_COOLDOWN_FLOOR_MS = 30_000;

// Probed working (getHealth -> "ok", getAccountInfo answered). Mirrors the EVM
// endpoints already pinned in PUBLICNODE_RPC (adapters/rpc-risk.mjs:28).
export const SOLANA_RPC = Object.freeze({ sol: 'https://solana-rpc.publicnode.com' });

export const HINT_DISPOSITION = Object.freeze({
  PROMOTED: 'promoted',
  ABSENT: 'absent',
  TRANSPORT_DOWN: 'transport_down',
  SKIPPED_EXPIRED: 'skipped_expired',
  SKIPPED_COOLDOWN: 'skipped_cooldown',
  SKIPPED_LIMIT: 'skipped_limit',
  SKIPPED_INVALID: 'skipped_invalid',
});

// One hint. `source` is the emitter id, and it is also the cooldown key: a hint
// source that cannot be checked is silenced alone.
export function createHint({
  chain,
  address,
  source = 'unknown',
  origin = null,
  paid = false,
  discoveredAtMs = Date.now(),
  poolAddress = null,
  meta = {},
} = {}) {
  const normalized = normalizeTokenAddress(chain, address);
  if (normalized === null) return null;
  return {
    chain,
    address: normalized,
    poolAddress,
    source,
    origin,
    // A paid signal is a marketing claim. It is recorded so a later screen can
    // discount it, never so it can be promoted on its own.
    paid: paid === true,
    discoveredAtMs,
    key: `${chain}:${normalized}`,
    meta,
  };
}

// The registry. In-memory by default; `path` makes it file-backed (append-only
// JSON lines) so a restart does not silently drop the queue. Persistence is
// best-effort and NEVER fatal: a read-only volume must not take the funnel
// down, so failures are recorded on `persistenceError` for the operator instead
// of thrown.
export class HintRegistry {
  constructor({
    ttlMs = DEFAULT_HINT_TTL_MS,
    maxHints = DEFAULT_MAX_HINTS,
    cooldownFloorMs = HINT_COOLDOWN_FLOOR_MS,
    clock = () => Date.now(),
    path = null,
    // Options handed to the oracle on every check. `budget` is the rotation's
    // shared publicnode bucket (per host, not per chain) so existence checks
    // spend the same allowance as risk reads instead of opening a second lane.
    oracleOptions = {},
  } = {}) {
    this.oracleOptions = { ...oracleOptions };
    this.oracleBudget = oracleOptions.budget ?? null;
    this.ttlMs = ttlMs > 0 ? ttlMs : DEFAULT_HINT_TTL_MS;
    this.maxHints = maxHints > 0 ? maxHints : DEFAULT_MAX_HINTS;
    this.cooldownFloorMs = cooldownFloorMs > 0 ? cooldownFloorMs : HINT_COOLDOWN_FLOOR_MS;
    this.clock = clock;
    this.path = path;
    this.hints = new Map();
    this.promotedKeys = new Set();
    this.cooldowns = new Map();
    this.stats = { added: 0, deduped: 0, rejected: 0, expired: 0, promoted: 0, absent: 0, transportDown: 0 };
    this.persistenceError = null;
    this.#load();
  }

  #load() {
    if (!this.path) return;
    let text;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      // A missing file is the normal first-run case; anything else is reported.
      if (error?.code !== 'ENOENT') this.persistenceError = `read_failed: ${error.message}`;
      return;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const hint = createHint({
          chain: parsed.chain,
          address: parsed.address,
          source: parsed.source,
          origin: parsed.origin ?? null,
          paid: parsed.paid === true,
          discoveredAtMs: Number(parsed.discoveredAtMs) || this.clock(),
          poolAddress: parsed.poolAddress ?? null,
          meta: parsed.meta ?? {},
        });
        if (hint === null) continue;
        this.hints.set(hint.key, hint);
      } catch {
        // One corrupt line must not discard the rest of the queue.
      }
    }
  }

  #persist(hint) {
    if (!this.path) return;
    try {
      appendFileSync(this.path, `${JSON.stringify(hint)}\n`, 'utf8');
    } catch (error) {
      this.persistenceError = `append_failed: ${error.message}`;
    }
  }

  #dropExpired(now) {
    const expired = [];
    for (const [key, hint] of this.hints) {
      if (now - hint.discoveredAtMs > this.ttlMs) expired.push(key);
    }
    for (const key of expired) this.hints.delete(key);
    if (expired.length > 0) this.stats.expired += expired.length;
    return expired;
  }

  // Accepts a hint object or the raw fields createHint understands.
  // Returns {accepted, hint, reason} — the caller can push the reason into the
  // coordinator's findings instead of dropping the fact on the floor.
  //
  // The REGISTRY dates every hint that enters it, unconditionally. It owns the
  // TTL, so a timestamp measured against a clock it does not know is meaningless
  // to it — and `createHint`'s own default is `Date.now()`, which is exactly such
  // a clock. That mismatch is not cosmetic: the emitter builds hints with
  // `Date.now()`, the coordinator is handed a registry on an injected clock, and
  // the hint is born already past its TTL, so the queue silently drops every
  // candidate it is given. Re-dating a duplicate is harmless because the
  // duplicate is rejected and the earlier sighting is kept below.
  //
  // Ages that must survive a restart are NOT re-dated: #load() reads the stored
  // `discoveredAtMs` straight into the map, because a persisted queue's age is
  // real elapsed time and re-dating it would reset the TTL on every boot.
  add(hintOrFields) {
    const hint = typeof hintOrFields?.key === 'string'
      ? { ...hintOrFields, discoveredAtMs: this.clock() }
      : createHint({ ...hintOrFields, discoveredAtMs: this.clock() });
    if (hint === null || typeof hint.key !== 'string') {
      this.stats.rejected += 1;
      return { accepted: false, hint: null, reason: 'invalid_address' };
    }
    const now = this.clock();
    if (this.promotedKeys.has(hint.key)) {
      // Already through the oracle. Re-adding it would spend an RPC call per
      // rotation to re-learn something we already proved.
      this.stats.deduped += 1;
      return { accepted: false, hint, reason: 'already_promoted' };
    }
    this.#dropExpired(now);
    const existing = this.hints.get(hint.key);
    if (existing) {
      // Dedupe by chain:address — but KEEP the earliest sighting: an address
      // that appeared 40 minutes ago in a cooldown is still older news than one
      // that appeared a second ago.
      this.stats.deduped += 1;
      return { accepted: false, hint: existing, reason: 'duplicate' };
    }
    if (this.hints.size >= this.maxHints) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, entry] of this.hints) {
        if (entry.discoveredAtMs < oldestAt) {
          oldestAt = entry.discoveredAtMs;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) this.hints.delete(oldestKey);
    }
    this.hints.set(hint.key, hint);
    this.stats.added += 1;
    this.#persist(hint);
    return { accepted: true, hint, reason: null };
  }

  pending({ now = this.clock() } = {}) {
    this.#dropExpired(now);
    return [...this.hints.values()];
  }

  // Reports the LIVE queue size, not the raw map size: a caller polling this to
  // decide whether the funnel has work must not be told there is work when every
  // remaining hint expired an hour ago. Sweeping here is cheap (maxHints-bounded)
  // and keeps `size()` and `pending()` from disagreeing.
  size() {
    this.#dropExpired(this.clock());
    return this.hints.size;
  }

  // Empties the queue. Callers that must not lose a hint on a failed check use
  // pending() + re-add instead; drain() is the honest "I am taking these" step.
  drain() {
    const now = this.clock();
    this.#dropExpired(now);
    const drained = [...this.hints.values()];
    this.hints.clear();
    return drained;
  }

  // The registry's half of the gate: refuses anything not positively checked.
  // Kept here (not only in promoteChecked) so a future caller cannot promote by
  // calling the oracle directly and skipping the record bookkeeping.
  promote(hint, { checked, capturedAtSec = this.clock() / 1000, sourceUrl = null } = {}) {
    if (!hint) return null;
    if (checked?.exists !== true) return null;
    const record = createRecord({
      chain: hint.chain,
      address: hint.address,
      source: hint.source,
      poolAddress: hint.poolAddress ?? null,
      sourceUrl,
      capturedAtSec,
      stale: false,
      evidence: {
        origin: hint.origin ?? null,
        paid: hint.paid === true,
        oracle: {
          exists: true,
          method: checked.method ?? null,
          codeBytes: checked.codeBytes ?? null,
          owner: checked.owner ?? null,
          latencyMs: checked.latencyMs ?? null,
        },
      },
    });
    if (record === null) return null;
    // A hint promoted on chain is still an address with NO size, NO liquidity
    // and NO age. Labelling that explicitly is what stops a downstream screen
    // from reading the nulls as zeros.
    record.unresolved = [
      ...(hint.meta?.unresolved ?? []),
      'existence_verified_only',
      'size_unknown',
      'liquidity_unknown',
      'pair_age_unknown',
    ];
    this.promotedKeys.add(hint.key);
    this.stats.promoted += 1;
    return record;
  }

  noteTransportDown(source, { reason = 'transport', now = this.clock() } = {}) {
    const until = now + this.cooldownFloorMs;
    const current = this.cooldowns.get(source);
    if (!current || current.until > until) this.cooldowns.set(source, { until, reason });
    this.stats.transportDown += 1;
    return this.cooldowns.get(source);
  }

  cooldownFor(source, { now = this.clock() } = {}) {
    const entry = this.cooldowns.get(source);
    if (!entry) return { open: false, remainingMs: 0, until: 0, reason: null };
    if (entry.until <= now) {
      this.cooldowns.delete(source);
      return { open: false, remainingMs: 0, until: 0, reason: null };
    }
    return { open: true, remainingMs: entry.until - now, until: entry.until, reason: entry.reason };
  }

  isCoolingDown(source, options = {}) {
    return this.cooldownFor(source, options).open;
  }

  snapshot() {
    return {
      pending: this.hints.size,
      promoted: this.promotedKeys.size,
      cooldowns: Object.fromEntries([...this.cooldowns.entries()].map(([key, value]) => [key, value.reason])),
      stats: { ...this.stats },
      persistenceError: this.persistenceError,
      fileBacked: Boolean(this.path),
    };
  }
}

// Budget-taking wrapper, so the oracle shares the rotation's publicnode bucket
// (per host, NOT per chain — budget.mjs:140-144). A row cap reaching here is a
// hard "not now", which is fail-open with a reason, not a transport failure.
async function take(budget, chain) {
  if (!budget) return { ok: true, capped: false };
  try {
    await budget.take(chain);
    return { ok: true, capped: false };
  } catch (error) {
    if (error?.code === 'ROW_CAP') return { ok: true, capped: true };
    throw error;
  }
}

// `error` keeps the machine-readable cause ('rpc_-32602', 'network', …) and
// `reason` the human one; both travel so a caller can branch on either without
// re-deriving it from the other's prose.
function transportDown(error, extra = {}) {
  return {
    exists: null,
    transportDown: true,
    error,
    reason: extra.reason ?? String(error ?? 'transport'),
    ...extra,
  };
}

async function evmExistence(address, chain, { fetchImpl, timeoutMs, budget }) {
  const url = rpcUrlFor(chain);
  if (!url) return transportDown('no_rpc_url', { method: 'eth_getCode' });
  const slot = await take(budget, chain);
  if (slot.capped) return transportDown('row_cap', { method: 'eth_getCode', rowCapped: true });
  const call = await rpcCall(url, 'eth_getCode', [address, 'latest'], { fetchImpl, timeoutMs });
  if (!call.ok) return transportDown(call.error, { method: 'eth_getCode', latencyMs: call.latencyMs });
  const body = String(call.result ?? '0x').replace(/^0x/i, '');
  return {
    exists: body.length > 0,
    transportDown: false,
    method: 'eth_getCode',
    codeBytes: body.length / 2,
    latencyMs: call.latencyMs,
  };
}

// solana-rpc.publicnode.com has no eth_getCode equivalent; existence is "the
// account exists". Probed: USDC -> value present (owner Tokenkeg...); four
// random 32-byte base58 accounts -> value: null.
async function solExistence(address, chain, { fetchImpl, timeoutMs, budget }) {
  const url = SOLANA_RPC[chain] ?? null;
  if (!url) return transportDown('no_rpc_url', { method: 'getAccountInfo' });
  const slot = await take(budget, chain);
  if (slot.capped) return transportDown('row_cap', { method: 'getAccountInfo', rowCapped: true });
  const call = await rpcCall(url, 'getAccountInfo', [address, { encoding: 'base64' }], { fetchImpl, timeoutMs });
  if (!call.ok) return transportDown(call.error, { method: 'getAccountInfo', latencyMs: call.latencyMs });
  const value = call.result?.value ?? null;
  return {
    exists: value !== null && value !== undefined,
    transportDown: false,
    method: 'getAccountInfo',
    owner: value?.owner ?? null,
    executable: value?.executable === true,
    latencyMs: call.latencyMs,
  };
}

// The existence oracle. Tri-state `exists`, never a boolean.
//
//   {exists:true,  transportDown:false}  -> promotable
//   {exists:false, transportDown:false}  -> fails CLOSED (drop the hint)
//   {exists:null,  transportDown:true }  -> fails OPEN  (cooldown the source)
//
// The address is normalised first: an address that cannot exist on this chain
// is `exists:false` without spending a request, which is both correct and the
// cheapest possible answer to a malformed hint.
export async function existenceOracle(address, chain, { fetchImpl = globalThis.fetch, timeoutMs = 12_000, budget = null } = {}) {
  const normalized = normalizeTokenAddress(chain, address);
  if (normalized === null) {
    return { exists: false, transportDown: false, method: 'normalize', reason: 'invalid_address' };
  }
  if (!isEvmChain(chain) && !SOLANA_RPC[chain]) {
    return transportDown('unsupported_chain', { method: null });
  }
  try {
    return isEvmChain(chain)
      ? await evmExistence(normalized, chain, { fetchImpl, timeoutMs, budget })
      : await solExistence(normalized, chain, { fetchImpl, timeoutMs, budget });
  } catch (error) {
    // take() can throw something that is not ROW_CAP; a checker must never
    // propagate an exception into the rotation, so it is a transport failure.
    return transportDown(error?.code ?? error?.message ?? 'oracle_error', { method: null });
  }
}

// THE ONLY PATH from a hint to a record. Callers get `dispositions`, so a
// skipped hint is visible in the cycle's events instead of vanishing.
//
// Oldest-first: the TTL is the freshness bound, so a hint that has been waiting
// longer has had fewer chances at promotion. `limit` caps oracle calls per pass;
// the remainder stay queued for the next rotation rather than being dropped.
export async function promoteChecked(registry, oracle = existenceOracle, { limit = 20, capturedAtSec = null, clock = null } = {}) {
  if (!(registry instanceof HintRegistry)) {
    throw new TypeError('promoteChecked requires a HintRegistry');
  }
  if (typeof oracle !== 'function') {
    throw new TypeError('promoteChecked requires an oracle function');
  }
  const records = [];
  const dispositions = [];
  // DEFAULT to the registry's own clock, not Date.now(). A second time base in
  // the same pass is a silent corruption: expiry, cooldown windows and
  // capturedAtSec are all measured against it. With an injected clock the
  // mismatch is spectacular — every hint reads as hours old, so the queue
  // sweeps itself empty and the cooldown this pass just opened is already
  // "expired" when the next line asks.
  const now = (clock ?? registry.clock)();
  const queue = registry.pending({ now }).sort((a, b) => a.discoveredAtMs - b.discoveredAtMs);
  let checked = 0;

  for (const hint of queue) {
    if (checked >= limit) {
      dispositions.push({ key: hint.key, source: hint.source, disposition: HINT_DISPOSITION.SKIPPED_LIMIT, reason: 'limit' });
      continue;
    }
    const cooldown = registry.cooldownFor(hint.source, { now });
    if (cooldown.open) {
      // The whole source is silenced, not this hint: the next source in the
      // queue is still eligible, which is what "never starve the funnel" means.
      dispositions.push({ key: hint.key, source: hint.source, disposition: HINT_DISPOSITION.SKIPPED_COOLDOWN, reason: cooldown.reason });
      continue;
    }
    let result;
    try {
      result = await oracle(hint.address, hint.chain, {
        ...registry.oracleOptions,
        budget: registry.oracleBudget ?? null,
      });
    } catch (error) {
      result = { exists: null, transportDown: true, reason: error?.message ?? 'oracle_threw' };
    }
    checked += 1;

    if (result?.exists === true) {
      const record = registry.promote(hint, { checked: result, capturedAtSec: capturedAtSec ?? now / 1000 });
      if (record === null) {
        dispositions.push({ key: hint.key, source: hint.source, disposition: HINT_DISPOSITION.SKIPPED_INVALID, reason: 'record_rejected' });
        continue;
      }
      registry.hints.delete(hint.key);
      records.push(record);
      dispositions.push({ key: hint.key, source: hint.source, disposition: HINT_DISPOSITION.PROMOTED });
      continue;
    }

    if (result?.exists === false) {
      registry.hints.delete(hint.key);
      registry.stats.absent += 1;
      dispositions.push({
        key: hint.key,
        source: hint.source,
        disposition: HINT_DISPOSITION.ABSENT,
        reason: result.reason ?? null,
        method: result.method ?? null,
      });
      continue;
    }

    // exists is null: we could not find out. Fail OPEN — keep the hint, silence
    // this source for the cooldown window, and move on to the next source.
    registry.noteTransportDown(hint.source, { reason: result?.error ?? result?.reason ?? 'transport', now });
    dispositions.push({
      key: hint.key,
      source: hint.source,
      disposition: HINT_DISPOSITION.TRANSPORT_DOWN,
      reason: result?.error ?? result?.reason ?? 'transport',
      retained: true,
    });
  }

  return { records, dispositions, checked, promoted: records.length, pending: registry.size() };
}

