// P2 wiring: hangs the four enrichment lanes off a discovery coordinator
// WITHOUT editing it.
//
// WHY A SEPARATE FILE EXISTS
// --------------------------
// Every source that would want to touch `discover()` is somebody else's file
// under review. Prototype delegation is the whole trick: `attachEnrichment`
// returns an object whose prototype IS the coordinator, so `providers`,
// `beginRotation`, `snapshot`, `lastRun` and every future member resolve
// untouched. An emitter downstream cannot tell the difference, and if this file
// is deleted the coordinator is byte-identical to what it was.
//
// WHAT IT IS NOT
// --------------
// It is not a second discovery pass and it does not decide anything. Every lane
// runs AFTER `discover()` has already returned its records and can only fill a
// null with a measurement. A record that came out of a lane exactly as it went
// in is a complete success: enrichment is best-effort by construction, so the
// absence of a finding is the normal case and must never mean "no data exists".
//
// The one thing this file is allowed to be clever about is DECIMALS. Everything
// else is plumbing.

import {
  ENRICHMENT_BASIS,
  PublicNodeSizeLane,
  DexPaprikaVolumeLane,
  HeliusHoldersLane,
  heliusAvailability,
  overlayFromDexScreenerBatch,
  applySizeOverlay,
} from './enrich.mjs';
import { SOURCE_BUDGETS, createBudget } from './budget.mjs';
import { IngestHttp } from './http.mjs';

// DexScreener's chain vocabulary. Copied from secondary.mjs:11 rather than
// imported because that constant is module-private there, and a second
// definition that drifts is worse than one that is documented as a copy.
const DEX_CHAIN_IDS = Object.freeze({
  sol: 'solana',
  eth: 'ethereum',
  bsc: 'bsc',
  base: 'base',
  robinhood: 'robinhood',
});

// Measured 2026-10 against `GET https://api.dexpaprika.com/networks`, which
// lists all five of ours including `{"display_name":"Robinhood Chain",
// "id":"robinhood","pools_count":15777}`. robinhood is therefore INCLUDED here:
// an earlier draft of this file assumed Paprika had no robinhood network, which
// the live endpoint disproves. The mapping is verified against that response,
// not inferred from a sibling chain.
//
// The lane builds its own URL from the chain argument (enrich.mjs:526-528), so
// the slug it needs must be passed AS the chain. That string also lands in the
// lane's cache key and in the budget's per-chain row count — both are opaque
// labels there, so passing a slug is harmless; passing `robinhood` and `eth`
// unchanged would be fine too, and only `sol`/`eth` actually differ.
//
// A chain absent from this map is SKIPPED with a finding rather than guessed at.
const PAPRIKA_NETWORKS = Object.freeze({
  eth: 'ethereum',
  bsc: 'bsc',
  base: 'base',
  sol: 'solana',
  robinhood: 'robinhood',
});

// `decimals()` is the first four bytes of its keccak signature. Reading the real
// value instead of assuming 18 is not a nicety: 18 vs 6 is a 10^12 error that
// lands in the FDV column as a plausible dollar figure with twelve extra zeros.
const SELECTORS = Object.freeze({ decimals: '0x313ce567' });

// How many budgeted HTTP calls one enriched record costs, and therefore how
// many records the shared per-rotation row cap actually buys.
//
// The cap in SOURCE_BUDGETS counts REQUESTS, not records. One
// `PublicNodeSizeLane.overlay()` spends four: totalSupply, getReserves, token0,
// token1 (enrich.mjs:341-345). The decimals gate below spends two more, one for
// the token and one for its quote asset. So a record costs six units of a cap
// that says ten, and the naive "process up to perRotationRowCap records" reading
// walks into `ROW_CAP` on the fourth record and half-measures it.
//
// The row cap is per chain (budget.mjs:190-194), and the scanner advances one
// chain per cycle, so this is per chain per rotation. At today's numbers that is
// one record. That is uncomfortably small, and it is the honest consequence of
// the shared table rather than a tuning choice made here — see the report.
const PUBLICNODE_CALLS_PER_RECORD = 6;

// ---------------------------------------------------------------------------
// Small helpers. Each one exists because the alternative is a silent wrong value.
// ---------------------------------------------------------------------------

function positive(value) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// `record.price` is the field createRecord actually writes (record.mjs:76); the
// constructor parameter is `priceUsd`. Reading the parameter name off a built
// record yields undefined, which then reads as "no price available" and quietly
// disables the one derivation that does not need the pool.
function recordPriceUsd(record) {
  return positive(record?.price) ?? positive(record?.priceUsd);
}

function needsSize(record) {
  return record?.size?.fdv == null || record?.size?.marketCap == null || record?.liquidityUsd == null;
}

function needsVolume(record) {
  return record?.activity?.volume1hUsd == null;
}

// A finding is what the scanner turns into an INGEST event (scanner.mjs:716-721),
// so it must carry a reason a human can act on. `level: 'info'` is skipped
// entirely by that loop, which is why a routine "we skipped this" is a warning
// and not a note — a lane silently not running is an operational fact.
function finding(level, chain, source, reason, extra = {}) {
  return { level, chain, source, reason, ...extra };
}

function chunk(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

// Priority as the record shape actually spells it. `priorityBand` is a boolean
// in scanner.mjs/scoring.mjs and does not live on the record at all today, so
// this normally degenerates to "first in the array" — which is the documented
// fallback, not a silent mis-sort.
function priorityOf(record) {
  const direct = record?.priority;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const band = record?.priorityBand ?? record?.screen?.priorityBand;
  if (band === true) return 1;
  if (band === false) return 0;
  return 0;
}

// ---------------------------------------------------------------------------
// The lanes
// ---------------------------------------------------------------------------

// Lane 1 — DexScreener. The workhorse: it fills size AND liquidity in one call,
// needs no pool address, no decimals and no key, so it must run first and the
// rest of the lanes only see what it could not close.
async function dexScreenerLane(chain, records, { http, findings }) {
  const dexChainId = DEX_CHAIN_IDS[chain];
  // No slug means no call. Interpolating `undefined` into the path would send a
  // real request to a URL that cannot exist, which spends a rate-limit unit to
  // learn nothing and shows up in the host's logs as this bot misbehaving.
  if (dexChainId === undefined) {
    findings.push(finding('info', chain, 'enrich:dexscreener', `dexscreener has no ${chain} network slug; the batch lane is not applicable`));
    return;
  }
  const wanted = [];
  const seen = new Set();
  for (const record of records) {
    if (!needsSize(record)) continue;
    const address = String(record.address ?? '').trim();
    if (address === '') continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push({ record, address, key });
  }
  if (wanted.length === 0) return;

  for (const batch of chunk(wanted, 30)) {
    const url = `https://api.dexscreener.com/tokens/v1/${dexChainId}/${batch.map(entry => encodeURIComponent(entry.address)).join(',')}`;
    let payload;
    try {
      ({ data: payload } = await http.json(url, { chain }));
    } catch (error) {
      // Fail OPEN: the records go back exactly as they came in. A rejected row
      // that has been silently half-enriched is worse than one that was never
      // touched, because the reason it was rejected no longer describes it.
      findings.push(finding(
        error?.throttled === true ? 'warn' : 'error',
        chain,
        'enrich:dexscreener',
        `dexscreener batch failed, ${batch.length} record(s) left unenriched: ${String(error?.message ?? error).slice(0, 160)}`,
        { throttled: error?.throttled === true },
      ));
      continue;
    }

    for (const entry of batch) {
      const overlay = overlayFromDexScreenerBatch(payload, entry.address);
      const enriched = applySizeOverlay(entry.record, overlay);
      // The pool address is what admits a record to lane 3, and DexScreener is
      // the only one of the four that can supply it for a record GeckoTerminal
      // gave us without one. Fill-only, like every other write here.
      if (typeof overlay.pairAddress === 'string' && overlay.pairAddress !== '' && !entry.record.poolAddress) {
        enriched.poolAddress = overlay.pairAddress;
      }
      enriched.evidence = {
        ...(enriched.evidence ?? {}),
        enrichment: {
          ...(enriched.evidence?.enrichment ?? {}),
          dexId: overlay.dexId,
          dexScreenerPair: enriched.poolAddress ?? null,
        },
      };
      Object.assign(entry.record, enriched);
    }
  }
}

// Lane 2 — DexPaprika 1h volume. One record per rotation, and it is the record
// with the best priority, because this feed exists for one reason: telling a
// fresh pool apart from a dead one. GeckoTerminal reports volume on some
// chains and not others, so the gap is real rather than hypothetical.
async function dexPaprikaLane(chain, records, { lane, findings }) {
  const network = PAPRIKA_NETWORKS[chain];
  if (network === undefined) {
    findings.push(finding('info', chain, 'enrich:dexpaprika', `dexpaprika has no ${chain} network id; 1h volume lane not applicable`));
    return;
  }
  const candidates = records.filter(record => needsVolume(record) && record.address);
  if (candidates.length === 0) return;
  const target = [...candidates].sort((a, b) => priorityOf(b) - priorityOf(a))[0];

  // The lane refuses rather than waits, and a refusal is not an error: it is the
  // cadence guard or the credit pool doing its job. Record it as a warning and
  // move on; retrying here would hold the rotation for a number that cannot
  // change.
  const result = await lane.volume1h(network, { address: target.address });
  if (result.volume1hUsd === null || result.volume1hUsd === undefined) {
    findings.push(finding('warn', chain, 'enrich:dexpaprika',
      `dexpaprika produced no 1h volume for ${target.address} (${result.cadenceGuard ?? 'unknown'}): ${String(result.reason ?? 'no reason given').slice(0, 140)}`,
      { degraded: true }));
    return;
  }
  if (!needsVolume(target)) return; // a concurrent lane filled it first
  target.activity = { ...(target.activity ?? {}), volume1hUsd: positive(result.volume1hUsd) };
  target.evidence = {
    ...(target.evidence ?? {}),
    enrichment: { ...(target.evidence?.enrichment ?? {}), volume1h: { basis: result.basis, cadenceGuard: result.cadenceGuard ?? null } },
  };
}

// The decimals gate for lane 3. Returns real decimals or NOTHING — there is no
// default path, because the default is the bug.
async function readDecimals(lane, chain, host, address) {
  if (!address) return null;
  try {
    const response = await lane.http.json(`https://${host}`, {
      chain,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data: SELECTORS.decimals }, 'latest'] }),
    });
    // A JSON-RPC error arrives as HTTP 200 with an `error` member (the same
    // trap enrich.mjs:283-289 documents for its own calls).
    if (response?.data?.error) return null;
    const word = String(response?.data?.result ?? '').replace(/^0x/i, '');
    // A short word is "no data", not zero — same rule as enrich.mjs:115-118.
    if (word.length < 64) return null;
    return Number(BigInt(`0x${word.slice(0, 64)}`));
  } catch {
    return null;
  }
}

// Lane 3 — PublicNode reserves. The lane that actually closes the robinhood
// hole, and the only one with a trap big enough to need its own function.
async function publicNodeLane(chain, records, { lane, findings, recordCap }) {
  const availability = lane.availability(chain);
  if (!availability.ok) return;

  const candidates = records.filter(record =>
    record?.poolAddress
    && record.address
    && record.size?.fdv == null
    && record.size?.marketCap == null);
  if (candidates.length === 0) return;

  let processed = 0;
  for (const record of candidates) {
    if (processed >= recordCap) {
      findings.push(finding('warn', chain, 'enrich:publicnode',
        `publicnode row cap ${lane.budget.perRotationRowCap} allows ${recordCap} record(s) of ${candidates.length} this rotation; the rest stay unenriched`));
      break;
    }

    const tokenDecimals = await readDecimals(lane, chain, availability.host, record.address);
    const quoteAddress = record.quoteTokenAddress ?? null;
    const quoteDecimals = await readDecimals(lane, chain, availability.host, quoteAddress);
    if (tokenDecimals === null || quoteDecimals === null) {
      // Skip rather than assume. Assuming 18 is exactly the 10^12 error, and a
      // wrong FDV that looks like a real one survives every screen downstream.
      findings.push(finding('warn', chain, 'enrich:publicnode',
        `decimals_unknown for ${record.address} (token ${tokenDecimals === null ? 'unreadable' : tokenDecimals}, quote ${quoteDecimals === null ? 'unreadable' : quoteDecimals}); skipped rather than assumed 18`,
        { degraded: true }));
      processed += PUBLICNODE_CALLS_PER_RECORD;
      continue;
    }

    const overlay = await lane.overlay(chain, {
      address: record.address,
      pairAddress: record.poolAddress,
      decimals: tokenDecimals,
      quoteDecimals,
      // No quotePriceUsd here on purpose: the lane has no way to know it, and
      // the record's own price is the only evidence available. Passing null
      // gets the price primitive back and lets the derivation below be explicit
      // about what it used.
      quotePriceUsd: null,
    });
    processed += PUBLICNODE_CALLS_PER_RECORD;
    if (overlay.degraded && overlay.fdvUsd === null && overlay.liquidityUsd === null && overlay.supply === null) {
      findings.push(finding('warn', chain, 'enrich:publicnode', `publicnode measured nothing for ${record.address}: ${String(overlay.reason ?? 'unknown').slice(0, 140)}`, { degraded: true }));
      continue;
    }

    const derived = deriveUsdSizes(record, overlay);
    const patched = {
      ...overlay,
      fdvUsd: derived.fdvUsd,
      liquidityUsd: derived.liquidityUsd,
      basis: derived.fdvUsd === null && derived.liquidityUsd === null ? overlay.basis : ENRICHMENT_BASIS.RPC_RESERVES,
      reasons: [...(overlay.reasons ?? []), ...derived.reasons],
      reason: null,
      usdRequiresQuotePrice: derived.fdvUsd === null || derived.liquidityUsd === null,
    };
    const enriched = applySizeOverlay(record, patched);
    enriched.evidence = {
      ...(enriched.evidence ?? {}),
      enrichment: {
        ...(enriched.evidence?.enrichment ?? {}),
        rpcReserves: {
          token0: overlay.token0 ?? null,
          token1: overlay.token1 ?? null,
          tokenDecimals,
          quoteDecimals,
          quoteReserve: overlay.quoteReserve ?? null,
          pricePerTokenQuote: overlay.pricePerTokenQuote ?? null,
          quotePriceUsd: derived.quotePriceUsd,
        },
      },
    };
    Object.assign(record, enriched);
  }
}

// The USD derivation, written out rather than delegated because the algebra is
// the entire point and it should be checkable by eye.
//
//   quotePriceUsd = recordPrice / pricePerTokenQuote
//
//   fdvUsd        = quotePriceUsd * supply * pricePerTokenQuote
//                 = recordPrice * supply          <- the pool cancels out
//
//   liquidityUsd  = 2 * quoteReserve * quotePriceUsd
//
// The cancellation is worth stating out loud: FDV depends only on the token's own
// price and its supply. It does NOT need the pool at all, so it stays derivable
// even when the reserve side could not be resolved — a wider honest surface
// than refusing the whole record. Liquidity genuinely needs the pool, so it is
// the one that goes null when `pricePerTokenQuote` is absent.
function deriveUsdSizes(record, overlay) {
  const reasons = [];
  const priceUsd = recordPriceUsd(record);
  const supply = positive(overlay.supply);
  const pricePerTokenQuote = positive(overlay.pricePerTokenQuote);
  const quoteReserve = positive(overlay.quoteReserve);

  if (priceUsd === null) reasons.push('record_price_unavailable');
  if (supply === null) reasons.push('supply_unavailable');

  const fdvUsd = priceUsd !== null && supply !== null ? priceUsd * supply : null;
  if (fdvUsd === null) reasons.push('fdv_underivable');

  let liquidityUsd = null;
  let quotePriceUsd = null;
  if (priceUsd !== null && pricePerTokenQuote !== null) {
    quotePriceUsd = priceUsd / pricePerTokenQuote;
    liquidityUsd = quoteReserve === null ? null : 2 * quoteReserve * quotePriceUsd;
  } else {
    reasons.push(pricePerTokenQuote === null ? 'reserve_side_unknown' : 'quote_price_underivable');
  }
  if (liquidityUsd === null) reasons.push('liquidity_underivable');

  return { fdvUsd, liquidityUsd, quotePriceUsd, reasons };
}

// Lane 4 — Helius. Optional, solana-only, and structurally unable to invent a
// count: the lane returns holders:null on every path that did not read one.
async function heliusLane(chain, records, { lane, env, findings, recordCap }) {
  if (chain !== 'sol') return;
  if (!heliusAvailability(env).available) return;
  const candidates = records.filter(record => record?.holders == null && record.address);
  if (candidates.length === 0) return;

  let processed = 0;
  for (const record of candidates) {
    if (processed >= recordCap) break;
    const result = await lane.holders(chain, record.address);
    processed += 1;
    if (result.holders === null || result.holders === undefined) {
      findings.push(finding('warn', chain, 'enrich:helius', `helius read no holder count for ${record.address}: ${String(result.reason ?? 'unknown').slice(0, 140)}`, { degraded: true }));
      continue;
    }
    record.holders = result.holders;
    const prior = record.evidence?.enrichment ?? {};
    record.evidence = {
      ...(record.evidence ?? {}),
      enrichment: {
        ...prior,
        // topOwners is deliberately NOT stored as a count. `len(topOwners)` is 10
        // on every response and would read as a plausible holder total on a
        // 200k-holder token; top10Share is evidence, holders is the field.
        top10Share: result.top10Share ?? null,
      },
    };
  }
}

// The operator-facing hook that budget.mjs:376-382 promises exists: which shared
// entry is currently the binding constraint, so the helius rowCap of 1 becomes
// something an operator can see rather than a comment nobody re-reads.
export function budgetStopReason(budget, { rotationId = null, chain = null } = {}) {
  const snapshot = budget.snapshot?.();
  if (!snapshot) return null;
  const caps = snapshot.rowCaps ?? {};
  const cap = budget.perRotationRowCap;
  if (cap !== null && cap !== undefined) {
    const used = chain !== null ? (caps[chain] ?? 0) : Object.values(caps).reduce((sum, value) => sum + value, 0);
    if (used >= cap) {
      return `${budget.name} is at its per-rotation row cap (${used}/${cap}${chain === null ? ' across chains' : ` on ${chain}`}${rotationId === null ? '' : `, rotation ${rotationId}`}); raising SOURCE_BUDGETS.${budget.name.toLowerCase()}.perRotationRowCap is the only way to enrich more`;
    }
  }
  if (snapshot.breakerOpen) return `${budget.name} breaker is open; enrichment stays off until ${snapshot.cooldownMs}ms elapse`;
  if (snapshot.throttled) return `${budget.name} is cooling down for ${snapshot.cooldownMs}ms: ${snapshot.reason ?? 'no reason recorded'}`;
  return null;
}

// ---------------------------------------------------------------------------
// attachEnrichment
// ---------------------------------------------------------------------------

// `budgetOverrides` exists for tests and for nothing else. The shared spacing
// values are real (250 ms DexScreener, 400 ms PublicNode, 1 s Helius), so a
// suite that exercised three lanes through the real numbers would spend most of
// its runtime in setTimeout and its assertions would race a live clock. Passing
// `{ spacingMs: 0, sleep: async () => {} }` collapses the pacing to nothing
// WITHOUT touching the row caps or the breaker thresholds — those are the parts
// the lanes reason about, and they stay exactly as the shared table sets them.
export function attachEnrichment(discovery, {
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = () => Date.now(),
  budgetOverrides = {},
} = {}) {
  if (discovery === null || typeof discovery !== 'object') {
    throw new TypeError('attachEnrichment requires a discovery object');
  }
  if (typeof discovery.discover !== 'function') {
    throw new TypeError('attachEnrichment requires discovery.discover to be a function');
  }

  const options = key => budgetOverrides[key] ?? {};
  const dsBudget = createBudget('dexscreener', options('dexscreener'));
  const dsHttp = new IngestHttp({ budget: dsBudget, fetchImpl, timeoutMs: 8_000 });
  const paprikaBudget = createBudget('dexpaprika', options('dexpaprika'));
  const sizeBudget = createBudget('publicnode', options('publicnode'));
  const heliusBudget = createBudget('helius', options('helius'));

  // Constructed ONCE, not per discover() call: the DexPaprika lane's 2-hour
  // cadence cache lives on the instance, so a lane rebuilt each rotation would
  // re-ask every pool every rotation and burn a credit per call to learn nothing.
  const paprika = new DexPaprikaVolumeLane({ fetchImpl, budget: paprikaBudget, now });
  const size = new PublicNodeSizeLane({ fetchImpl, budget: sizeBudget });
  const helius = new HeliusHoldersLane({ fetchImpl, budget: heliusBudget, apiKey: env?.HELIUS_API_KEY ?? '' });

  const budgets = [dsBudget, paprikaBudget, sizeBudget, heliusBudget];
  const publicNodeRecordCap = Math.max(0, Math.floor((sizeBudget.perRotationRowCap ?? 0) / PUBLICNODE_CALLS_PER_RECORD));

  const wired = Object.create(discovery);

  wired.discover = async (chain, opts = {}) => {
    const result = await discovery.discover(chain, opts);
    const records = Array.isArray(result?.records) ? result.records : [];
    // Nothing to enrich is not a failure and must not become one. Returning the
    // coordinator's own object unchanged keeps observations and findings exactly
    // as it produced them.
    if (records.length === 0) return result;

    const rotationId = opts?.rotationId ?? null;
    // The coordinator resets ITS emitters' row caps inside its own discover()
    // (coordinator.mjs:65). These four budgets are not its emitters, so nobody
    // else will reset them: without this the first rotation's cap would hold
    // every rotation after it and lane 2/3 would go permanently silent.
    for (const budget of budgets) budget.beginRotation(rotationId);

    const findings = Array.isArray(result.findings) ? [...result.findings] : [];
    const mutable = records.filter(record => record && typeof record === 'object');

    try {
      await dexScreenerLane(chain, mutable, { http: dsHttp, findings });
    } catch (error) {
      findings.push(finding('error', chain, 'enrich:dexscreener', `dexscreener lane failed open: ${String(error?.message ?? error).slice(0, 160)}`));
    }
    try {
      await dexPaprikaLane(chain, mutable, { lane: paprika, findings });
    } catch (error) {
      findings.push(finding('error', chain, 'enrich:dexpaprika', `dexpaprika lane failed open: ${String(error?.message ?? error).slice(0, 160)}`));
    }
    try {
      await publicNodeLane(chain, mutable, { lane: size, findings, recordCap: publicNodeRecordCap });
    } catch (error) {
      findings.push(finding('error', chain, 'enrich:publicnode', `publicnode lane failed open: ${String(error?.message ?? error).slice(0, 160)}`));
    }
    try {
      await heliusLane(chain, mutable, { lane: helius, env, findings, recordCap: heliusBudget.perRotationRowCap ?? 0 });
    } catch (error) {
      findings.push(finding('error', chain, 'enrich:helius', `helius lane failed open: ${String(error?.message ?? error).slice(0, 160)}`));
    }

    return { ...result, findings };
  };

  // Intentionally NOT overridden: beginRotation, providers, snapshot and every
  // future member resolve through the prototype chain to the coordinator. The
  // cost of that choice is that a caller who invokes `beginRotation()` directly,
  // without a discover(), leaves these four budgets on the previous rotation's
  // counts. discover() resets them itself, which is the only path the scanner
  // takes.
  return wired;
}

export { DEX_CHAIN_IDS, PAPRIKA_NETWORKS, PUBLICNODE_CALLS_PER_RECORD };