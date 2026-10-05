// The one record shape every source normalises onto.
//
// This is deliberately NOT the bot's internal row shape. The bot's screen reads
// a snake_case live-feed vocabulary (row.market_cap, row.is_honeypot,
// row.creation_timestamp) and cannot represent "we looked and it was absent"
// distinctly from a "never looked at all" state. This record can: every capability is
// either a value or an explicit unresolved marker, so a downstream screen can
// treat unknown as unknown instead of as safe.

import { normalizeTokenAddress } from '../address.mjs';

// Measured across providers (live probes, 2026-10):
//   GeckoTerminal market_cap_usd  robinhood 0/20, base 0/20, bsc 0/40,
//                                 eth 19/20, sol structurally absent
//   DexScreener marketCap         populated on fresh base (10073) and robinhood
//                                 (1404572) pools where GT returns null
// Therefore size is carried on BOTH fields and never copied between them.
// Representing FDV as marketCap would let a 3% float token pass a screen that
// is meant to be about tradable size; collapsing them is how the FDV hole gets
// hidden instead of labelled.
export function createRecord({
  chain,
  address,
  source,
  poolAddress = null,
  pairCreatedAtSec = null,
  priceUsd = null,
  fdvUsd = null,
  marketCapUsd = null,
  liquidityUsd = null,
  volume5mUsd = null,
  volume1hUsd = null,
  buyVolume5mUsd = null,
  sellVolume5mUsd = null,
  txns5m = null,
  holders = null,
  symbol = null,
  name = null,
  sourceUrl = null,
  capturedAtSec = Date.now() / 1000,
  stale = false,
  evidence = {},
} = {}) {
  const normalized = normalizeTokenAddress(chain, address);
  if (normalized === null) return null;
  return {
    schemaVersion: 1,
    chain,
    address: normalized,
    poolAddress,
    source,
    sourceUrl,
    symbol,
    name,
    // Both size fields survive independently. `sizeIsFdvOnly` is the flag the
    // UI reads to say "FDV only, float unknown" rather than silently implying
    // the band test was run against market cap.
    size: { fdv: finiteOrNull(fdvUsd), marketCap: finiteOrNull(marketCapUsd) },
    sizeIsFdvOnly: finiteOrNull(fdvUsd) !== null && finiteOrNull(marketCapUsd) === null,
    liquidityUsd: finiteOrNull(liquidityUsd),
    activity: {
      volume5mUsd: finiteOrNull(volume5mUsd),
      volume1hUsd: finiteOrNull(volume1hUsd),
      buyVolume5mUsd: finiteOrNull(buyVolume5mUsd),
      sellVolume5mUsd: finiteOrNull(sellVolume5mUsd),
      txns5m: countOrNull(txns5m),
    },
    holders: countOrNull(holders),
    // ISO timestamp the PAIR was created, not the token. The screen gates on
    // pool age because a token can be old while its pool is minutes old, and
    // it is the pool that carries the liquidity.
    pairCreatedAtSec: pairCreatedAtSec,
    ageSec: pairCreatedAtSec === null ? null : Math.max(0, capturedAtSec - pairCreatedAtSec),
    // Spot price when the source reports one (GT new_pools carries price_usd).
    // Kept separate from size: price is a quote, size is a supply statement.
    price: finiteOrNull(priceUsd),
    capturedAtSec,
    stale,
    // Named capabilities this source did NOT supply. Recorded as evidence
    // provenance, never as absence of risk.
    unresolved: [],
    evidence,
  };
}

// Coarse buckets, not pass/fail. An adapter must never decide that a token is
// safe; it reports what it measured, and a screen decides.
export const RISK_STATUS = Object.freeze({
  UNKNOWN: 'unknown',
  CLEAN: 'clean',
  ADVERSE: 'adverse',
});

export function createRisk(record, {
  status = RISK_STATUS.UNKNOWN,
  isHoneypot = null,
  buyTax = null,
  sellTax = null,
  ownerPrivileges = null,
  lpLocked = null,
  rugRatio = null,
  bundlerRate = null,
  insiderRate = null,
  washTrading = null,
  fieldsPresent = 0,
  source = null,
  notes = [],
} = {}) {
  return {
    ...record,
    risk: {
      status,
      isHoneypot: boolOrNull(isHoneypot),
      buyTax: rateOrNull(buyTax),
      sellTax: rateOrNull(sellTax),
      ownerPrivileges: Array.isArray(ownerPrivileges) ? [...ownerPrivileges] : null,
      lpLocked: lpLocked === true || lpLocked === false ? lpLocked : null,
      rugRatio: rateOrNull(rugRatio),
      bundlerRate: rateOrNull(bundlerRate),
      insiderRate: rateOrNull(insiderRate),
      washTrading: boolOrNull(washTrading),
      fieldsPresent,
      source,
      // Thin responses are the normal case for young tokens, not an error. This
      // is recorded so the record can be held and retried instead of published.
      notes,
    },
  };
}

function finiteOrNull(value) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function rateOrNull(value) {
  let parsed = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (trimmed.endsWith('%')) {
      const percent = Number(trimmed.slice(0, -1));
      return Number.isFinite(percent) ? percent / 100 : null;
    }
    parsed = Number(trimmed);
  }
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return null;
  if (parsed > 1) return parsed > 100 ? null : parsed / 100;
  return parsed >= 0 ? parsed : null;
}

function boolOrNull(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return null;
}

function countOrNull(value) {
  const parsed = finiteOrNull(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

// Merge multi-source evidence for one address. Values never overwrite each
// other silently: a disagreement is preserved as a conflict for the operator,
// because on a launch-time candidate the most informative field is often how
// badly the two providers disagree.
export function mergeRecords(records) {
  const usable = records.filter(record => record && record.chain && record.address);
  if (usable.length === 0) return null;
  const byAddress = new Map();
  for (const record of usable) {
    const key = `${record.chain}:${record.address}`;
    const existing = byAddress.get(key);
    byAddress.set(key, existing ? mergeTwo(existing, record) : record);
  }
  return [...byAddress.values()];
}

function mergeTwo(a, b) {
  const [older, newer] = a.capturedAtSec <= b.capturedAtSec ? [a, b] : [b, a];
  const conflicts = [];
  const size = {
    fdv: newer.size.fdv ?? older.size.fdv,
    marketCap: newer.size.marketCap ?? older.size.marketCap,
  };
  for (const field of ['fdv', 'marketCap']) {
    const left = older.size[field];
    const right = newer.size[field];
    if (left !== null && right !== null && left > 0) {
      const relativeDifference = Math.abs(left - right) / Math.max(left, right);
      if (relativeDifference > 0.25) conflicts.push({ field, primary: right, secondary: left, relativeDifference });
    }
  }
  return {
    ...newer,
    size,
    sizeIsFdvOnly: size.fdv !== null && size.marketCap === null,
    // `...newer` carries newer's nulls over the older record's real values, so
    // every scalar the newer source did not supply has to be restored
    // explicitly. A field absent from this list is silently lost on merge.
    poolAddress: newer.poolAddress ?? older.poolAddress,
    pairCreatedAtSec: newer.pairCreatedAtSec ?? older.pairCreatedAtSec,
    ageSec: newer.ageSec ?? older.ageSec,
    liquidityUsd: newer.liquidityUsd ?? older.liquidityUsd,
    symbol: newer.symbol ?? older.symbol,
    name: newer.name ?? older.name,
    capturedAtSec: newer.capturedAtSec,
    stale: newer.stale || older.stale,
    activity: {
      ...older.activity,
      volume5mUsd: newer.activity.volume5mUsd ?? older.activity.volume5mUsd,
      volume1hUsd: newer.activity.volume1hUsd ?? older.activity.volume1hUsd,
      buyVolume5mUsd: newer.activity.buyVolume5mUsd ?? older.activity.buyVolume5mUsd,
      sellVolume5mUsd: newer.activity.sellVolume5mUsd ?? older.activity.sellVolume5mUsd,
      txns5m: newer.activity.txns5m ?? older.activity.txns5m,
    },
    holders: newer.holders ?? older.holders,
    risk: newer.risk ?? older.risk ?? null,
    unresolved: [...new Set([...(older.unresolved ?? []), ...(newer.unresolved ?? [])])],
    evidence: { ...(older.evidence ?? {}), ...(newer.evidence ?? {}) },
    conflicts,
    conflictsNote: conflicts.length > 0
      ? `sources disagree on ${conflicts.map(entry => entry.field).join(', ')}`
      : null,
  };
}