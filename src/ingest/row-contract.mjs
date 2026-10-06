// The one-directional bridge from ingest records (capability-first: a field is
// a value or an explicit unresolved marker) to the bot's snake_case discovery
// row vocabulary that discoveryScreen reads. Ingest rows ENTER the original
// screen; nothing here ever rewrites an AVE row.
//
// Load-bearing contracts:
//   * creation_timestamp is SECONDS (record.pairCreatedAtSec): the non-AVE
//     discoveryScreen computes ageSec = nowSec - created.
//   * market_cap carries only a MEASURED market cap. FDV rides fdv_usd and the
//     screen substitutes it with a labelled basis (record.mjs philosophy:
//     collapsing FDV into marketCap hides the very label that makes the band
//     test honest — robinhood reports market_cap_usd null on 0/20 fresh GT
//     pools while fdv_usd is populated).
//   * security fields are ABSENT, not false. The screen reports them in
//     unknownFields; the security gate fires later, at deep audit (GoPlus /
//     riskExclusions), exactly as it does for AVE rows.
//   * marketProvider names the introducing source, so provenance survives the
//     merge and the scanner's provider filter can widen deliberately.

export const INGEST_DISCOVERY_PROVIDERS = Object.freeze(['GECKOTERMINAL']);

const SOURCE_PROVIDERS = Object.freeze({
  geckoterminal: 'GECKOTERMINAL',
  dexscreener: 'DEXSCREENER',
  dexpaprika: 'DEXPAPRIKA',
  // Promoted emission hints (existence-oracle verified) arrive as source
  // 'logs'/'profiles' and map to the ONE tag toCoordinatorEmitter() registers
  // in the coordinator's providers set. The scanner's allowedDiscoveryRow
  // therefore admits them only when the MEMECLAW_EMISSION gate was open;
  // `ingestSource` below keeps the true origin for provenance.
  logs: 'EMISSION',
  profiles: 'EMISSION',
});

function providerForSource(source) {
  return SOURCE_PROVIDERS[String(source ?? '').toLowerCase()] ?? String(source ?? 'INGEST').toUpperCase();
}

function ms(seconds) {
  return seconds === null || seconds === undefined || !Number.isFinite(seconds) ? null : Math.round(seconds * 1000);
}

export function toDiscoveryRow(record, { marketProvider = null } = {}) {
  if (!record?.chain || !record?.address) return null;
  return {
    address: record.address,
    chain: record.chain,
    symbol: record.symbol || record.address.slice(0, 6),
    name: record.name || record.symbol || '',
    price: record.price ?? null,
    market_cap: record.size?.marketCap ?? null,
    fdv_usd: record.size?.fdv ?? null,
    liquidity: record.liquidityUsd ?? null,
    creation_timestamp: record.pairCreatedAtSec ?? null,
    volume_1h: record.activity?.volume1hUsd ?? null,
    volume_5m: record.activity?.volume5mUsd ?? null,
    // USD and count flow in the AVE row vocabulary so the P3 signal layer
    // reads ingest rows with the same aliases it reads AVE trending rows.
    // Absent stays null — a missing buy/sell split must degrade the read,
    // never fabricate balance.
    buy_volume_5m: record.activity?.buyVolume5mUsd ?? null,
    sell_volume_5m: record.activity?.sellVolume5mUsd ?? null,
    buys_5m: record.activity?.txns5m?.buys ?? null,
    sells_5m: record.activity?.txns5m?.sells ?? null,
    holder_count: record.holders ?? null,
    marketProvider: marketProvider || providerForSource(record.source),
    ingestSource: record.source ?? null,
    ingestStale: record.stale === true,
    poolAddress: record.poolAddress ?? null,
    ageSec: record.ageSec ?? null,
    capturedAt: ms(record.capturedAtSec),
    sourceUpdatedAt: ms(record.capturedAtSec),
    // Capability provenance travels with the row so downstream evidence views
    // can say "security never fetched by this source" instead of "no risk".
    ingestUnresolved: Array.isArray(record.unresolved) ? [...record.unresolved] : [],
  };
}
