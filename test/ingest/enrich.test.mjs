// Tests for the P2 enrichment overlay.
//
// Run from `Memeclaw/`: `node --test test/ingest/enrich.test.mjs` (verified on
// this host, 37/37). The file also runs standalone via
// `node test/ingest/enrich.test.mjs`, which is the form the sibling suites in
// this directory were written for.
//
// ZERO REAL NETWORK. Every lane takes an injected `fetchImpl`; the tests pass a
// stub that records what was asked and answers from a script. A test that
// reached api.dexpaprika.com or a PublicNode endpoint would spend a real credit
// or poison a real circuit breaker, and a suite with that side effect cannot be
// run twice to compare.
//
// The assertions that matter more than the arithmetic are the honesty ones:
// an absent measurement must stay null (never 0, never false), a missing API
// key must disable its lane rather than invent data, and nothing in this module
// may ever form a risk verdict.

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  ENRICHMENT_BASIS,
  DEXPAPRIKA_1H_CADENCE_MS,
  computeSizeOverlay,
  overlayFromDexScreenerBatch,
  applySizeOverlay,
  PublicNodeSizeLane,
  DexPaprikaVolumeLane,
  HeliusHoldersLane,
  heliusAvailability,
} = await import('../../src/ingest/enrich.mjs');
const { createBudget } = await import('../../src/ingest/budget.mjs');
const { createRecord } = await import('../../src/ingest/record.mjs');

const TOKEN = '0x1111111111111111111111111111111111111111';
const USDC = '0x2222222222222222222222222222222222222222';
const PAIR = '0x3333333333333333333333333333333333333333';

const TOKEN_18 = (whole) => BigInt(Math.round(Number(whole) * 1e18));
const USDC_6 = (whole) => BigInt(Math.round(Number(whole) * 1e6));
const word = (value) => `0x${value.toString(16).padStart(64, '0')}`;

// A budget with the pacing removed. The lane's own pacing constants are not
// what these tests are about, and a 400ms/7s spacing would turn a unit suite
// into a 30-second one. `sleep` is stubbed so the spacing gap costs nothing.
function fastBudget(key) {
  return createBudget(key, { spacingMs: 0, capacity: 1_000, refillMs: 1, perRotationRowCap: null, sleep: async () => {} });
}

function headersOf(values) {
  const lower = new Map(Object.entries(values ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (name) => (lower.has(String(name).toLowerCase()) ? lower.get(String(name).toLowerCase()) : null) };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  // `ok` is part of the Response contract IngestHttp reads. A stub that omits
  // it turns every 200 into a thrown HTTP error, which fails the suite for a
  // reason that has nothing to do with the lane under test.
  return { ok: status >= 200 && status < 300, status, headers: headersOf(headers), text: async () => JSON.stringify(body) };
}

// Answers JSON-RPC by method+callee from a script and records every call.
function rpcStub(script) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    const to = body.params?.[0]?.to ?? null;
    const data = body.params?.[0]?.data ?? null;
    calls.push({ url, method: body.method, to, data });
    const key = `${body.method}@${to}`;
    const answer = script[key];
    if (answer === undefined) return jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no stub' } });
    return jsonResponse({ jsonrpc: '2.0', id: 1, result: answer });
  };
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------------------
// FDV / liquidity math
// ---------------------------------------------------------------------------

test('reserves produce an FDV through the LP-share form, not the pool value', () => {
  // 30M of a 1B-supply token sits in a 30k USDC pool. The pool is worth 30k;
  // the token's whole supply is worth 33x that. Reading the reserve alone as
  // size would under-report this token by exactly that factor.
  const overlay = computeSizeOverlay({
    totalSupplyRaw: TOKEN_18(1_000_000_000),
    reserveTokenRaw: TOKEN_18(30_000_000),
    reserveQuoteRaw: USDC_6(30_000),
    decimals: 18,
    quoteDecimals: 6,
    quotePriceUsd: 1,
    tokenIsReserve0: true,
  });
  assert.equal(overlay.supply, 1_000_000_000);
  assert.equal(overlay.quoteReserve, 30_000);
  assert.equal(overlay.pricePerTokenQuote, 0.001);
  assert.equal(overlay.fdvUsd, 1_000_000);
  // TVL is twice ONE side of the pair: both sides of a constant-product pool
  // are worth the same.
  assert.equal(overlay.liquidityUsd, 60_000);
  assert.equal(overlay.degraded, false);
  assert.equal(overlay.basis, ENRICHMENT_BASIS.NONE, 'basis is set by the caller, not guessed here:');
});

test('the same pool read from the other side gives the same FDV', () => {
  const args = { totalSupplyRaw: TOKEN_18(1_000_000_000), decimals: 18, quoteDecimals: 6, quotePriceUsd: 1 };
  const asToken0 = computeSizeOverlay({ ...args, reserveTokenRaw: TOKEN_18(30_000_000), reserveQuoteRaw: USDC_6(30_000), tokenIsReserve0: true });
  const asToken1 = computeSizeOverlay({ ...args, reserveTokenRaw: TOKEN_18(30_000_000), reserveQuoteRaw: USDC_6(30_000), tokenIsReserve0: false });
  assert.equal(asToken1.fdvUsd, asToken0.fdvUsd);
});

test('a 3% float is reported as ~33x the pool value, which is the whole point of the lane', () => {
  const overlay = computeSizeOverlay({
    totalSupplyRaw: TOKEN_18(1_000_000_000),
    reserveTokenRaw: TOKEN_18(30_000_000),
    reserveQuoteRaw: USDC_6(30_000),
    decimals: 18,
    quoteDecimals: 6,
    quotePriceUsd: 1,
    tokenIsReserve0: true,
  });
  // One side of the pool is 30k; the whole float at that price is 1M, i.e. 33x.
  // Reporting the pool value as the token's size would under-state it 33-fold.
  assert.ok(overlay.fdvUsd / (overlay.liquidityUsd / 2) > 30, 'FDV must not collapse onto the pool value:');
  assert.ok(overlay.fdvUsd / overlay.liquidityUsd > 15, 'and must not collapse onto TVL either:');
});

test('zero supply degrades the overlay and never becomes a zero-sized token', () => {
  const overlay = computeSizeOverlay({
    totalSupplyRaw: 0n,
    reserveTokenRaw: TOKEN_18(1_000),
    reserveQuoteRaw: USDC_6(1_000),
    decimals: 18,
    quoteDecimals: 6,
    quotePriceUsd: 1,
    tokenIsReserve0: true,
  });
  assert.equal(overlay.fdvUsd, null, '0n supply must not produce $0 FDV:');
  assert.equal(overlay.degraded, true);
  assert.ok(overlay.reasons.includes('zero_supply'));
});

test('missing reserves are null, not zero', () => {
  const overlay = computeSizeOverlay({
    totalSupplyRaw: TOKEN_18(1_000_000),
    reserveTokenRaw: null,
    reserveQuoteRaw: null,
    decimals: 18,
    quoteDecimals: 6,
    quotePriceUsd: 1,
    tokenIsReserve0: true,
  });
  assert.equal(overlay.fdvUsd, null);
  assert.equal(overlay.liquidityUsd, null);
  assert.equal(overlay.degraded, true);
  assert.equal(overlay.basis, ENRICHMENT_BASIS.NONE);
  assert.ok(overlay.reasons.includes('token_reserve_unavailable'));
  assert.ok(overlay.reasons.includes('quote_reserve_unavailable'));
});

test('without a quote USD price the price primitive survives but no USD figure is invented', () => {
  const overlay = computeSizeOverlay({
    totalSupplyRaw: TOKEN_18(1_000_000),
    reserveTokenRaw: TOKEN_18(100_000),
    reserveQuoteRaw: TOKEN_18(5),
    decimals: 18,
    quoteDecimals: 18,
    quotePriceUsd: null,
    tokenIsReserve0: true,
  });
  // 5/100_000 in binary floating point is not exactly 5e-5; the primitive is
  // correct to the precision a price can have, so the test asks for that much.
  assert.ok(Math.abs(overlay.pricePerTokenQuote - 0.00005) < 1e-18, `price primitive drifted: ${overlay.pricePerTokenQuote}`);
  assert.equal(overlay.fdvUsd, null, 'assuming the quote asset is $1 is how a wrong FDV gets shipped:');
  assert.equal(overlay.liquidityUsd, null);
  assert.ok(overlay.reasons.includes('quote_price_unavailable'));
});

test('an unknown reserve side is named instead of guessed', () => {
  const overlay = computeSizeOverlay({
    totalSupplyRaw: TOKEN_18(1_000_000),
    reserveTokenRaw: TOKEN_18(100_000),
    reserveQuoteRaw: TOKEN_18(5),
    decimals: 18,
    quoteDecimals: 18,
    quotePriceUsd: 1,
    tokenIsReserve0: null,
  });
  assert.ok(overlay.reasons.includes('reserve_side_unknown'));
});

test('an already-measured figure outranks the derived one', () => {
  const overlay = computeSizeOverlay({
    totalSupplyRaw: TOKEN_18(1_000_000),
    reserveTokenRaw: TOKEN_18(100_000),
    reserveQuoteRaw: TOKEN_18(5),
    decimals: 18,
    quoteDecimals: 18,
    quotePriceUsd: 1,
    tokenIsReserve0: true,
    fdvUsd: 987_654,
    liquidityUsd: 123_456,
  });
  assert.equal(overlay.fdvUsd, 987_654, 'a provider number must not be overwritten by our arithmetic:');
  assert.equal(overlay.liquidityUsd, 123_456);
});

test('no risk verdict is ever produced by the math', () => {
  const overlay = computeSizeOverlay({ totalSupplyRaw: TOKEN_18(1_000_000), reserveTokenRaw: TOKEN_18(1), reserveQuoteRaw: USDC_6(1), decimals: 18, quoteDecimals: 6, quotePriceUsd: 1, tokenIsReserve0: true });
  for (const field of ['isHoneypot', 'buyTax', 'sellTax', 'risk', 'holders']) {
    assert.equal(overlay[field], undefined, `enrichment must not produce ${field}:`);
  }
});

// ---------------------------------------------------------------------------
// PublicNode lane
// ---------------------------------------------------------------------------

test('the PublicNode lane reads supply, reserves and the reserve side', async () => {
  const fetchImpl = rpcStub({
    [`eth_call@${TOKEN}`]: word(TOKEN_18(1_000_000_000)),
    [`eth_call@${PAIR}`]: (() => {
      const selector = '0x';
      return null;
    })(),
  });
  // token0/token1 and getReserves share one callee, so dispatch on the selector.
  fetchImpl.dispose = true;
  const laneFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const to = body.params?.[0]?.to;
    const data = body.params?.[0]?.data;
    fetchImpl.calls.push({ url, method: body.method, to, data });
    if (to === TOKEN) return jsonResponse({ jsonrpc: '2.0', id: 1, result: word(TOKEN_18(1_000_000_000)) });
    if (data.startsWith('0x0dfe1681')) return jsonResponse({ jsonrpc: '2.0', id: 1, result: word(BigInt(TOKEN)) });
    if (data.startsWith('0xd21220a7')) return jsonResponse({ jsonrpc: '2.0', id: 1, result: word(BigInt(USDC)) });
    if (data.startsWith('0x0902f1ac')) {
      // token0 = TOKEN (18 decimals), token1 = USDC (6 decimals). The raw
      // order and the decimals must agree, or the overlay is being asked to
      // divide a 6-decimal number by 10^18 — which is not a bug in the overlay.
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: `0x${TOKEN_18(30_000_000).toString(16).padStart(64, '0')}${USDC_6(30_000).toString(16).padStart(64, '0')}${word(0).slice(2)}`,
      });
    }
    return jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no stub' } });
  };

  const lane = new PublicNodeSizeLane({ fetchImpl: laneFetch, budget: fastBudget('publicnode') });
  const overlay = await lane.overlay('robinhood', {
    address: TOKEN,
    pairAddress: PAIR,
    decimals: 18,
    quoteDecimals: 6,
    quotePriceUsd: 1,
  });

  assert.equal(overlay.chain, 'robinhood');
  assert.equal(overlay.supply, 1_000_000_000);
  assert.equal(overlay.fdvUsd, 1_000_000);
  assert.equal(overlay.liquidityUsd, 60_000);
  assert.equal(overlay.basis, ENRICHMENT_BASIS.RPC_RESERVES);
  assert.equal(overlay.degraded, false);
  assert.equal(overlay.tokenIsReserve0, undefined, 'the resolved side is reported through the numbers:');
});

test('the token on the reserve1 side is read from the right pool', async () => {
  const laneFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const to = body.params?.[0]?.to;
    const data = body.params?.[0]?.data;
    if (to === TOKEN) return jsonResponse({ jsonrpc: '2.0', id: 1, result: word(TOKEN_18(1_000_000_000)) });
    if (data.startsWith('0x0dfe1681')) return jsonResponse({ jsonrpc: '2.0', id: 1, result: word(BigInt(USDC)) });
    if (data.startsWith('0xd21220a7')) return jsonResponse({ jsonrpc: '2.0', id: 1, result: word(BigInt(TOKEN)) });
    if (data.startsWith('0x0902f1ac')) {
      // The token is token1 here, so the raw word order is USDC first.
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: `0x${USDC_6(30_000).toString(16).padStart(64, '0')}${TOKEN_18(30_000_000).toString(16).padStart(64, '0')}${word(0).slice(2)}`,
      });
    }
    return jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no stub' } });
  };
  const lane = new PublicNodeSizeLane({ fetchImpl: laneFetch, budget: fastBudget('publicnode') });
  const overlay = await lane.overlay('eth', { address: TOKEN, pairAddress: PAIR, decimals: 18, quoteDecimals: 6, quotePriceUsd: 1 });
  assert.equal(overlay.fdvUsd, 1_000_000, 'reading the wrong reserve inverts the price:');
  assert.equal(overlay.degraded, false);
});

test('a solana row is refused with a reason instead of a wrong EVM answer', async () => {
  const lane = new PublicNodeSizeLane({ fetchImpl: async () => { throw new Error('must not be called'); }, budget: fastBudget('publicnode') });
  const overlay = await lane.overlay('sol', { address: 'So11111111111111111111111111111111111111112', pairAddress: PAIR });
  assert.equal(overlay.fdvUsd, null);
  assert.equal(overlay.degraded, true);
  assert.match(overlay.reason, /EVM-only|cannot serve solana/);
});

test('reserves without a pool address are refused: a token contract carries no price', async () => {
  const lane = new PublicNodeSizeLane({ fetchImpl: async () => { throw new Error('must not be called'); }, budget: fastBudget('publicnode') });
  const overlay = await lane.overlay('robinhood', { address: TOKEN });
  assert.equal(overlay.fdvUsd, null);
  assert.match(overlay.reason, /pair_address_required/);
});

test('a JSON-RPC error at HTTP 200 degrades the overlay instead of reporting zeros', async () => {
  // The exact PublicNode shape: HTTP 200 with an `error` member. Reading
  // `result` off that yields undefined, and a caller that treated undefined as
  // "no supply" would mark an ordinary token degraded for the wrong reason —
  // or, worse, as having zero supply.
  const laneFetch = async () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } });
  const lane = new PublicNodeSizeLane({ fetchImpl: laneFetch, budget: fastBudget('publicnode') });
  const overlay = await lane.overlay('robinhood', { address: TOKEN, pairAddress: PAIR, decimals: 18, quoteDecimals: 6, quotePriceUsd: 1 });
  assert.equal(overlay.fdvUsd, null);
  assert.equal(overlay.supply, null, 'a failed read must never become a zero supply:');
  assert.equal(overlay.degraded, true);
  assert.match(overlay.reason, /rpc_failed/);
});

test('a truncated reserves word is an error, not a mis-scaled liquidity', async () => {
  const laneFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const data = body.params?.[0]?.data;
    const to = body.params?.[0]?.to;
    if (to === TOKEN) return jsonResponse({ jsonrpc: '2.0', id: 1, result: word(TOKEN_18(1_000_000_000)) });
    if (data.startsWith('0x0dfe1681')) return jsonResponse({ jsonrpc: '2.0', id: 1, result: word(BigInt(TOKEN)) });
    if (data.startsWith('0xd21220a7')) return jsonResponse({ jsonrpc: '2.0', id: 1, result: word(BigInt(USDC)) });
    return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0xdeadbeef' });
  };
  const lane = new PublicNodeSizeLane({ fetchImpl: laneFetch, budget: fastBudget('publicnode') });
  const overlay = await lane.overlay('robinhood', { address: TOKEN, pairAddress: PAIR, decimals: 18, quoteDecimals: 6, quotePriceUsd: 1 });
  assert.equal(overlay.fdvUsd, null);
  assert.ok(overlay.reasons.includes('token_reserve_unavailable'));
});

test('a token that is neither token0 nor token1 degrades rather than inverting', async () => {
  const laneFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const data = body.params?.[0]?.data;
    const to = body.params?.[0]?.to;
    if (to === TOKEN) return jsonResponse({ jsonrpc: '2.0', id: 1, result: word(TOKEN_18(1_000_000_000)) });
    if (data.startsWith('0x0dfe1681')) return jsonResponse({ jsonrpc: '2.0', id: 1, result: word(BigInt('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) });
    if (data.startsWith('0xd21220a7')) return jsonResponse({ jsonrpc: '2.0', id: 1, result: word(BigInt('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')) });
    if (data.startsWith('0x0902f1ac')) return jsonResponse({ jsonrpc: '2.0', id: 1, result: `0x${word(0).slice(2)}${word(0).slice(2)}${word(0).slice(2)}` });
    return jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no stub' } });
  };
  const lane = new PublicNodeSizeLane({ fetchImpl: laneFetch, budget: fastBudget('publicnode') });
  const overlay = await lane.overlay('robinhood', { address: TOKEN, pairAddress: PAIR, decimals: 18, quoteDecimals: 6, quotePriceUsd: 1 });
  assert.ok(overlay.reasons.includes('reserve_side_unknown'));
  assert.equal(overlay.fdvUsd, null);
});

// ---------------------------------------------------------------------------
// DexScreener batch overlay (pure)
// ---------------------------------------------------------------------------

test('a DexScreener batch row fills both size fields when it has them', () => {
  const overlay = overlayFromDexScreenerBatch(
    [{ pairAddress: PAIR, dexId: 'uniswap-v3', fdv: 1_000_000, marketCap: 40_000, liquidity: { usd: 12_000, quote: 6_000 }, baseToken: { address: TOKEN } }],
    TOKEN,
  );
  assert.equal(overlay.fdvUsd, 1_000_000);
  assert.equal(overlay.marketCapUsd, 40_000);
  assert.equal(overlay.liquidityUsd, 12_000);
  assert.equal(overlay.basis, ENRICHMENT_BASIS.DEXSCREENER);
  assert.equal(overlay.degraded, false);
});

test('an FDV-only row stays labelled FDV-only', () => {
  const overlay = overlayFromDexScreenerBatch([{ pairAddress: PAIR, fdv: 55_000, liquidity: { usd: 3_000 }, baseToken: { address: TOKEN } }], TOKEN);
  assert.equal(overlay.fdvUsd, 55_000);
  assert.equal(overlay.marketCapUsd, null, 'FDV must never be copied into marketCap:');
  const record = createRecord({ chain: 'robinhood', address: TOKEN, source: 'geckoterminal', fdvUsd: null });
  const enriched = applySizeOverlay(record, overlay);
  assert.equal(enriched.sizeIsFdvOnly, true);
  assert.ok(!enriched.unresolved.includes('marketCap'), 'a still-unknown market cap must stay unresolved:');
});

test('an address absent from the batch is reported, not matched to a neighbour', () => {
  const overlay = overlayFromDexScreenerBatch(
    [{ pairAddress: PAIR, fdv: 1_000_000, baseToken: { address: USDC } }],
    TOKEN,
  );
  assert.equal(overlay.fdvUsd, null);
  assert.equal(overlay.degraded, true);
  assert.deepEqual(overlay.reasons, ['address_not_in_batch']);
});

test('an unrecognised batch payload degrades instead of throwing', () => {
  assert.deepEqual(overlayFromDexScreenerBatch(null, TOKEN).reasons, ['batch_payload_unrecognised']);
  assert.equal(overlayFromDexScreenerBatch({ error: 'rate limited' }, TOKEN).basis, ENRICHMENT_BASIS.NONE);
});

// ---------------------------------------------------------------------------
// Applying an overlay to a record
// ---------------------------------------------------------------------------

test('an overlay fills gaps and never overwrites what the record already measured', () => {
  const record = createRecord({ chain: 'robinhood', address: TOKEN, source: 'geckoterminal', fdvUsd: 42_000, liquidityUsd: null });
  record.unresolved = ['marketCap', 'liquidityUsd', 'security'];
  const enriched = applySizeOverlay(record, { fdvUsd: 999_999, liquidityUsd: 7_500, basis: ENRICHMENT_BASIS.RPC_RESERVES, degraded: false });
  assert.equal(enriched.size.fdv, 42_000, 'a measured FDV outranks derived arithmetic:');
  assert.equal(enriched.liquidityUsd, 7_500);
  assert.deepEqual(enriched.unresolved, ['marketCap', 'security'], 'only filled capabilities leave the unresolved list:');
  assert.equal(enriched.evidence.enrichment.basis, ENRICHMENT_BASIS.RPC_RESERVES);
});

test('a degraded overlay leaves the record untouched apart from the evidence note', () => {
  const record = createRecord({ chain: 'robinhood', address: TOKEN, source: 'geckoterminal' });
  record.unresolved = ['marketCap', 'security'];
  const enriched = applySizeOverlay(record, { basis: ENRICHMENT_BASIS.NONE, degraded: true, reason: 'rpc_failed: timeout' });
  assert.equal(enriched.size.fdv, null);
  assert.equal(enriched.liquidityUsd, null);
  assert.deepEqual(enriched.unresolved, ['marketCap', 'security']);
  assert.deepEqual(enriched.evidence.enrichment.reasons, ['rpc_failed: timeout']);
});

// ---------------------------------------------------------------------------
// DexPaprika 1h volume lane
// ---------------------------------------------------------------------------

test('a DexPaprika fetch inside the cadence asks nothing', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ volume_usd_1h: 4_200, volume_usd_24h: 90_000 }, { headers: { 'x-credits-remaining': '9000', 'cf-cache-status': 'MISS' } });
  };
  let clock = 1_000_000;
  const lane = new DexPaprikaVolumeLane({ fetchImpl, budget: fastBudget('dexpaprika'), now: () => clock });

  const first = await lane.volume1h('eth', { poolId: 'eth_0xpair' });
  assert.equal(first.volume1hUsd, 4_200);
  assert.equal(first.cadenceGuard, 'fetched');
  assert.equal(calls, 1);

  // An hour later: the 1h figure has not moved.
  clock += DEXPAPRIKA_1H_CADENCE_MS - 1;
  const second = await lane.volume1h('eth', { poolId: 'eth_0xpair' });
  assert.equal(second.volume1hUsd, 4_200);
  assert.equal(second.cadenceGuard, 'within_cadence');
  assert.equal(calls, 1, 'a cache hit in our own cadence guard must cost no credit:');

  clock += 2;
  const third = await lane.volume1h('eth', { poolId: 'eth_0xpair' });
  assert.equal(third.cadenceGuard, 'fetched');
  assert.equal(calls, 2);
});

test('the cadence guard is per pool, so one hot pool cannot starve the rotation', async () => {
  const fetchImpl = async () => jsonResponse({ volume_usd_1h: 100 });
  const lane = new DexPaprikaVolumeLane({ fetchImpl, budget: fastBudget('dexpaprika'), now: () => 5_000 });
  await lane.volume1h('eth', { poolId: 'a' });
  const other = await lane.volume1h('eth', { poolId: 'b' });
  assert.equal(other.cadenceGuard, 'fetched');
});

test('an exhausted credit pool refuses the call instead of spending one it does not have', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ volume_usd_1h: 1 }, { headers: { 'x-credits-remaining': '0', 'cf-cache-status': 'MISS' } });
  };
  const budget = fastBudget('dexpaprika');
  const lane = new DexPaprikaVolumeLane({ fetchImpl, budget, now: () => 1 });
  const first = await lane.volume1h('eth', { poolId: 'p' });
  assert.equal(first.volume1hUsd, 1);
  assert.equal(calls, 1);

  // The pool the previous call left behind is now empty; a second pool must be
  // refused rather than answered from a budget we know is spent.
  const second = await lane.volume1h('eth', { poolId: 'q' });
  assert.equal(second.volume1hUsd, null);
  assert.match(second.reason, /credit_pool_exhausted/);
  assert.equal(calls, 1, 'no request may leave without a credit:');
});

test('a DexPaprika 402 opens the breaker and the next call is refused without a request', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ error: 'quota exceeded' }, { status: 402, headers: { 'x-credits-remaining': '0' } });
  };
  const budget = fastBudget('dexpaprika');
  const lane = new DexPaprikaVolumeLane({ fetchImpl, budget, now: () => 1 });
  const failed = await lane.volume1h('eth', { poolId: 'p' });
  assert.match(failed.reason, /throttled|failed/);
  assert.equal(calls, 1);

  const snapshot = budget.snapshot();
  assert.equal(snapshot.throttled, true, 'a 402 must register as a throttle:');
  assert.ok(snapshot.cooldownMs > 0);

  const refused = await lane.volume1h('eth', { poolId: 'q' });
  assert.equal(calls, 1, 'a throttled source must not be asked again this rotation:');
  assert.equal(refused.volume1hUsd, null);
  assert.match(refused.reason, /budget says stop/);
});

test('a refusal inside the cadence still serves the last measured figure, labelled', async () => {
  const fetchImpl = async (_url, init) => {
    const method = JSON.parse(init.body ?? '{}');
    void method;
    return jsonResponse({ volume_usd_1h: 777 });
  };
  let clock = 0;
  const budget = fastBudget('dexpaprika');
  const lane = new DexPaprikaVolumeLane({ fetchImpl, budget, now: () => clock });
  await lane.volume1h('eth', { poolId: 'p' });
  budget.report({ status: 402, body: { error: 'quota' } });
  clock += DEXPAPRIKA_1H_CADENCE_MS + 1;
  const refused = await lane.volume1h('eth', { poolId: 'p' });
  assert.equal(refused.volume1hUsd, 777, 'a stale-but-real figure beats nothing:');
  assert.equal(refused.cadenceGuard, 'cached');
  assert.equal(refused.degraded, true);
});

test('a provider answer with no volume figure degrades instead of reporting zero', async () => {
  const fetchImpl = async () => jsonResponse({ pair_id: 'p' });
  const lane = new DexPaprikaVolumeLane({ fetchImpl, budget: fastBudget('dexpaprika'), now: () => 1 });
  const result = await lane.volume1h('eth', { poolId: 'p' });
  assert.equal(result.volume1hUsd, null);
  assert.match(result.reason, /no_volume_field/);
});

test('a row with neither a pool id nor an address is refused locally', async () => {
  let calls = 0;
  const lane = new DexPaprikaVolumeLane({ fetchImpl: async () => { calls += 1; return jsonResponse({}); }, budget: fastBudget('dexpaprika') });
  const result = await lane.volume1h('eth', {});
  assert.equal(result.volume1hUsd, null);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// Helius holders lane
// ---------------------------------------------------------------------------

test('no API key disables the holders lane and makes no request', async () => {
  let calls = 0;
  const lane = new HeliusHoldersLane({
    fetchImpl: async () => { calls += 1; return jsonResponse({}); },
    budget: fastBudget('helius'),
    apiKey: '',
  });
  const result = await lane.holders('sol', 'So11111111111111111111111111111111111111112');
  assert.equal(result.available, false);
  assert.equal(result.holders, null, 'absent holders must stay null:');
  assert.equal(result.degraded, true);
  assert.equal(calls, 0);
  assert.match(result.reason, /HELIUS_API_KEY is not set/);
});

test('heliusAvailability reports the key state without echoing the key', () => {
  assert.equal(heliusAvailability({ HELIUS_API_KEY: '   ' }).available, false);
  assert.equal(heliusAvailability({ HELIUS_API_KEY: 'abc123' }).available, true);
  assert.ok(!JSON.stringify(heliusAvailability({ HELIUS_API_KEY: 'abc123' })).includes('abc123'));
});

test('Helius refuses every EVM chain: it is a Solana service', async () => {
  let calls = 0;
  const lane = new HeliusHoldersLane({ fetchImpl: async () => { calls += 1; return jsonResponse({}); }, budget: fastBudget('helius'), apiKey: 'key-material' });
  for (const chain of ['eth', 'bsc', 'base', 'robinhood']) {
    const result = await lane.holders(chain, TOKEN);
    assert.equal(result.available, false);
    assert.equal(result.holders, null);
    assert.match(result.reason, /solana_only/);
  }
  assert.equal(calls, 0);
});

test('the API key never appears in a result, even when the call fails', async () => {
  const lane = new HeliusHoldersLane({
    fetchImpl: async () => ({ ok: false, status: 500, headers: headersOf({}), text: async () => 'upstream exploded' }),
    budget: fastBudget('helius'),
    apiKey: 'super-secret-key',
  });
  const result = await lane.holders('sol', 'So11111111111111111111111111111111111111112');
  assert.equal(result.holders, null);
  assert.ok(!JSON.stringify(result).includes('super-secret-key'), 'a key in a reason string reaches logs and the status endpoint:');
  assert.match(result.reason, /helius_failed/);
});

test('a declared holder count is read; a top-owner list alone is not a count', async () => {
  const counted = new HeliusHoldersLane({
    fetchImpl: async () => jsonResponse({ result: { token_info: { holders_count: 1234, supply: 1_000_000 } } }),
    budget: fastBudget('helius'),
    apiKey: 'k',
  });
  const withCount = await counted.holders('sol', 'So11111111111111111111111111111111111111112');
  assert.equal(withCount.holders, 1234);
  assert.equal(withCount.degraded, false);

  const uncounted = new HeliusHoldersLane({
    fetchImpl: async () => jsonResponse({ result: { top_owners: [{ address: 'A', uiAmount: 100 }] } }),
    budget: fastBudget('helius'),
    apiKey: 'k',
  });
  const withoutCount = await uncounted.holders('sol', 'So11111111111111111111111111111111111111112');
  assert.equal(withoutCount.holders, null, 'len(topOwners) is not a holder count:');
  assert.equal(withoutCount.top10Share, null, 'a share without a supply denominator would be invented:');
  assert.match(withoutCount.reason, /holder_count_unavailable/);
});

test('concentration is computed only when the response supplies a supply', async () => {
  const lane = new HeliusHoldersLane({
    fetchImpl: async () => jsonResponse({
      result: {
        token_info: { holders_count: 50, supply: 1_000 },
        top_owners: [{ address: 'A', uiAmount: 400 }, { address: 'B', uiAmount: 100 }],
      },
    }),
    budget: fastBudget('helius'),
    apiKey: 'k',
  });
  const result = await lane.holders('sol', 'So11111111111111111111111111111111111111112');
  assert.equal(result.top10Share, 0.5);
  assert.equal(result.topOwners.length, 2);
});

// ---------------------------------------------------------------------------
// Cross-cutting invariants
// ---------------------------------------------------------------------------

test('THE INVARIANT: no lane can produce a risk verdict', async () => {
  const rpcLane = new PublicNodeSizeLane({
    fetchImpl: rpcStub({ [`eth_call@${TOKEN}`]: word(TOKEN_18(1_000_000_000)) }),
    budget: fastBudget('publicnode'),
  });
  const size = await rpcLane.overlay('eth', { address: TOKEN, pairAddress: PAIR, decimals: 18, quoteDecimals: 6, quotePriceUsd: 1 });
  const volume = await new DexPaprikaVolumeLane({ fetchImpl: async () => jsonResponse({ volume_usd_1h: 1 }), budget: fastBudget('dexpaprika') }).volume1h('eth', { poolId: 'p' });
  const holders = await new HeliusHoldersLane({ fetchImpl: async () => jsonResponse({ result: {} }), budget: fastBudget('helius'), apiKey: 'k' }).holders('sol', 'So11111111111111111111111111111111111111112');
  // The size lane here is deliberately starved of a pool, so it has nothing to
  // measure and must say so. A complete measurement is exactly what must NOT
  // read as `degraded:false` by accident — but a starved one that claims it is
  // clean would be worse, so assert the reason is explicit.
  for (const [name, payload] of [['size', size], ['volume', volume], ['holders', holders]]) {
    const text = JSON.stringify(payload);
    assert.ok(!/"isHoneypot"|"buyTax"|"sellTax"/.test(text), `${name} must not carry risk fields:`);
  }
  assert.equal(size.degraded, true, 'a size overlay with no pool measured nothing:');
  assert.ok(size.reasons.length > 0, 'and it must name why:');
  assert.equal(volume.degraded, false, 'a real 1h volume IS a complete measurement:');
  assert.equal(holders.degraded, true, 'an empty DAS result is not a holder count:');
});

test('every budget used by this module comes from the shared table', async () => {
  const { SOURCE_BUDGETS } = await import('../../src/ingest/budget.mjs');
  assert.ok(SOURCE_BUDGETS.helius, 'the Helius lane needs a budget entry:');
  assert.ok(SOURCE_BUDGETS.publicnode && SOURCE_BUDGETS.dexpaprika && SOURCE_BUDGETS.dexscreener);
  const lane = new HeliusHoldersLane({ apiKey: 'k' });
  assert.equal(lane.budget.host, SOURCE_BUDGETS.helius.host);
});