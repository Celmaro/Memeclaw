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
  gmgn: 'GMGN',
  pumpfun: 'PUMPFUN',
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
    // 24h volume rides on evidence (GMGN/DexPaprika measure it and nothing
    // finer); the screen scores first(volume_1h, volume, volume_24h), so
    // omitting this key would silently zero every non-GT row's volume term.
    volume_24h: record.evidence?.volume24hUsd ?? null,
    // Measured risk, value-by-value. The OMIT-if-null rule is the three-state
    // contract itself: discoveryScreen treats a PRESENT-but-unreadable key as
    // a rejection (数据未知) and an ABSENT key as unknown evidence for deep
    // audit. Bridging a null as a key would turn every thin GMGN row into a
    // hard reject; bridging only measured values lets a fresh token's real
    // bundler/insider/honeypot numbers gate it on evidence for the first time.
    ...(record.risk && typeof record.risk === 'object'
      ? {
        ...(record.risk.rugRatio !== null && record.risk.rugRatio !== undefined ? { rug_ratio: record.risk.rugRatio } : {}),
        ...(record.risk.bundlerRate !== null && record.risk.bundlerRate !== undefined ? { bundler_rate: record.risk.bundlerRate } : {}),
        ...(record.risk.insiderRate !== null && record.risk.insiderRate !== undefined ? { rat_trader_amount_rate: record.risk.insiderRate } : {}),
        ...(record.risk.washTrading !== null && record.risk.washTrading !== undefined ? { is_wash_trading: record.risk.washTrading } : {}),
        ...(record.risk.isHoneypot !== null && record.risk.isHoneypot !== undefined ? { is_honeypot: record.risk.isHoneypot } : {}),
      }
      : {}),
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
