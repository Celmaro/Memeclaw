// pump.fun front-end API — a keyless, chronological Solana launch feed.
//
// Nobody proposed this source; it surfaced during the adversarial verification
// lane as the honest partial substitute for GMGN, whose sol launch feed turned
// out to be unbuildable (hard Cloudflare 403 on every route including its own
// /chains/sol/pools, and api.gmgn.ai does not resolve).
//
// Probed behaviour that this adapter must respect:
//   * `coins?sort=created_timestamp&order=DESC` -> 200, ~10 KB, no key.
//   * The very first probe returned HTTP 429 with
//     {"statusCode":429,"message":"Rate limit exceeded. Please slow down.",
//      "retryAfterMs":57}. So this source is NOT unthrottled: it throttles
//     aggressively and advertises its own cooldown in the BODY, not a header.
//     budget.report() catches the status; this adapter additionally honours
//     retryAfterMs because it is the only source in the set that supplies one.
//
// Solana launch feeds are also the one place where risk data is guaranteed
// missing: measured across 6 fresh candidates, 3 returned 0 security fields and
// 2 returned 8 stub fields. Records from here therefore carry
// risk.status === 'unknown' and stay unpublished until a risk supplier exists.
// Publishing them as safe is the exact failure this layer must not ship.

import { createRecord, RISK_STATUS } from '../record.mjs';

const HOST = 'https://frontend-api-v3.pump.fun';

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function epochSec(value) {
  if (value === null || value === undefined || value === '') return null;
  // pump.fun returns created_timestamp in milliseconds.
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed > 1e11 ? parsed / 1000 : parsed;
  const byDate = Date.parse(String(value));
  return Number.isFinite(byDate) ? byDate / 1000 : null;
}

function marketCapOf(coin) {
  if (coin.market_cap !== null && coin.market_cap !== undefined) return num(coin.market_cap);
  if (coin.usd_market_cap !== null && coin.usd_market_cap !== undefined) return num(coin.usd_market_cap);
  return null;
}

export function parseCoin(coin, { capturedAtSec = Date.now() / 1000 } = {}) {
  if (!coin || typeof coin !== 'object' || typeof coin.mint !== 'string') return null;
  const record = createRecord({
    chain: 'sol',
    address: coin.mint,
    source: 'pumpfun',
    pairCreatedAtSec: epochSec(coin.created_timestamp),
    fdvUsd: null,
    marketCapUsd: marketCapOf(coin),
    liquidityUsd: null,
    volume5mUsd: null,
    volume1hUsd: null,
    symbol: typeof coin.symbol === 'string' && coin.symbol !== '' ? coin.symbol : null,
    name: typeof coin.name === 'string' && coin.name !== '' ? coin.name : null,
    sourceUrl: `https://pump.fun/${coin.mint}`,
    capturedAtSec,
    // No pool is created at listing time on pump.fun; virtual reserves stand in
    // for the pool that will exist. Recorded as the caveat rather than smoothed
    // over, because a screen reading `liquidityUsd` needs to know it is virtual.
    evidence: {
      raydiumPool: coin.raydium_pool ?? null,
      complete: coin.complete === true,
      virtualSolReserves: coin.virtual_sol_reserves ?? null,
      realSolReserves: coin.real_sol_reserves ?? null,
      bondingCurve: coin.bonding_curve ?? null,
      replyCount: num(coin.reply_count),
    },
  });
  if (record === null) return null;
  record.risk = { status: RISK_STATUS.UNKNOWN, isHoneypot: null, notes: ['no free source characterises contract risk on a launch-time sol token'] };
  record.unresolved = ['security', 'holders', 'liquidityReal', 'buyVolume5mUsd', 'sellVolume5mUsd'];
  return record;
}

export class PumpFunAdapter {
  constructor({ http, budget = null, limit = 50, chain = 'sol' } = {}) {
    this.http = http;
    this.budget = budget;
    this.limit = limit;
    this.chain = chain;
  }

  availability() {
    return { ok: true, reason: 'keyless chronological sol launch feed; throttles fast and supplies retryAfterMs in the body' };
  }

  url() {
    return `${HOST}/coins?sort=created_timestamp&order=DESC&limit=${this.limit}&offset=0`;
  }

  async fetchNewTokens({ capturedAtSec = Date.now() / 1000, out = [] } = {}) {
    let response;
    try {
      response = await this.http.json(this.url(), { chain: this.chain });
    } catch (error) {
      out.push({
        level: error.throttled ? 'throttled' : 'error',
        chain: this.chain,
        source: this.budget?.name ?? 'pumpfun',
        reason: `launch feed failed: ${error.message}`,
      });
      return [];
    }
    const body = response.data;
    const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    const records = rows.map(coin => parseCoin(coin, { capturedAtSec })).filter(Boolean);
    out.push({
      level: 'info',
      chain: this.chain,
      source: this.budget?.name ?? 'pumpfun',
      reason: `${records.length}/${rows.length} launches parsed, ${response.data?.latencyMs ?? 0}ms`,
      detail: { allRiskUnknown: records.length > 0 },
    });
    return records;
  }
}