// Routing for multi-chain ingest discovery: the scanner consumes its ACTIVE
// chain's rows every cycle and parks rows discovered for the other four, so
// "all chains discovered at the same time" never drops coverage for the chains
// whose AVE turn has not come yet.
//
// Why parking at all: AVE advances one chain per cycle (m00645-era cadence:
// ~8 min/cycle, full rotation ≈ 40 min). Without this, a GMGN row discovered
// for bsc during an eth cycle would be screened against eth's settings or
// discarded — coverage would still be one chain per rotation, which is exactly
// the coupling this build exists to remove.
//
// Freshness tradeoff, deliberate: parked rows live until their chain's turn
// (~40 min) but are capped at 60 min, because the rotation itself is ~40 min —
// a TTL below the rotation would starve the last chain of every park. The
// non-AVE discoveryScreen gates on POOL age (creation_timestamp), not capture
// age, and every parked row was already enriched before parking, so a 40-min
// park trades at most a stale price for a whole chain of coverage. Rows are
// REPLACED (newest wins) each rotation, so a row is only ever stale if every
// emitter failed for two consecutive rotations.

import { normalizeTokenAddress } from '../address.mjs';

// Parity with scanner.mjs addressKey: EVM addresses are case-insensitive,
// solana base58 is case-sensitive — lowercasing globally would merge two
// distinct mints in the park.
function dedupeKey(chain, address) {
  const normalized = normalizeTokenAddress(chain, address) ?? String(address ?? '');
  return `${chain}:${/^0x[0-9a-fA-F]{40}$/.test(normalized) ? normalized.toLowerCase() : normalized}`;
}

function freshAt(row, now) {
  const capturedAt = Number(row?.capturedAt);
  return Number.isFinite(capturedAt) && capturedAt > 0 ? now - capturedAt : 0;
}

/**
 * Partition discovered rows by chain, park the foreign ones, and hand back the
 * active chain's rows: FRESH rows first (the caller's dedupe keeps the first
 * occurrence, so fresh always beats parked), then still-valid parked rows the
 * emitters did not just re-deliver.
 *
 * Side effects are confined to `park` (a plain Map the caller owns — tests
 * pass their own). Returns the rows to feed this cycle's screen.
 *
 * @param {Map<string, object[]>} park  chain -> parked rows (owned by caller)
 * @param {object[]} rows  this rotation's rows, all chains
 * @param {string} activeChain  the chain whose AVE cycle this is
 * @param {{now?: number, ttlMs?: number, capPerChain?: number}} [options]
 * @returns {object[]} fresh-active rows followed by valid parked rows
 */
export function routeIngestRows(park, rows, activeChain, {
  now = Date.now(),
  // 60 min > the ~40 min full rotation: a shorter TTL starves the last chain
  // of the park, which is the entire point of parking. See header.
  ttlMs = 60 * 60_000,
  capPerChain = 100,
} = {}) {
  const fresh = [];
  const seen = new Set();
  const incoming = Array.isArray(rows) ? rows : [];

  for (const row of incoming) {
    if (!row || typeof row !== 'object' || !row.chain) continue;
    const key = dedupeKey(row.chain, row.address);
    if (row.chain === activeChain) {
      if (!seen.has(key)) {
        seen.add(key);
        fresh.push(row);
      }
      continue;
    }
    // Newest wins per address: a re-discovered foreign row replaces its parked
    // predecessor instead of queueing duplicates behind it.
    const list = (park.get(row.chain) ?? []).filter(parked => dedupeKey(row.chain, parked.address) !== key);
    list.push(row);
    park.set(row.chain, list);
  }

  // Prune foreign chains: TTL first, then cap keeping the newest tail (rows
  // arrive in feed order, newest last).
  for (const [chain, list] of park) {
    if (chain === activeChain) continue;
    const kept = list
      .filter(row => freshAt(row, now) <= ttlMs)
      .slice(-capPerChain);
    if (kept.length === 0) park.delete(chain);
    else park.set(chain, kept);
  }

  const parkedForActive = (park.get(activeChain) ?? [])
    .filter(row => {
      const key = dedupeKey(activeChain, row.address);
      return !seen.has(key);
    });
  // Consumed: the active chain's park must not survive its own cycle — these
  // rows are now this cycle's `ingestRows` and will be re-parked next
  // rotation by the emitters if still of interest.
  park.delete(activeChain);

  return [...fresh, ...parkedForActive];
}
