// DexPaprika token-search — the second discovery feed, all five chains.
//
// Why tokens/search and not pools/search: pool rows carry a POOL id (the pair
// address on EVM), and the discovery screen needs a TOKEN address — screening
// a pair address as a token is the exact adapter defect that zeroed GT rows in
// the adversarial lane (C1.5). Token rows were measured on robinhood:
//   {address, fdv_usd, liquidity_usd, volume_usd_24h, txns_24h,
//    created_at: "2026-10-05T12:29:19Z"}
// eth/base verified with created_after + fdv filters; bsc returns
// {results: []} even completely unfiltered (measured) — that is an honest
// empty feed, reported as an info finding, not an error.
//
// Envelope: `{results, has_next_page}` for search routes (NOT `pools`/`tokens`
// — reading the wrong key reports "0 rows" against a body that contains them;
// measured live on all five chains). Route gaps (404) and plan gates (403)
// arrive as HttpError and become findings; this lane never throws into the
// cycle and never retries beyond the budget's own pacing.
//
// Auth: keyless works (10 rpm, 10000 credits/30d). `Authorization: Bearer`
// flips the measured header pair x-credits-limit 10000 → 100000, so the key is
// sent when present and the lane still runs without it. Pacing and the credit
// pool live in SOURCE_BUDGETS.dexpaprika (spacing 7s, one row-cap per chain
// per rotation) — this file adds no second bucket for the same host.

import { createRecord } from '../record.mjs';
import { createBudget } from '../budget.mjs';
import { IngestHttp } from '../http.mjs';
import { DEXPAPRIKA_NETWORKS } from '../chain-map.mjs';

const HOST = 'https://api.dexpaprika.com';

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** ISO-8601 (measured format) → epoch seconds; null when unparseable. */
function isoToSec(value) {
  const text = str(value);
  if (text === null) return null;
  // Numeric strings arrive on some routes; seconds vs ms the same defensive
  // rule as GMGN/pump.fun.
  const asNumber = num(text);
  if (asNumber !== null) return asNumber > 1e11 ? Math.round(asNumber / 1000) : Math.round(asNumber);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : null;
}

/**
 * Parse one tokens/search row into a record. Pure, no network.
 * fdv_usd populates size.fdv ONLY: measured rows carry fdv_usd and no
 * market_cap, so sizeIsFdvOnly stays true and the screen substitutes a
 * LABELLED FDV basis instead of a hidden cap (row-contract contract).
 */
export function parseTokenRow(row, { chain = null, capturedAtSec = Date.now() / 1000 } = {}) {
  if (!row || typeof row !== 'object') return null;
  const address = str(row.address);
  if (address === null) return null;

  const record = createRecord({
    chain,
    address,
    source: 'dexpaprika',
    pairCreatedAtSec: isoToSec(row.created_at),
    fdvUsd: num(row.fdv_usd),
    marketCapUsd: num(row.market_cap),
    liquidityUsd: num(row.liquidity_usd),
    holders: null,
    symbol: str(row.symbol),
    name: str(row.name),
    sourceUrl: null,
    capturedAtSec,
    evidence: {
      volume24hUsd: num(row.volume_usd_24h),
      txns24h: num(row.txns_24h),
      dexId: str(row.dex_id),
    },
  });
  // createRecord hard-codes unresolved: [] (it cannot know a caller's gaps);
  // set it after, like pumpfun does. A market screener supplies zero security
  // and zero holders — provenance so the evidence view says "never fetched
  // here", never "no risk". The screen reads absent keys as unknown.
  record.unresolved = ['security', 'holders'];
  return record;
}

/** Coordinator-shaped emitter for all five chains; key optional. */
export function createDexPaprikaEmitter({
  fetchImpl = globalThis.fetch,
  http = null,
  budget = null,
  apiKey = process.env.DEXPAPRIKA_API_KEY,
} = {}) {
  const key = String(apiKey ?? '').trim();
  const budgetRef = budget ?? createBudget('dexpaprika');
  const client = http ?? new IngestHttp({ budget: budgetRef, fetchImpl, timeoutMs: 15_000 });

  return {
    id: 'dexpaprika',
    provider: 'DEXPAPRIKA',
    budget: budgetRef,

    enabled(chain) {
      return Object.hasOwn(DEXPAPRIKA_NETWORKS, chain);
    },

    async discover(chain, { out = [] } = {}) {
      const network = DEXPAPRIKA_NETWORKS[chain];
      // Only measured-safe params: order_by/sort proven on robinhood,
      // created_after -24h proven on eth/base. bsc's empty results were
      // measured WITH and without filters, so no filter can be blamed for it.
      // `limit` is deliberately absent: proven on pools/search, never on
      // tokens/search, and an unproven param is how a lane silently 400s.
      const url = `${HOST}/networks/${network}/tokens/search?created_after=-24h&order_by=created_at&sort=desc`;
      const headers = key !== '' ? { authorization: `Bearer ${key}` } : {};
      let response;
      try {
        response = await client.json(url, { chain, headers });
      } catch (error) {
        out.push({
          level: error?.throttled ? 'warn' : 'error',
          chain,
          source: 'dexpaprika',
          throttled: error?.throttled === true,
          reason: `dexpaprika tokens/search ${error?.throttled ? 'throttled' : 'failed'}: ${String(error?.message ?? error).slice(0, 160)}`,
        });
        return [];
      }
      const payload = response?.data;
      const rows = Array.isArray(payload?.results) ? payload.results
        : Array.isArray(payload) ? payload
          : [];
      if (rows.length === 0) {
        // Measured reality for bsc and for quiet windows: an empty feed is a
        // fact about the source, not a failure of the lane.
        out.push({
          level: 'info',
          chain,
          source: 'dexpaprika',
          reason: `tokens/search returned 0 rows for ${network} (has_next_page=${payload?.has_next_page ?? 'n/a'})`,
        });
        return [];
      }
      const capturedAtSec = Date.now() / 1000;
      const records = rows.map(row => parseTokenRow(row, { chain, capturedAtSec })).filter(Boolean);
      out.push({
        level: 'info',
        chain,
        source: 'dexpaprika',
        reason: `${records.length}/${rows.length} token rows parsed, ${response.latencyMs ?? 0}ms`,
      });
      return records;
    },
  };
}
