// P2 enrichment: an OVERLAY on rows we already know about, never a second
// discovery lane.
//
// WHAT THIS FILE IS FOR
// ---------------------
// Measured hole (docs/ARCHITECTURE-FULL-PIPELINE.md §4.3, and the live probes
// quoted in record.mjs:12-20): `market_cap_usd` is null on 20/20 fresh robinhood
// GeckoTerminal pools, so on that chain the size band test has nothing to read
// and every candidate is discarded as "missing_market". DexScreener carries a
// populated `marketCap`/`fdvUsd` on exactly those pools. PublicNode can derive
// FDV and TVL from `totalSupply()` + `getReserves()` with no key on all four EVM
// chains. This module supplies both, plus DexPaprika's real 1h volume (the
// reason that feed exists upstream), plus an optional solana holder lane.
//
// THE FOUR RULES THIS FILE ENFORCES
// ---------------------------------
//  1. FAIL OPEN, NEVER THROW INTO THE FUNNEL. A screen that receives a rejected
//     enrichment keeps its original row; a screen that receives a fabricated one
//     loses its reason for rejecting. Every lane returns a plain object whose
//     `degraded: true` and `reason` say what was not measured.
//  2. ABSENT IS NOT ZERO. `getReserves()` returning nothing, `totalSupply()`
//     returning an empty word, or a missing `quotePriceUsd` yield null values
//     plus a reason. A `0` here would read as "this token is worthless", which
//     is a claim about the market and not a measurement.
//  3. NO CLOCK OR BUCKET IS SHARED WITH AVE. This module never imports
//     `ave.mjs`, never touches the shared provider throttle, and takes its own
//     `SourceBudget` per provider. A single PublicNode hiccup must not be able
//     to push AVE into its 8-minute strike floor and stall all five chains
//     (budget.mjs:1-8).
//  4. NO RISK VERDICT IS EVER FORMED HERE. `isHoneypot` / `buyTax` / `sellTax`
//     are not produced, not defaulted, not inferred from ownership shape. GoPlus
//     remains the honeypot authority and must still fail closed to `null` on
//     robinhood; this module cannot change that in either direction.
//
// UNITS
// -----
// Everything on-chain is a raw integer in the token's own decimals. Nothing here
// assumes 18: solana mints are 6/9, USDC is 6, and a wrong decimals assumption
// is a factor-of-10^12 error that still looks like a plausible dollar figure.
// Every divide goes through `units()` with an explicit decimals argument.

import { createBudget } from './budget.mjs';
import { IngestHttp, HttpError } from './http.mjs';
import { PUBLICNODE_RPC, rpcUrlFor } from './adapters/rpc-risk.mjs';
import { CHAIN_META } from './chain-map.mjs';

// Why the value was produced. `none` means nothing was measured — it is a real
// result, not an absence of one, and the caller must be able to tell them apart.
export const ENRICHMENT_BASIS = Object.freeze({
  RPC_RESERVES: 'rpc-reserves',
  DEXSCREENER: 'dexscreener',
  DEXPAPRIKA: 'dexpaprika',
  HELIUS: 'helius',
  NONE: 'none',
});

// Function selectors. Verified constants, not documentation: `totalSupply()`
// and `getReserves()` are in the ERC-20 / Uniswap-V2-pair ABIs, `token0()` /
// `token1()` are the first four bytes of the keccak of their signatures.
const SELECTORS = Object.freeze({
  totalSupply: '0x18160ddd',
  getReserves: '0x0902f1ac',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
});

// DexPaprika 1h volume changes on an hourly cadence and costs one credit per
// cache miss out of a rolling-30-day pool (budget.mjs:13). Re-asking inside two
// hours cannot return a different number and burns a credit to learn that.
export const DEXPAPRIKA_1H_CADENCE_MS = 2 * 60 * 60 * 1000;

const HELIUS_RPC_HOST = 'mainnet.helius-rpc.com';

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

// An eth_call that returns an EMPTY word is the node answering "no data" —
// `totalSupply()` on a non-contract returns `0x`, which is not the same as a
// 32-byte zero. Collapsing the two would turn "this token has no supply()" into
// "this token has zero supply" and mark a perfectly ordinary token as degraded
// for the wrong reason. So: empty -> null (unreadable), 32 zero bytes -> 0n
// (readable, and a genuine problem the caller must be told about).
function hexToBigInt(value) {
  if (typeof value !== 'string') return null;
  const body = value.trim().replace(/^0x/i, '');
  if (body === '' || !/^[0-9a-f]+$/i.test(body)) return null;
  try {
    return BigInt(`0x${body}`);
  } catch {
    return null;
  }
}

function isPositiveBigInt(value) {
  return typeof value === 'bigint' && value > 0n;
}

function units(raw, decimals) {
  if (!isPositiveBigInt(raw)) return null;
  const scale = 10n ** BigInt(Math.max(0, Math.min(36, Math.floor(decimals) || 0)));
  const whole = raw / scale;
  const fraction = raw % scale;
  // Number() on a >2^53 integer silently loses precision; FDV values here are
  // far below that, so the split keeps the integer part exact and the remainder
  // is pure display precision.
  return Number(whole) + Number(fraction) / Number(scale);
}

function positiveNumber(value) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function lastWord(raw) {
  if (typeof raw !== 'string') return null;
  const body = raw.replace(/^0x/i, '');
  if (body.length < 64) return null;
  return `0x${body.slice(-64)}`;
}

function addressFromWord(raw) {
  const word = lastWord(raw);
  return word === null ? null : `0x${word.replace(/^0x/i, '').slice(-40).toLowerCase()}`;
}

// getReserves() returns three 32-byte words: reserve0, reserve1,
// blockTimestampLast. Taking only the first two is not a shortcut — it is the
// contract, and reading 96 bytes as one number is how a pool ends up with a
// liquidity figure 2^256 times too large.
function parseReserves(raw) {
  const body = String(raw ?? '').replace(/^0x/i, '');
  if (body.length < 128) return { reserve0: null, reserve1: null, error: 'short_reserves_word' };
  return {
    reserve0: hexToBigInt(`0x${body.slice(0, 64)}`),
    reserve1: hexToBigInt(`0x${body.slice(64, 128)}`),
    error: null,
  };
}

// ---------------------------------------------------------------------------
// 1. Size overlay — the pure math, separated from every network call
// ---------------------------------------------------------------------------

// THE FORMULA, spelled out so it can be checked by hand and by test.
//
//   reserveToken = reserveTokenRaw / 10^decimals
//   reserveQuote = reserveQuoteRaw / 10^quoteDecimals
//
//   pricePerTokenQuote = reserveQuote / reserveToken        (constant product,
//                                                            swap fee ignored:
//                                                            it shifts the price
//                                                            a few percent and
//                                                            nothing more)
//   liquidityQuote    = reserveQuote        (the quote side of the pair)
//   liquidityUsd      = 2 * reserveQuote * quotePriceUsd
//                       (both sides of a constant-product pool are worth the
//                        same, so TVL is twice ONE side, not one side)
//
//   lpShare  = reserveToken / supply     (fraction of the float held as liquidity)
//   fdvUsd   = reserveQuote * quotePriceUsd / lpShare
//            = quotePriceUsd * supply * pricePerTokenQuote
//
// The second form is the LP-share form: it is the same number written the way
// a Uniswap-v2 UI writes it, and it is why the division must use the SUPPLY and
// not the reserve on one side. A token with 3% of its supply in the pool has an
// FDV about 33x its pool value; reading `reserveQuote` alone as its size would
// under-report every freshly launched token by that factor.
//
// FDV, never market cap. Reserves know how much supply EXISTS, not how much of
// it is float. record.mjs:16-20 and row-contract.mjs:12-16 both exist to stop
// that substitution, so this function never writes a `marketCapUsd` it inferred
// from supply: an input marketCapUsd is passed through untouched or stays null.
//
// `quotePriceUsd` is REQUIRED for any USD figure. A chain-native quote asset has
// no USD price in these reserves, and assuming $1 for it is exactly the kind of
// assumption that produces a confidently wrong FDV on a pool quoted in ETH.
export function computeSizeOverlay({
  totalSupplyRaw = null,
  reserveTokenRaw = null,
  reserveQuoteRaw = null,
  decimals = 18,
  quoteDecimals = 18,
  quotePriceUsd = null,
  tokenIsReserve0 = null,
  fdvUsd = null,
  marketCapUsd = null,
  liquidityUsd = null,
  basis = ENRICHMENT_BASIS.NONE,
} = {}) {
  const reasons = [];
  const supplyToken = units(totalSupplyRaw, decimals);
  const supplyNative = units(totalSupplyRaw, 0);
  const reserveToken = units(reserveTokenRaw, decimals);
  const reserveQuote = units(reserveQuoteRaw, quoteDecimals);
  const quotePrice = positiveNumber(quotePriceUsd);

  const supplyZero = typeof totalSupplyRaw === 'bigint' && totalSupplyRaw === 0n;
  if (supplyZero) reasons.push('zero_supply');
  if (supplyToken === null && !supplyZero) reasons.push('supply_unavailable');
  if (reserveToken === null) reasons.push('token_reserve_unavailable');
  if (reserveQuote === null) reasons.push('quote_reserve_unavailable');
  if (quotePrice === null) reasons.push('quote_price_unavailable');
  if (tokenIsReserve0 === null) reasons.push('reserve_side_unknown');

  // Constant-product price in QUOTE units. Usable without any USD price, so a
  // caller still gets the primitive it needs to price the token itself.
  let pricePerTokenQuote = null;
  if (reserveToken !== null && reserveQuote !== null && reserveToken > 0) {
    pricePerTokenQuote = reserveQuote / reserveToken;
  }

  let computedFdv = null;
  let computedLiquidity = null;
  if (pricePerTokenQuote !== null && quotePrice !== null && supplyToken !== null && supplyToken > 0) {
    computedFdv = quotePrice * supplyToken * pricePerTokenQuote;
    computedLiquidity = 2 * reserveQuote * quotePrice;
  }

  // A figure the caller already measured WINS over our arithmetic. A provider
  // value outranks a derivation on every axis: it is the observation, ours is
  // the inference, and overwriting the observation with the inference is how
  // evidence quietly becomes a guess. The basis label keeps the two apart for
  // whoever reads the record later.
  const fdv = positiveNumber(fdvUsd) ?? computedFdv;
  const liquidity = positiveNumber(liquidityUsd) ?? computedLiquidity;
  const marketCap = positiveNumber(marketCapUsd);
  const produced = computedFdv !== null || computedLiquidity !== null || fdv !== null || liquidity !== null;

  return {
    fdvUsd: fdv,
    // Never derived. Carried only so a caller can see whether one was known.
    marketCapUsd: marketCap,
    liquidityUsd: liquidity,
    supply: supplyToken ?? supplyNative ?? null,
    pricePerTokenQuote,
    quoteReserve: reserveQuote,
    basis: produced ? basis : ENRICHMENT_BASIS.NONE,
    // `degraded` means "this overlay is incomplete", never "the token is bad".
    degraded: reasons.length > 0,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// 2. PublicNode size lane (FDV / TVL from on-chain reserves)
// ---------------------------------------------------------------------------

// The key never appears in a URL we echo. `IngestHttp` puts the request URL on
// its HttpError, and an error string containing the key ends up in `out[]`,
// logs, and the status endpoint. This is the single choke point that keeps it
// out.
function redactKey(text, apiKey) {
  if (typeof text !== 'string' || typeof apiKey !== 'string' || apiKey === '') return text;
  return text.split(apiKey).join('[redacted]');
}

export class PublicNodeSizeLane {
  constructor({ fetchImpl = globalThis.fetch, http = null, budget = null, timeoutMs = 12_000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    // The bucket identity is the HOST, never the chain: PublicNode's limits are
    // per endpoint and one shared bucket is what keeps a five-chain rotation
    // inside the ceiling instead of multiplying it by five.
    this.budget = budget ?? createBudget('publicnode');
    this.http = http ?? new IngestHttp({ budget: this.budget, fetchImpl, timeoutMs });
  }

  availability(chain) {
    const url = rpcUrlFor(chain);
    if (url === null) {
      return {
        ok: false,
        chain,
        reason: `no public RPC endpoint for ${chain}; reserves-derived size is EVM-only and cannot serve solana`,
      };
    }
    return { ok: true, chain, host: new URL(url).host };
  }

  #rpc(url, method, params, chain) {
    // JSON-RPC errors arrive as HTTP 200 with an `error` member, so status
    // alone is not success — treating it as success is how a probe ends up
    // reporting "supply is 0" for a token it simply failed to reach
    // (rpc-risk.mjs:79-81).
    return this.http.json(url, {
      chain,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).then(result => {
      const data = result?.data;
      if (data && typeof data === 'object' && data.error) {
        const error = new Error(`rpc_${data.error.code}`);
        error.rpcCode = data.error.code;
        throw error;
      }
      return { result: data?.result, latencyMs: result?.latencyMs ?? 0 };
    });
  }

  // Which reserve holds the token. Read from the pair rather than assumed,
  // because assuming turns every token into a pool whose price is inverted and
  // whose FDV is wrong by (quote/token)^2.
  async #resolveReserveSide(url, chain, tokenAddress, pairAddress) {
    const [zero, one] = await Promise.all([
      this.#rpc(url, 'eth_call', [{ to: pairAddress, data: SELECTORS.token0 }, 'latest'], chain).catch(() => null),
      this.#rpc(url, 'eth_call', [{ to: pairAddress, data: SELECTORS.token1 }, 'latest'], chain).catch(() => null),
    ]);
    const token0 = addressFromWord(zero?.result);
    const token1 = addressFromWord(one?.result);
    const wanted = String(tokenAddress ?? '').toLowerCase();
    if (token0 === wanted && token1 !== null) return { tokenIsReserve0: true, token0, token1 };
    if (token1 === wanted && token0 !== null) return { tokenIsReserve0: false, token0, token1 };
    return { tokenIsReserve0: null, token0, token1 };
  }

  // `pairAddress` is required: reserves are a property of a POOL, and there is
  // no way to reconstruct a price from a token contract alone.
  async overlay(chain, { address, pairAddress, decimals = 18, quoteDecimals = decimals, quotePriceUsd = null } = {}) {
    const availability = this.availability(chain);
    if (!availability.ok) {
      return { ...computeSizeOverlay({ basis: ENRICHMENT_BASIS.NONE }), chain, address, degraded: true, reason: availability.reason };
    }
    if (!pairAddress) {
      return {
        ...computeSizeOverlay({ basis: ENRICHMENT_BASIS.NONE }),
        chain,
        address,
        degraded: true,
        reason: 'pair_address_required: reserves are a pool property; a token contract alone carries no price',
      };
    }
    const url = rpcUrlFor(chain);
    const safe = { chain, address };

    let supply;
    let reserves;
    let side;
    try {
      [supply, reserves, side] = await Promise.all([
        this.#rpc(url, 'eth_call', [{ to: address, data: SELECTORS.totalSupply }, 'latest'], chain),
        this.#rpc(url, 'eth_call', [{ to: pairAddress, data: SELECTORS.getReserves }, 'latest'], chain),
        this.#resolveReserveSide(url, chain, address, pairAddress),
      ]);
    } catch (error) {
      if (error?.throttled || error?.detail === 'row_cap') {
        return { ...computeSizeOverlay({ basis: ENRICHMENT_BASIS.NONE }), ...safe, degraded: true, reason: `budget_stopped: ${redactKey(error.message, '')}` };
      }
      return { ...computeSizeOverlay({ basis: ENRICHMENT_BASIS.NONE }), ...safe, degraded: true, reason: `rpc_failed: ${redactKey(String(error?.message ?? error), '')}` };
    }

    const parsed = parseReserves(reserves?.result);
    const tokenReserve = side.tokenIsReserve0 === false ? parsed.reserve1 : parsed.reserve0;
    const quoteReserve = side.tokenIsReserve0 === false ? parsed.reserve0 : parsed.reserve1;

    const overlay = computeSizeOverlay({
      totalSupplyRaw: hexToBigInt(supply?.result),
      reserveTokenRaw: tokenReserve,
      reserveQuoteRaw: quoteReserve,
      decimals,
      quoteDecimals,
      quotePriceUsd,
      tokenIsReserve0: side.tokenIsReserve0,
      basis: ENRICHMENT_BASIS.RPC_RESERVES,
    });

    return {
      ...overlay,
      ...safe,
      pairAddress,
      token0: side.token0,
      token1: side.token1,
      reason: overlay.degraded ? overlay.reasons.join(',') : null,
      // The USD question is decided by the caller, never here: only the caller
      // knows the quote asset's USD price, and guessing it is the single easiest
      // way to ship a confidently wrong FDV.
      usdRequiresQuotePrice: overlay.fdvUsd === null || overlay.liquidityUsd === null,
    };
  }
}

// ---------------------------------------------------------------------------
// 3. DexScreener overlay — pure, because the call already exists
// ---------------------------------------------------------------------------

// `/tokens/v1/{chain}/{30 addrs}` needs 30 addresses per request, which is why
// the P2 wiring should reuse one DexScreener batch for the whole rotation
// rather than calling per row. This function is deliberately PURE: given a
// batch response and one address, return that address's overlay. The budget
// entry is `dexscreener` (250ms, 20/2s) and no new call pattern is introduced.
//
// `marketCap` and `fdv` stay separate fields. When a source reports only `fdv`,
// the result is `sizeIsFdvOnly: true` downstream — the same label
// record.mjs:56-59 exists to force.
export function overlayFromDexScreenerBatch(payload, address, { liquidityFrom = 'usd' } = {}) {
  const wanted = String(address ?? '').toLowerCase();
  const empty = {
    fdvUsd: null,
    marketCapUsd: null,
    liquidityUsd: null,
    pairAddress: null,
    dexId: null,
    basis: ENRICHMENT_BASIS.NONE,
    degraded: true,
    reasons: [],
  };
  const pairs = Array.isArray(payload) ? payload : Array.isArray(payload?.pairs) ? payload.pairs : null;
  if (pairs === null) return { ...empty, reasons: ['batch_payload_unrecognised'] };

  const match = pairs.find(entry => {
    const base = String(entry?.baseToken?.address ?? '').toLowerCase();
    const quote = String(entry?.quoteToken?.address ?? '').toLowerCase();
    return base === wanted || quote === wanted;
  });
  if (!match) return { ...empty, reasons: ['address_not_in_batch'] };

  const fdvUsd = positiveNumber(match.fdv);
  const marketCapUsd = positiveNumber(match.marketCap);
  const liquidityUsd = liquidityFrom === 'quote'
    ? positiveNumber(match.liquidity?.quote)
    : positiveNumber(match.liquidity?.usd);

  const reasons = [];
  if (fdvUsd === null && marketCapUsd === null) reasons.push('size_absent');
  if (liquidityUsd === null) reasons.push('liquidity_absent');

  return {
    fdvUsd,
    marketCapUsd,
    liquidityUsd,
    pairAddress: typeof match.pairAddress === 'string' ? match.pairAddress : null,
    dexId: match.dexId ?? null,
    basis: fdvUsd === null && marketCapUsd === null && liquidityUsd === null ? ENRICHMENT_BASIS.NONE : ENRICHMENT_BASIS.DEXSCREENER,
    // Partial is still useful: an FDV with no TVL closes half the robinhood hole.
    degraded: reasons.length > 0,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// 4. DexPaprika 1h volume lane
// ---------------------------------------------------------------------------

export class DexPaprikaVolumeLane {
  constructor({
    fetchImpl = globalThis.fetch,
    http = null,
    budget = null,
    now = () => Date.now(),
    cadenceMs = DEXPAPRIKA_1H_CADENCE_MS,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cadenceMs = Math.max(0, cadenceMs);
    this.budget = budget ?? createBudget('dexpaprika');
    this.http = http ?? new IngestHttp({ budget: this.budget, fetchImpl });
    this.cache = new Map();
  }

  availability() {
    const snapshot = this.budget.snapshot();
    return {
      ok: !snapshot.throttled,
      source: 'dexpaprika',
      creditsRemaining: this.#creditsRemaining(),
      reason: snapshot.throttled ? `budget says stop: ${snapshot.reason ?? 'throttled'}` : 'keyless; 1h volume is the reason this feed exists',
    };
  }

  // `x-credits-remaining` is the 30-day cache-miss pool. It is the actually
  // scarce resource — the per-minute counter can read "8 of 10" while the pool
  // that will strand the source sits at 0 (budget.mjs:262-285).
  #creditsRemaining() {
    const raw = this.budget.snapshot().quota?.creditRemaining;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  #cacheKey(chain, { poolId, address }) {
    return `${chain}:${poolId ?? String(address ?? '').toLowerCase()}`;
  }

  #refuse(key, reason) {
    const cached = this.cache.get(key) ?? null;
    return {
      volume1hUsd: cached?.volume1hUsd ?? null,
      volume24hUsd: cached?.volume24hUsd ?? null,
      basis: cached ? ENRICHMENT_BASIS.DEXPAPRIKA : ENRICHMENT_BASIS.NONE,
      cadenceGuard: cached ? 'cached' : 'no_cache',
      networkCalls: 0,
      creditsRemaining: this.#creditsRemaining(),
      degraded: true,
      reason,
    };
  }

  // Refuses rather than waits. A blocked source that sleeps holds the rotation;
  // the whole point of a credit-aware lane is that the rotation keeps its
  // cadence and the row simply carries no 1h volume this cycle.
  async volume1h(chain, { poolId = null, address = null } = {}) {
    const key = this.#cacheKey(chain, { poolId, address });
    const cached = this.cache.get(key) ?? null;
    const age = cached === null ? null : this.now() - cached.at;
    if (cached !== null && age !== null && age < this.cadenceMs) {
      return {
        ...cached,
        cadenceGuard: 'within_cadence',
        networkCalls: 0,
        creditsRemaining: this.#creditsRemaining(),
        degraded: false,
        reason: null,
      };
    }
    if (poolId === null && address === null) {
      return this.#refuse(key, 'pool_id_or_address_required');
    }

    const availability = this.availability();
    // #refuse already labels the provenance of whatever number it returns:
    // `cached` when a real measurement is being re-served, `no_cache` when
    // there is nothing. Overwriting that label here would strip the only
    // signal the caller has that the figure is stale.
    if (!availability.ok) return this.#refuse(key, availability.reason);
    const credits = this.#creditsRemaining();
    if (credits !== null && credits <= 0) {
      return this.#refuse(key, 'credit_pool_exhausted: x-credits-remaining is 0; a cache miss now costs a credit we do not have');
    }

    const url = poolId !== null
      ? `https://api.dexpaprika.com/networks/${chain}/pools/${poolId}`
      : `https://api.dexpaprika.com/networks/${chain}/tokens/${address}`;
    let response;
    try {
      response = await this.http.json(url, { chain });
    } catch (error) {
      const throttled = error instanceof HttpError ? error.throttled : false;
      return {
        ...this.#refuse(key, `${throttled ? 'throttled' : 'failed'}: ${String(error?.message ?? error).slice(0, 160)}`),
        cadenceGuard: 'attempted',
      };
    }

    const payload = response.data;
    const volume1hUsd = positiveNumber(payload?.volume_usd_1h);
    const volume24hUsd = positiveNumber(payload?.volume_usd_24h);
    const entry = {
      volume1hUsd,
      volume24hUsd,
      poolId: poolId ?? payload?.pools?.[0]?.pair_id ?? null,
      at: this.now(),
    };
    if (volume1hUsd === null && volume24hUsd === null) {
      return { ...this.#refuse(key, 'no_volume_field: provider answered without a volume figure'), cadenceGuard: 'attempted' };
    }
    this.cache.set(key, entry);
    return {
      ...entry,
      basis: ENRICHMENT_BASIS.DEXPAPRIKA,
      cadenceGuard: 'fetched',
      networkCalls: 1,
      creditsRemaining: this.#creditsRemaining(),
      degraded: volume1hUsd === null,
      reason: volume1hUsd === null ? 'no_1h_volume: only a 24h figure was available' : null,
    };
  }
}

// ---------------------------------------------------------------------------
// 5. Helius holders lane — optional, solana-only, never fabricated
// ---------------------------------------------------------------------------

// WHY SOLANA ONLY, AND WHY THAT IS NOT A GAP TO BE FILLED HERE
// ----------------------------------------------------------
// Helius is a Solana data company: DAS `getAsset` reads a mint account, which
// has no EVM equivalent. It cannot serve eth, bsc, base or robinhood, and no
// amount of configuration makes it try. On those four chains the holder count
// stays null and the reason says so. Guessing "holders unknown ~= safe" is the
// exact failure rpc-risk.mjs:14-22 exists to prevent, so this lane has no
// fallback path at all.

export function heliusAvailability(env = process.env) {
  const key = typeof env?.HELIUS_API_KEY === 'string' ? env.HELIUS_API_KEY.trim() : '';
  if (key === '') {
    return {
      available: false,
      chain: 'sol',
      reason: 'HELIUS_API_KEY is not set: the holders lane is optional and reports available:false rather than inventing a count',
    };
  }
  return { available: true, chain: 'sol', host: HELIUS_RPC_HOST, reason: 'keyed solana DAS; cannot serve EVM chains' };
}

export class HeliusHoldersLane {
  constructor({ fetchImpl = globalThis.fetch, http = null, budget = null, apiKey = process.env.HELIUS_API_KEY ?? '', timeoutMs = 12_000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.apiKey = String(apiKey ?? '').trim();
    this.budget = budget ?? createBudget('helius');
    this.http = http ?? new IngestHttp({ budget: this.budget, fetchImpl, timeoutMs });
  }

  availability(env = process.env) {
    if (this.apiKey !== '') return { available: true, chain: 'sol', reason: 'keyed solana DAS' };
    return heliusAvailability(env);
  }

  // `holders` is null unless the provider states a count. A top-owner list is a
  // concentration signal, not a holder count, and reporting len(topOwners) as
  // holders would understate a 200k-holder token by four orders of magnitude
  // while looking like a real number.
  async holders(chain, mintAddress, { topOwnerLimit = 10 } = {}) {
    const unavailable = (reason) => ({
      available: false,
      chain,
      holders: null,
      topOwners: null,
      top10Share: null,
      supply: null,
      degraded: true,
      networkCalls: 0,
      reason,
    });

    const availability = this.availability();
    if (!availability.available) return unavailable(availability.reason);
    if (chain !== 'sol') {
      return unavailable(`helius_is_solana_only: ${chain} is EVM; holder count stays null and must not be inferred`);
    }
    if (!mintAddress) return unavailable('mint_address_required');

    const url = `https://${HELIUS_RPC_HOST}/?api-key=${encodeURIComponent(this.apiKey)}`;
    let response;
    try {
      response = await this.http.json(url, {
        chain,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAsset',
          params: { id: mintAddress, displayOptions: { showNativeBalance: false } },
        }),
      });
    } catch (error) {
      // The URL carries the key, so the message is redacted before it can
      // reach `out[]` and the status endpoint.
      return unavailable(`helius_failed: ${redactKey(String(error?.message ?? error), this.apiKey).slice(0, 160)}`);
    }

    const asset = response.data?.result ?? null;
    const declared = asset?.token_info?.holders_count ?? asset?.token_info?.holdersCount ?? null;
    const holders = typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
    const rawOwners = Array.isArray(asset?.top_owners ?? asset?.ownership?.top_owners) ? (asset.top_owners ?? asset.ownership.top_owners) : null;
    const supply = positiveNumber(asset?.token_info?.supply);

    let topOwners = null;
    let top10Share = null;
    if (rawOwners !== null) {
      topOwners = rawOwners.slice(0, Math.max(1, topOwnerLimit)).map(owner => ({
        address: typeof owner.address === 'string' ? owner.address : null,
        uiAmount: positiveNumber(owner.uiAmount ?? owner.ui_amount ?? owner.amount),
        pct: positiveNumber(owner.pct),
      }));
      // Concentration is computable from the list alone when the provider
      // gives percentages. When it gives raw amounts the share needs a supply
      // the response may not carry, and a wrong denominator is worse than none.
      if (supply !== null && topOwners.length > 0 && topOwners.every(owner => owner.uiAmount !== null)) {
        top10Share = topOwners.reduce((sum, owner) => sum + owner.uiAmount, 0) / supply;
      }
    }

    const degraded = holders === null;
    return {
      available: true,
      chain,
      holders,
      topOwners,
      top10Share,
      supply,
      degraded,
      networkCalls: 1,
      reason: degraded ? 'holder_count_unavailable: DAS returned no holders count; top owners are a concentration signal, not a count' : null,
    };
  }
}

// ---------------------------------------------------------------------------
// 6. Applying an overlay to a record
// ---------------------------------------------------------------------------

// Fills ONLY the gaps. A field the record already carries is left exactly as it
// was: a measured provider value outranks derived arithmetic, and re-deriving it
// would silently replace evidence with a guess. Nothing here touches
// `unresolved` security entries or any risk field.
export function applySizeOverlay(record, overlay) {
  if (!record || typeof record !== 'object') return record;
  const size = {
    fdv: record.size?.fdv ?? positiveNumber(overlay?.fdvUsd),
    marketCap: record.size?.marketCap ?? positiveNumber(overlay?.marketCapUsd),
  };
  const liquidityUsd = record.liquidityUsd ?? positiveNumber(overlay?.liquidityUsd);
  return {
    ...record,
    size,
    sizeIsFdvOnly: size.fdv !== null && size.marketCap === null,
    liquidityUsd,
    unresolved: Array.isArray(record.unresolved)
      ? record.unresolved.filter(capability => {
        if (capability === 'marketCap' && size.marketCap !== null) return false;
        if (capability === 'fdv' && size.fdv !== null) return false;
        if (capability === 'liquidityUsd' && liquidityUsd !== null) return false;
        return true;
      })
      : record.unresolved,
    evidence: {
      ...(record.evidence ?? {}),
      enrichment: {
        basis: overlay?.basis ?? ENRICHMENT_BASIS.NONE,
        degraded: overlay?.degraded !== false,
        reasons: overlay?.reasons ?? (overlay?.reason ? [overlay.reason] : []),
      },
    },
  };
}

export { CHAIN_META };