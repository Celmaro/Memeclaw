// GMGN openapi trenches — a keyed NEW-LAUNCH feed covering all five chains.
//
// This is the feed the whole research programme was looking for: launch-time
// rows that carry measured contract risk on tokens seconds old, the exact
// fields the discovery screen hard-requires and GoPlus cannot supply (measured:
// a 40-min-old robinhood token returns 8 stub fields from GoPlus, 3 of 6 fresh
// sol candidates returned 0). Every contract fact below was live-probed, not
// read from docs:
//
//   * Request: POST /v1/trenches?chain=<c>&timestamp=<unix s>&client_id=<fresh
//     UUID>, header `X-APIKEY`, body {version:'v2', new_creation:{filters:
//     ['offchain','onchain'], launchpad_platform_v2:true, limit, quote_address_type
//     per chain}}. The per-chain quote_address_type lists come from the vendor's
//     own client (GMGN_QUOTE_ADDRESS_TYPES in chain-map.mjs) — the wrong list
//     silently filters the feed to the wrong quote assets.
//   * client_id MUST be a fresh UUID per request: reuse inside 7s returns
//     AUTH_CLIENT_ID_REPLAYED. timestamp is valid ±5s.
//   * Envelope {code, data, message, reason}; rows live under
//     data.new_creation (defensively also new_creation). Measured robinhood:
//     200, 190,625 B, 60 rows, 844 ms.
//   * Free tier: leaky bucket 5/5 per IP, trenches weight 2 → 2-call burst;
//     429 carries x-ratelimit-reset and NO Retry-After, and each retry DURING
//     cooldown extends a temporary IP ban. So: budget pacing in
//     SOURCE_BUDGETS.gmgn, and this adapter never retries — a throttle becomes
//     one finding and the rotation moves on.
//   * Row schema (verbatim keys): address, created_timestamp (epoch SECONDS),
//     market_cap, liquidity, price, holder_count, symbol, name, pool_address,
//     volume_24h, buys_24h, sells_24h, swaps_24h, is_honeypot ("yes"/"no"
//     STRING), is_wash_trading (bool), bundler_trader_amount_rate,
//     rat_trader_amount_rate, suspected_insider_hold_rate, buy_tax / sell_tax
//     (0..1 ratios, e.g. 0.0899), burn_status, owner_renounced, open_source,
//     creator_created_count, top_10_holder_rate, twitter, telegram, website,
//     x_user_follower. NO rug_ratio on trenches rows — it stays absent, which
//     the screen reports as unknown evidence rather than inventing.
//
// Risk posture: the adapter reports measurements and never a verdict.
// status is ADVERSE only when a measured value crosses the screen's documented
// threshold, otherwise UNKNOWN — never CLEAN. `clean` would be this adapter
// declaring a token safe, and record.mjs exists to stop exactly that.

import crypto from 'node:crypto';
import { createRecord, createRisk, RISK_STATUS } from '../record.mjs';
import { createBudget } from '../budget.mjs';
import { IngestHttp } from '../http.mjs';
import { GMGN_QUOTE_ADDRESS_TYPES } from '../chain-map.mjs';

const HOST = 'https://openapi.gmgn.ai';

// Adverse thresholds mirror discoveryScreen's documented cuts (scoring.mjs
// non-AVE branch): bundler / insider > 0.30 rejects, honeypot or wash rejects.
const ADVERSE_RATE = 0.30;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function epochSec(value) {
  const parsed = num(value);
  if (parsed === null) return null;
  // GMGN measured in epoch seconds (10 digits); accept ms defensively so a
  // unit change upstream cannot age a token by 1000x.
  return parsed > 1e11 ? Math.round(parsed / 1000) : Math.round(parsed);
}

/**
 * Parse one trenches row into a record + measured risk. Pure, no network.
 * @param {object} row  raw trenches row (schema above)
 * @param {{chain?: string, capturedAtSec?: number}} [options]
 * @returns {object|null} record, or null when the row cannot be trusted
 */
export function parseTrenchRow(row, { chain = null, capturedAtSec = Date.now() / 1000 } = {}) {
  if (!row || typeof row !== 'object') return null;
  const address = str(row.address);
  if (address === null) return null;
  const rowChain = str(row.chain) ?? chain;
  if (rowChain === null) return null;

  const record = createRecord({
    chain: rowChain,
    address,
    source: 'gmgn',
    poolAddress: str(row.pool_address),
    pairCreatedAtSec: epochSec(row.created_timestamp),
    priceUsd: num(row.price),
    // GMGN names this field market_cap, so it is recorded as a measured market
    // cap (same rule as pump.fun's market_cap): the record never renames a
    // source's own cap into FDV or the reverse. fdv stays null — GMGN trenches
    // rows do not carry one, and sizeIsFdvOnly stays false because both
    // statements are what the source actually said.
    marketCapUsd: num(row.market_cap),
    liquidityUsd: num(row.liquidity),
    holders: num(row.holder_count),
    symbol: str(row.symbol),
    name: str(row.name),
    sourceUrl: `https://gmgn.ai/${rowChain}/token/${address}`,
    capturedAtSec,
    evidence: {
      volume24hUsd: num(row.volume_24h),
      buys24h: num(row.buys_24h),
      sells24h: num(row.sells_24h),
      swaps24h: num(row.swaps_24h),
      top10HolderRate: num(row.top_10_holder_rate),
      burnStatus: str(row.burn_status),
      ownerRenounced: row.owner_renounced === true || row.owner_renounced === false ? row.owner_renounced : null,
      openSource: row.open_source === true || row.open_source === false ? row.open_source : null,
      creatorCreatedCount: num(row.creator_created_count),
      socials: {
        twitter: str(row.twitter) ?? str(row.twitter_handle),
        telegram: str(row.telegram),
        website: str(row.website),
      },
      xUserFollower: num(row.x_user_follower),
      launchpad: str(row.launchpad),
      creationTool: str(row.creation_tool),
    },
  });
  if (record === null) return null;

  // boolOrNull inside createRisk accepts "yes"/"no"/1/0/true/false — the
  // measured string form lands as a real boolean, and an absent field stays
  // null so row-contract omits the key entirely (present-but-null would make
  // the screen reject as 数据未知 instead of reporting unknown evidence).
  const isHoneypot = row.is_honeypot === undefined ? null : row.is_honeypot;
  const bundlerRate = row.bundler_trader_amount_rate === undefined ? null : row.bundler_trader_amount_rate;
  const insiderRate = row.rat_trader_amount_rate ?? row.suspected_insider_hold_rate ?? null;
  const washTrading = row.is_wash_trading === undefined ? null : row.is_wash_trading;

  const risk = {
    isHoneypot,
    buyTax: row.buy_tax ?? null,
    sellTax: row.sell_tax ?? null,
    bundlerRate,
    insiderRate,
    washTrading,
    rugRatio: row.rug_ratio ?? null,
  };
  const measured = Object.values(risk).filter(value => value !== null && value !== undefined).length;
  const adverse = risk.isHoneypot === true || risk.isHoneypot === 'yes'
    || risk.washTrading === true
    || (typeof risk.bundlerRate === 'number' && risk.bundlerRate > ADVERSE_RATE)
    || (typeof risk.insiderRate === 'number' && risk.insiderRate > ADVERSE_RATE);

  const unresolved = [];
  if (record.size.marketCap === null) unresolved.push('marketCap');
  if (record.liquidityUsd === null) unresolved.push('liquidityUsd');
  if (measured === 0) unresolved.push('security');
  if (record.holders === null) unresolved.push('holders');

  return {
    ...createRisk(record, {
      status: adverse ? RISK_STATUS.ADVERSE : RISK_STATUS.UNKNOWN,
      ...risk,
      fieldsPresent: measured,
      source: 'gmgn',
      notes: [],
    }),
    unresolved,
  };
}

/**
 * Coordinator-shaped emitter. `enabled()` is false without a key or for a
 * chain outside the measured quote map — a silent skip, not a finding, so an
 * unkeyed deployment does not spam the event log every rotation.
 */
export function createGmgnEmitter({
  fetchImpl = globalThis.fetch,
  http = null,
  budget = null,
  apiKey = process.env.GMGN_API_KEY,
} = {}) {
  const key = String(apiKey ?? '').trim();
  const budgetRef = budget ?? createBudget('gmgn');
  const client = http ?? new IngestHttp({ budget: budgetRef, fetchImpl, timeoutMs: 15_000 });

  return {
    id: 'gmgn',
    provider: 'GMGN',
    budget: budgetRef,

    enabled(chain) {
      return key !== '' && Object.hasOwn(GMGN_QUOTE_ADDRESS_TYPES, chain);
    },

    async discover(chain, { out = [] } = {}) {
      const quote = GMGN_QUOTE_ADDRESS_TYPES[chain];
      const query = new URLSearchParams({
        chain,
        timestamp: String(Math.floor(Date.now() / 1000)),
        // Fresh per request — replaying inside 7s is an auth error.
        client_id: crypto.randomUUID(),
      });
      const body = {
        version: 'v2',
        new_creation: {
          filters: ['offchain', 'onchain'],
          launchpad_platform_v2: true,
          limit: 50,
          quote_address_type: [...quote],
        },
      };
      let response;
      try {
        response = await client.json(`${HOST}/v1/trenches?${query.toString()}`, {
          method: 'POST',
          chain,
          headers: { 'X-APIKEY': key, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        // Throttled becomes a warn finding and the budget cools down; anything
        // else is an error finding. Neither retries: a retry during a GMGN
        // cooldown extends the IP ban, which is how a rotation becomes a ban.
        out.push({
          level: error?.throttled ? 'warn' : 'error',
          chain,
          source: 'gmgn',
          throttled: error?.throttled === true,
          reason: `gmgn trenches ${error?.throttled ? 'throttled' : 'failed'}: ${String(error?.message ?? error).slice(0, 160)}`,
        });
        return [];
      }

      const payload = response?.data;
      const rows = Array.isArray(payload?.data?.new_creation) ? payload.data.new_creation
        : Array.isArray(payload?.new_creation) ? payload.new_creation
          : Array.isArray(payload?.data) ? payload.data
            : [];
      if (rows.length === 0) {
        out.push({
          level: 'warn',
          chain,
          source: 'gmgn',
          reason: `gmgn trenches returned no new_creation rows (code ${payload?.code ?? 'n/a'}${payload?.message ? `: ${payload.message}` : ''})`,
        });
        return [];
      }
      const capturedAtSec = Date.now() / 1000;
      const records = rows.map(row => parseTrenchRow(row, { chain, capturedAtSec })).filter(Boolean);
      out.push({
        level: 'info',
        chain,
        source: 'gmgn',
        reason: `${records.length}/${rows.length} new_creation rows parsed, ${response.latencyMs ?? 0}ms`,
        detail: { riskMeasured: records.filter(record => (record.risk?.fieldsPresent ?? 0) > 0).length },
      });
      return records;
    },
  };
}
