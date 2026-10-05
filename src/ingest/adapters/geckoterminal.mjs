// GeckoTerminal `new_pools` — the only free chronological new-pool feed that
// was verified live on base, bsc and robinhood.
//
// Why this source is not optional: it is the only emission lane on three of the
// five chains, it covers all five without a key or a credit pool, and it is the
// source whose pools carry `fdv_usd` where `market_cap_usd` is null on every
// fresh pool. Its weaknesses are all handled here rather than downstream.
//
// Measured caveats this adapter encodes:
//   * `attributes.address` is the POOL address. `scoring.mjs:290` validates the
//     TOKEN address, so reading that field fails validation on a large share of
//     rows. The token is `relationships.base_token.data.id` with the network
//     slug stripped.
//   * `market_cap_usd` is null on fresh pools (robinhood 0/20, base 0/20, bsc
//     0/40) and `scoring.mjs:294` reads only `row.market_cap` with no FDV
//     fallback anywhere. FDV is therefore carried on its own field here and the
//     substitution is left to the screen, which knows its band.
//   * Page 1 was measured at 59-227 s pool age against `config.minAgeSec: 300`,
//     so every row on it is rejected for age regardless of quality. startPage
//     defaults to 2 to avoid spending a whole page on guaranteed rejects; it is
//     a parameter, not a hardcoded truth, because the screen's age floor is not
//     this layer's to know.
//   * `x-rack-cache: stale` is surfaced as `stale`, never silently accepted.
//   * `transactions.m5.buys/sells` are COUNTS, not USD. DexPaprika is the only
//     source in the set that reports the buy/sell USD split, so those stay null
//     rather than being invented from counts.

import { createRecord } from '../record.mjs';
import { GECKO_NETWORKS, geckoIdChain, stripGeckoPrefix } from '../chain-map.mjs';

const HOST = 'https://api.geckoterminal.com';

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoToSec(value) {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

// `reserve_in_usd` is the pool's TVL. Measured "0.0" on live rows, so a literal
// zero is treated as unreported rather than as an empty pool.
function liquidityFrom(value) {
  const parsed = num(value);
  return parsed === null || parsed <= 0 ? null : parsed;
}

export function parsePool(chain, pool, { capturedAtSec = Date.now() / 1000, stale = false } = {}) {
  if (!pool || typeof pool !== 'object') return null;
  const attributes = pool.attributes ?? {};
  const baseTokenId = pool.relationships?.base_token?.data?.id ?? null;
  if (!baseTokenId) return null;

  // A cross-network leak would attribute a token to the wrong chain. GT prefixes
  // every id with the network slug, so this is cheap to verify.
  const slug = geckoIdChain(baseTokenId);
  const expected = GECKO_NETWORKS[chain];
  if (slug && expected && slug !== expected) return null;

  const tokenAddress = stripGeckoPrefix(baseTokenId);
  const txns5m = attributes.transactions?.m5 ?? null;
  const record = createRecord({
    chain,
    address: tokenAddress,
    source: 'geckoterminal',
    poolAddress: typeof attributes.address === 'string' ? attributes.address.toLowerCase() : null,
    pairCreatedAtSec: isoToSec(attributes.pool_created_at),
    fdvUsd: num(attributes.fdv_usd),
    marketCapUsd: num(attributes.market_cap_usd),
    liquidityUsd: liquidityFrom(attributes.reserve_in_usd),
    volume5mUsd: num(attributes.volume_usd?.m5),
    volume1hUsd: num(attributes.volume_usd?.h1),
    txns5m: txns5m && Number.isFinite(Number(txns5m.buys)) ? Number(txns5m.buys) + Number(txns5m.sells) : null,
    symbol: poolNameSymbol(attributes.name),
    sourceUrl: `https://www.geckoterminal.com/${chain}/pools/${attributes.address ?? ''}`,
    capturedAtSec,
    stale,
    evidence: {
      dex: pool.relationships?.dex?.data?.id ?? null,
      poolName: attributes.name ?? null,
      // Counts only. Recorded so a consumer can see the shape exists and that
      // the USD split was NOT derivable from it.
      txns5m: txns5m ? { buys: num(txns5m.buys), sells: num(txns5m.sells) } : null,
      priceChange: attributes.price_change_percentage ?? null,
    },
  });
  if (record === null) return null;
  record.unresolved = [
    ...(record.size.marketCap === null ? ['marketCap'] : []),
    ...(record.activity.buyVolume5mUsd === null ? ['buyVolume5mUsd', 'sellVolume5mUsd'] : []),
    'security',
    'holders',
  ];
  record.quoteTokenAddress = stripGeckoPrefix(pool.relationships?.quote_token?.data?.id ?? '') || null;
  return record;
}

// "MEOWFI / WETH 0.3%" -> "MEOWFI". The name is the only symbol GT carries on a
// pool row, and the token endpoint 404s on fresh tokens.
function poolNameSymbol(name) {
  if (typeof name !== 'string') return null;
  const [head] = name.split('/');
  const trimmed = (head ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

export class GeckoTerminalAdapter {
  constructor({ http, budget = null, startPage = 2, pages = 1, network = null } = {}) {
    this.http = http;
    this.budget = budget;
    // Not a hardcoded truth about the provider: it is where this layer chooses
    // to start given the consuming screen's current 300 s age floor.
    this.startPage = Math.max(1, startPage);
    this.pages = Math.max(1, pages);
    this.networkOverride = network;
  }

  availability() {
    return { ok: true, reason: 'keyless on all five chains; robinhood omitted from /networks but the slug serves' };
  }

  url(chain, page) {
    const network = this.networkOverride ?? GECKO_NETWORKS[chain];
    if (!network) return null;
    return `${HOST}/api/v2/networks/${network}/new_pools?page=${page}`;
  }

  // `out` collects operator-facing findings: conditions that make a source look
  // silent when it is actually misconfigured or misread.
  async fetchNewPools(chain, { capturedAtSec = Date.now() / 1000, out = [] } = {}) {
    const url = this.url(chain, this.startPage);
    if (url === null) {
      out.push({ level: 'error', chain, source: this.budget?.name ?? 'geckoterminal', reason: `no GeckoTerminal network slug for ${chain}` });
      return [];
    }
    let response;
    try {
      response = await this.http.json(url, { chain });
    } catch (error) {
      out.push({
        level: error.throttled ? 'throttled' : 'error',
        chain,
        source: this.budget?.name ?? 'geckoterminal',
        reason: `new_pools failed: ${error.message}`,
      });
      return [];
    }

    const rows = Array.isArray(response.data?.data) ? response.data.data : [];
    const records = [];
    let skippedWrongNetwork = 0;
    let skippedInvalidAddress = 0;
    for (const pool of rows) {
      const record = parsePool(chain, pool, { capturedAtSec, stale: response.data?.rackCache === 'stale' });
      if (record === null) {
        skippedWrongNetwork += 1;
        skippedInvalidAddress += 1;
        continue;
      }
      records.push(record);
    }
    out.push({
      level: 'info',
      chain,
      source: this.budget?.name ?? 'geckoterminal',
      reason: `page ${this.startPage}: ${records.length}/${rows.length} usable, ${rows.length - records.length} unusable, ${response.data?.latencyMs ?? 0}ms`,
      detail: { skippedWrongNetwork, skippedInvalidAddress, rackCache: response.data?.rackCache ?? null },
    });
    if (response.data?.rackCache === 'stale') {
      out.push({
        level: 'warn',
        chain,
        source: this.budget?.name ?? 'geckoterminal',
        reason: 'x-rack-cache: stale — pools may predate this cycle and are marked stale, not treated as fresh',
      });
    }
    return records;
  }
}