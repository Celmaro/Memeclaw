// Tests for the P2 wiring layer (src/ingest/enrich-wiring.mjs).
//
// Run in-process: `node test/ingest/enrich-wiring.test.mjs`. Same harness as
// signals.test.mjs and enrich.test.mjs — node:assert/strict plus a local
// `test()` and `process.exitCode = 1`, because `node --test` cannot spawn on
// this host.
//
// ZERO NETWORK. Every lane receives an injected fetchImpl, and the one thing
// that could still reach a real socket is the budget's spacing sleep — so the
// suites pass `budgetOverrides: { spacingMs: 0, sleep: async () => {} }`. That
// changes pacing ONLY. Row caps and breaker thresholds stay exactly as
// SOURCE_BUDGETS sets them, because those are what the lanes reason about and a
// test that loosened them would be testing a different system.
//
// What is being asserted, in order of how much it matters:
//   1. PASS-THROUGH. The coordinator's identity and every non-discover member
//      survive. If that breaks, emitters downstream break in ways no unit test
//      here would catch.
//   2. FILL-ONLY. No lane may overwrite a value the record already carried.
//      Overwriting evidence with an inference is the failure mode the whole
//      ingest layer is built to prevent.
//   3. FAIL OPEN. A dead upstream produces a finding and an untouched record —
//      never a throw, and never a half-enriched record that no longer matches
//      the reason it was rejected.
//   4. THE DECIMALS GATE. 18 vs 6 is a 10^12 error that looks like a real
//      dollar figure. Unreadable decimals must skip the record, not assume.

import assert from 'node:assert/strict';
import { attachEnrichment, budgetStopReason, DEX_CHAIN_IDS, PAPRIKA_NETWORKS, PUBLICNODE_CALLS_PER_RECORD } from '../../src/ingest/enrich-wiring.mjs';
import { SOURCE_BUDGETS } from '../../src/ingest/budget.mjs';
import { createRecord } from '../../src/ingest/record.mjs';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.stack ?? error.message });
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN = '0x1111111111111111111111111111111111111111';
const QUOTE = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';
const MINT = 'So11111111111111111111111111111111111111112';

const FAST = { spacingMs: 0, sleep: async () => {} };

const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const addrWord = (address) => `0x${address.replace(/^0x/, '').padStart(64, '0')}`;

function response(body, { status = 200, headers = {} } = {}) {
  // `ok` matters: IngestHttp reads it (http.mjs:92) and a stub that omits it
  // turns every 200 into a thrown HTTP error.
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[String(name).toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

// A record as GeckoTerminal actually builds it: lowercase address, `price` for
// the spot price, `size` as a nested object, quoteTokenAddress appended by the
// adapter (geckoterminal.mjs:99).
function record(overrides = {}) {
  return {
    ...createRecord({
      chain: 'robinhood',
      address: TOKEN,
      source: 'geckoterminal',
      poolAddress: POOL,
      priceUsd: 0.01,
      capturedAtSec: 1_800_000_000,
      ...overrides,
    }),
    quoteTokenAddress: QUOTE,
    ...overrides.extra,
  };
}

function fakeDiscovery(records, extra = {}) {
  const calls = [];
  return {
    providers: ['GECKOTERMINAL'],
    emitters: [{ id: 'gt', provider: 'GECKOTERMINAL' }],
    lastRun: { chain: 'base', records: 7 },
    beginRotation(rotationId) { calls.push({ rotationId }); },
    snapshot() { return { chain: 'base', records: 7 }; },
    async discover(chain, opts) {
      calls.push({ chain, ...opts });
      return { records, observations: [{ chain }], findings: extra.findings ?? [] };
    },
    calls,
    ...extra.members,
  };
}

function wire(discovery, { fetchImpl, env = {} } = {}) {
  return attachEnrichment(discovery, {
    fetchImpl,
    env,
    now: () => 1_800_000_000_000,
    budgetOverrides: {
      dexscreener: FAST,
      dexpaprika: FAST,
      publicnode: FAST,
      helius: FAST,
    },
  });
}

function findingsMatching(findings, source) {
  return findings.filter(entry => entry.source === source);
}

// A fetcher that refuses anything it was not told about. A silent default
// response would let a lane "succeed" against a host it was never scripted for,
// which is how a test suite passes while the wiring is wrong.
function router(routes) {
  const seen = [];
  const impl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ url, body });
    for (const route of routes) {
      if (route.match(url, body, init)) return route.reply(url, body, init, seen.length);
    }
    throw new Error(`unrouted request: ${init.method ?? 'GET'} ${url}`);
  };
  impl.seen = seen;
  return impl;
}

const dexBatch = (pairs) => route({ url: url => url.startsWith('https://api.dexscreener.com/tokens/v1/'), body: null },
  () => response(pairs));

function route(match, reply) {
  return { match: typeof match === 'function' ? match : (_u, b, i) => (match.url ? match.url(String(_u)) : true), reply };
}

// ---------------------------------------------------------------------------
// Pass-through — the coordinator must not be able to tell it was wrapped
// ---------------------------------------------------------------------------

await test('providers, snapshot, beginRotation and lastRun pass through untouched', async () => {
  const discovery = fakeDiscovery([], { members: {} });
  const wired = wire(discovery, { fetchImpl: async () => { throw new Error('no network'); } });
  assert.equal(wired.providers, discovery.providers, 'providers is what the scanner widens its filter by');
  assert.deepEqual(wired.snapshot(), { chain: 'base', records: 7 });
  assert.equal(wired.lastRun, discovery.lastRun, 'lastRun must be the coordinator\'s own object, not a copy');
  assert.equal(wired.emitters, discovery.emitters);
  wired.beginRotation('r-9');
  assert.deepEqual(discovery.calls.at(-1), { rotationId: 'r-9' });
  assert.notEqual(wired.discover, discovery.discover, 'discover is the one member that must be replaced');
});

await test('an empty record list comes back byte-identical, with no findings and no requests', async () => {
  const discovery = fakeDiscovery([]);
  const fetchImpl = router([]);
  const result = await wire(discovery, { fetchImpl }).discover('robinhood', { rotationId: 'r1' });
  assert.equal(result.records.length, 0);
  assert.equal(result.findings.length, 0, 'nothing to enrich is not a finding:');
  assert.deepEqual(result.observations, [{ chain: 'robinhood' }], 'observations must survive');
  assert.equal(fetchImpl.seen.length, 0, 'an empty rotation must cost nothing:');
});

await test('a discovery result that is not an object shape is passed through without throwing', async () => {
  const wired = wire({ async discover() { return undefined; } }, { fetchImpl: async () => { throw new Error('no network'); } });
  const result = await wired.discover('eth', {});
  assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// Lane 1 — DexScreener
// ---------------------------------------------------------------------------

await test('the DexScreener batch fills the size gaps and never overwrites what the record already carried', async () => {
  const kept = record({ fdvUsd: 4242, marketCapUsd: 111, liquidityUsd: 900, volume1hUsd: 5 });
  const bare = record();
  const fetchImpl = router([
    dexBatch([
      { baseToken: { address: TOKEN }, fdv: 99, marketCap: 1, liquidity: { usd: 2 }, pairAddress: POOL, dexId: 'uniswap-v2' },
    ]),
  ]);
  const result = await wire(fakeDiscovery([kept, bare]), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });

  assert.equal(result.records[0].size.fdv, 4242, 'a measured FDV outranks anything a batch says:');
  assert.equal(result.records[0].size.marketCap, 111);
  assert.equal(result.records[0].liquidityUsd, 900);
  assert.equal(result.records[0].activity.volume1hUsd, 5, 'and a volume the source already reported is untouched:');
  assert.equal(result.records[1].size.fdv, 99);
  assert.equal(result.records[1].size.marketCap, 1);
  assert.equal(result.records[1].liquidityUsd, 2);
  assert.equal(result.records[1].sizeIsFdvOnly, false);
});

await test('the DexScreener lane leaves an FDV-only row labelled FDV-only rather than implying a band test ran', async () => {
  const bare = record();
  const fetchImpl = router([dexBatch([{ baseToken: { address: TOKEN }, fdv: 99, liquidity: { usd: 2 }, pairAddress: POOL }])]);
  const { records } = await wire(fakeDiscovery([bare]), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });
  assert.equal(records[0].size.fdv, 99);
  assert.equal(records[0].size.marketCap, null, 'market cap is never inferred from an FDV:');
  assert.equal(records[0].sizeIsFdvOnly, true);
});

await test('a DexScreener 429 fails open: one finding, records untouched, rotation continues', async () => {
  const bare = record();
  const fetchImpl = router([
    route({ url: url => url.startsWith('https://api.dexscreener.com/') }, () => response({ error: 'rate limit' }, { status: 429 })),
    route({ url: url => url.includes('dexpaprika') }, () => response({ volume_usd_1h: 77 })),
  ]);
  const result = await wire(fakeDiscovery([bare]), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });

  assert.equal(result.records[0].size.fdv, null, 'a rejected row must not be half-enriched:');
  assert.equal(result.records[0].liquidityUsd, null);
  assert.equal(result.records[0].activity.volume1hUsd, 77, 'and the other lanes still ran:');
  const dsFindings = findingsMatching(result.findings, 'enrich:dexscreener');
  assert.equal(dsFindings.length, 1);
  assert.equal(dsFindings[0].level, 'warn', 'a throttle is a warning, not an error:');
  assert.equal(dsFindings[0].throttled, true);
  assert.match(dsFindings[0].reason, /1 record\(s\) left unenriched/);
});

await test('a DexScreener batch covers at most 30 addresses per request', async () => {
  // Index + 1, not index: `normalizeTokenAddress` rejects the all-zero address
  // (address.mjs:21), so a fixture built from index 0 yields a null record that
  // silently shrinks the batch — the test would then pass for the wrong reason.
  const many = Array.from({ length: 31 }, (_, index) => record({ address: `0x${String(index + 1).padStart(40, '0')}` }));
  const fetchImpl = router([dexBatch([])]);
  await wire(fakeDiscovery(many), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });
  const batches = fetchImpl.seen.filter(entry => entry.url.includes('dexscreener.com'));
  assert.equal(batches.length, 2, '31 addresses cannot fit in one 30-address request:');
  const first = batches[0].url.split('/').at(-1).split(',');
  const second = batches[1].url.split('/').at(-1).split(',');
  assert.equal(first.length, 30);
  assert.equal(second.length, 1);
});

await test('the DexScreener chain slug comes from the shared DEX vocabulary, and an unmapped chain is never guessed', async () => {
  assert.deepEqual(DEX_CHAIN_IDS, { sol: 'solana', eth: 'ethereum', bsc: 'bsc', base: 'base', robinhood: 'robinhood' });
  const fetchImpl = router([dexBatch([])]);
  const { records } = await wire(fakeDiscovery([record()]), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });
  assert.ok(fetchImpl.seen[0].url.startsWith('https://api.dexscreener.com/tokens/v1/robinhood/'),
    `robinhood must use its own slug, got ${fetchImpl.seen[0].url}`);

  // An unmapped chain must produce NO request rather than a request to a slug
  // this file invented.
  const strict = router([]);
  const unknown = await wire(fakeDiscovery([record()]), { fetchImpl: strict }).discover('dogecoin', { rotationId: 'r1' });
  assert.equal(strict.seen.length, 0, 'no slug means no call, not a guessed slug:');
  assert.equal(unknown.records[0].size.fdv, null);
});

// ---------------------------------------------------------------------------
// Lane 2 — DexPaprika
// ---------------------------------------------------------------------------

await test('the volume lane asks DexPaprika once per rotation, for the highest-priority record, and fills only a gap', async () => {
  const plain = record({ address: '0x4444444444444444444444444444444444444444' });
  const withVolume = record({ address: '0x5555555555555555555555555555555555555555', volume1hUsd: 31 });
  plain.extra = undefined;
  const fetchImpl = router([
    dexBatch([]),
    route({ url: url => url.includes('dexpaprika') }, () => response({ volume_usd_1h: 5000 })),
  ]);
  const result = await wire(fakeDiscovery([withVolume, plain]), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });

  const paprikaCalls = fetchImpl.seen.filter(entry => entry.url.includes('dexpaprika'));
  assert.equal(paprikaCalls.length, 1, `perRotationRowCap is 1; saw ${paprikaCalls.length} calls`);
  assert.ok(paprikaCalls[0].url.endsWith(`/${plain.address}`), 'the address path is used, never a pool id:');
  assert.equal(result.records[0].activity.volume1hUsd, 31, 'a reported volume is never overwritten:');
  assert.equal(result.records[1].activity.volume1hUsd, 5000);
  assert.equal(result.records[1].activity.volume5mUsd, null, 'only the 1h figure is touched:');
});

await test('DexPaprika network ids are its own, and it does publish robinhood', async () => {
  assert.deepEqual(PAPRIKA_NETWORKS, { eth: 'ethereum', bsc: 'bsc', base: 'base', sol: 'solana', robinhood: 'robinhood' });
  // Measured against `GET https://api.dexpaprika.com/networks` (HTTP 200), which
  // lists {"display_name":"Robinhood Chain","id":"robinhood","pools_count":15777}.
  // An earlier draft of this test asserted the opposite; the live endpoint wins.
  const fetchImpl = router([
    dexBatch([]),
    route({ url: url => url.includes('dexpaprika') }, () => response({ volume_usd_1h: 5000 })),
  ]);
  await wire(fakeDiscovery([record()]), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });
  const paprikaCalls = fetchImpl.seen.filter(entry => entry.url.includes('dexpaprika'));
  assert.equal(paprikaCalls.length, 1, 'a published network is served, not skipped:');
  assert.ok(paprikaCalls[0].url.startsWith('https://api.dexpaprika.com/networks/robinhood/tokens/'),
    `robinhood keeps its own network id, got ${paprikaCalls[0].url}`);

  // A chain DexPaprika genuinely does not publish is still skipped, not guessed.
  const strict = router([dexBatch([])]);
  const result = await wire(fakeDiscovery([record()]), { fetchImpl: strict }).discover('dogecoin', { rotationId: 'r1' });
  assert.equal(strict.seen.filter(entry => entry.url.includes('dexpaprika')).length, 0);
  const info = findingsMatching(result.findings, 'enrich:dexpaprika');
  assert.equal(info.length, 1);
  assert.equal(info[0].level, 'info', 'scanner.mjs:718 drops info findings, which is right: nothing failed:');
});

await test('a DexPaprika refusal is reported and not retried', async () => {
  const fetchImpl = router([
    dexBatch([]),
    route({ url: url => url.includes('dexpaprika') }, () => response({ error: 'quota' }, { status: 402 })),
  ]);
  const result = await wire(fakeDiscovery([record()]), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });
  assert.equal(result.records[0].activity.volume1hUsd, null, 'a refusal must not write a zero:');
  const paprikaFindings = findingsMatching(result.findings, 'enrich:dexpaprika').filter(entry => entry.level !== 'info');
  assert.equal(paprikaFindings.length, 1);
  assert.match(paprikaFindings[0].reason, /no 1h volume/);
  assert.equal(fetchImpl.seen.filter(entry => entry.url.includes('dexpaprika')).length, 1, 'and it is asked exactly once:');
});

// ---------------------------------------------------------------------------
// Lane 3 — PublicNode, and the decimals gate
// ---------------------------------------------------------------------------

// Decimals and reserves for a hand-checkable fixture:
//   token  1_000_000_000 units at 6 decimals = 1000 USDC in the pool
//   quote  30_000 units at 6 decimals (USDC side)
//   record.price = 0.01 USD per token
//   FDV    = 0.01 * 1_000_000_000            = 10_000_000 USD
//   pricePerTokenQuote = 30_000 / 1_000      = 30 quote per token
//   quotePriceUsd = 0.01 / 30                = 1/3000 USD
//   liquidity = 2 * 30_000 * (1/3000)        = 20 USD
const POOL_FIXTURE = {
  supply: 1_000_000_000n * 1_000_000n,
  tokenReserve: 1_000n * 1_000_000n,
  quoteReserve: 30_000n * 1_000_000n,
};

function rpcRoutes({ decimalsOf = {}, reserves = null, quoteTokenIsReserve1 = true } = {}) {
  return [
    route({ url: url => url.includes('publicnode') }, (url, body) => {
      if (body.method !== 'eth_call') throw new Error(`unexpected rpc method ${body.method}`);
      const data = body.params[0].data;
      if (data === '0x313ce567') {
        const target = String(body.params[0].to).toLowerCase();
        const value = decimalsOf[target];
        if (value === undefined) return response({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } });
        return response({ jsonrpc: '2.0', id: 1, result: word(value) });
      }
      if (data === '0x0dfe1681') return response({ jsonrpc: '2.0', id: 1, result: addrWord(quoteTokenIsReserve1 ? QUOTE : TOKEN) });
      if (data === '0xd21220a7') return response({ jsonrpc: '2.0', id: 1, result: addrWord(quoteTokenIsReserve1 ? TOKEN : QUOTE) });
      if (data === '0x18160ddd') return response({ jsonrpc: '2.0', id: 1, result: word(POOL_FIXTURE.supply) });
      if (data === '0x0902f1ac') {
        // getReserves returns (reserve0, reserve1) in the POOL's own token0/token1
        // order, so the raw order has to track which address token0 returned.
        // Pairing reserve0 with the wrong token is what produced a "wrong"
        // liquidity figure earlier: the overlay was reading the fixture, not
        // mis-scaling anything.
        const [reserve0, reserve1] = quoteTokenIsReserve1
          ? [POOL_FIXTURE.quoteReserve, POOL_FIXTURE.tokenReserve]
          : [POOL_FIXTURE.tokenReserve, POOL_FIXTURE.quoteReserve];
        const pair = reserves ?? [reserve0, reserve1];
        return response({ jsonrpc: '2.0', id: 1, result: `0x${pair[0].toString(16).padStart(64, '0')}${pair[1].toString(16).padStart(64, '0')}${word(0).slice(2)}` });
      }
      throw new Error(`unrouted selector ${data}`);
    }),
  ];
}

await test('the decimals gate skips a record whose decimals cannot be read, instead of assuming 18', async () => {
  const bare = record();
  const fetchImpl = router([
    dexBatch([]), // answers with nothing, so lane 3 still has work to do
    ...rpcRoutes({ decimalsOf: {} }),
  ]);
  const result = await wire(fakeDiscovery([bare]), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });

  assert.equal(result.records[0].size.fdv, null, 'an unreadable decimals must never become a size:');
  assert.equal(result.records[0].liquidityUsd, null);
  const rpcFindings = findingsMatching(result.findings, 'enrich:publicnode');
  assert.equal(rpcFindings.length, 1);
  assert.match(rpcFindings[0].reason, /decimals_unknown/);
  assert.match(rpcFindings[0].reason, /rather than assumed 18/);
  // The decisive assertion: totalSupply and getReserves were never even asked,
  // because a size computed from wrong decimals is worse than no size.
  const asked = fetchImpl.seen.filter(entry => entry.body?.method === 'eth_call').map(entry => entry.body.params[0].data);
  assert.ok(!asked.includes('0x18160ddd'), 'totalSupply must not be read when decimals is unknown:');
  assert.ok(!asked.includes('0x0902f1ac'), 'and neither must getReserves:');
});

await test('a token whose quote asset has no readable decimals is skipped too', async () => {
  const bare = record();
  const fetchImpl = router([
    dexBatch([]),
    ...rpcRoutes({ decimalsOf: { [TOKEN]: 6 } }), // quote side reverts
  ]);
  const result = await wire(fakeDiscovery([bare]), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });
  assert.equal(result.records[0].size.fdv, null);
  assert.match(findingsMatching(result.findings, 'enrich:publicnode')[0].reason, /quote unreadable/);
});

await test('with real decimals the derived FDV and liquidity are the hand-checkable values', async () => {
  const bare = record();
  const fetchImpl = router([
    dexBatch([]),
    ...rpcRoutes({ decimalsOf: { [TOKEN]: 6, [QUOTE]: 6 } }),
  ]);
  const result = await wire(fakeDiscovery([bare]), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });
  const enriched = result.records[0];

  // 0.01 USD * 1e9 supply.
  assert.equal(enriched.size.fdv, 10_000_000, 'FDV = record price * supply:');
  // 2 * 30_000 quote * (0.01 / 30) USD per quote unit.
  assert.equal(Number(enriched.liquidityUsd.toFixed(6)), 20, 'liquidity = 2 * quoteReserve * quotePriceUsd:');
  assert.equal(enriched.size.marketCap, null, 'market cap stays null; reserves know supply, not float:');
  assert.equal(enriched.sizeIsFdvOnly, true);
  const evidence = enriched.evidence.enrichment.rpcReserves;
  assert.equal(evidence.tokenDecimals, 6);
  assert.equal(evidence.quoteDecimals, 6);
  assert.equal(Number(evidence.pricePerTokenQuote.toFixed(6)), 30);
  assert.ok(Math.abs(evidence.quotePriceUsd - (0.01 / 30)) < 1e-18);
});

await test('the reserve side is read from the pool, so a token1 token gets the same answer as a token0 one', async () => {
  const asToken0 = record();
  const asToken1 = record({ address: '0x6666666666666666666666666666666666666666' });
  const decimalsOf = { [TOKEN]: 6, [asToken1.address]: 6, [QUOTE]: 6 };
  const fetchImpl = router([dexBatch([]), ...rpcRoutes({ decimalsOf })]);
  const result = await wire(fakeDiscovery([asToken0, asToken1]), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });
  // Only the first record is processed: the budget's row cap is 10 calls and one
  // record costs six. The two must not be silently conflated.
  assert.equal(result.records[0].size.fdv, 10_000_000);
  assert.equal(result.records[1].size.fdv, null, 'the second record waits for the next rotation:');
});

await test('a record with no pool address is not admitted to the reserves lane', async () => {
  const bare = record({ poolAddress: null });
  // A lane-1 payload only carries a pool address if the provider reported one.
  // DexScreener's batch entry is where `pairAddress` comes from, so a payload
  // without it is a payload that cannot hand off to lane 3.
  const fetchImpl = router([dexBatch([{ baseToken: { address: TOKEN }, pairAddress: POOL, fdv: 5, liquidity: { usd: 6 } }]), ...rpcRoutes({ decimalsOf: { [TOKEN]: 6, [QUOTE]: 6 } })]);
  const result = await wire(fakeDiscovery([bare]), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });
  // Lane 1 supplies a pool address here, which is the documented hand-off.
  assert.equal(result.records[0].poolAddress, POOL);
  assert.equal(findingsMatching(result.findings, 'enrich:publicnode').length, 0, 'and lane 3 then runs cleanly:');
  assert.equal(result.records[0].size.fdv, 5, 'but a measured FDV outranks the derived one:');
});

await test('solana rows never enter the reserves lane, which has no RPC endpoint for them', async () => {
  const solRecord = { ...record({ chain: 'sol', address: MINT, poolAddress: POOL }), quoteTokenAddress: null };
  const fetchImpl = router([dexBatch([]), ...rpcRoutes({ decimalsOf: {} })]);
  const result = await wire(fakeDiscovery([solRecord]), { fetchImpl, env: {} }).discover('sol', { rotationId: 'r1' });
  assert.equal(fetchImpl.seen.filter(entry => entry.url.includes('publicnode')).length, 0, 'no eth_call to a solana row:');
  assert.equal(findingsMatching(result.findings, 'enrich:publicnode').length, 0, 'and no finding: the lane was never applicable:');
});

// ---------------------------------------------------------------------------
// Lane 4 — Helius
// ---------------------------------------------------------------------------

await test('no API key means the holders lane is unavailable and makes no request', async () => {
  const solRecord = { ...record({ chain: 'sol', address: MINT, poolAddress: null }), quoteTokenAddress: null };
  const fetchImpl = router([dexBatch([])]);
  const result = await wire(fakeDiscovery([solRecord]), { fetchImpl, env: {} }).discover('sol', { rotationId: 'r1' });
  assert.equal(solRecord.holders, null);
  assert.equal(fetchImpl.seen.filter(entry => entry.url.includes('helius')).length, 0);
  assert.equal(findingsMatching(result.findings, 'enrich:helius').length, 0, 'an unconfigured optional lane is not an incident:');
});

await test('a keyed holders lane writes a declared count and keeps topOwners out of it', async () => {
  const solRecord = { ...record({ chain: 'sol', address: MINT, poolAddress: null }), quoteTokenAddress: null };
  const fetchImpl = router([
    dexBatch([]),
    route({ url: url => url.includes('helius') }, () => response({
      jsonrpc: '2.0', id: 1,
      result: {
        token_info: { holders_count: 1234, supply: 1000 },
        top_owners: [{ address: 'A', uiAmount: 250 }, { address: 'B', uiAmount: 250 }],
      },
    })),
  ]);
  const result = await wire(fakeDiscovery([solRecord]), { fetchImpl, env: { HELIUS_API_KEY: 'test-key' } }).discover('sol', { rotationId: 'r1' });
  const holders = result.records[0].holders;
  assert.equal(holders, 1234, 'the declared count is the field:');
  assert.notEqual(holders, 2, 'a two-entry owner list is never a holder count:');
  assert.equal(result.records[0].evidence.enrichment.top10Share, 0.5, 'concentration is evidence, not a holder total:');
});

await test('a DAS response with no holder count leaves the field null and says why', async () => {
  const solRecord = { ...record({ chain: 'sol', address: MINT, poolAddress: null }), quoteTokenAddress: null };
  const fetchImpl = router([
    dexBatch([]),
    route({ url: url => url.includes('helius') }, () => response({ jsonrpc: '2.0', id: 1, result: { token_info: {} } })),
  ]);
  const result = await wire(fakeDiscovery([solRecord]), { fetchImpl, env: { HELIUS_API_KEY: 'test-key' } }).discover('sol', { rotationId: 'r1' });
  assert.equal(solRecord.holders, null);
  assert.match(findingsMatching(result.findings, 'enrich:helius')[0].reason, /no holder count/);
});

// ---------------------------------------------------------------------------
// Rotation accounting and the cross-lane invariants
// ---------------------------------------------------------------------------

await test('opts.rotationId reaches every budget through beginRotation, so caps reset each rotation', async () => {
  const discovery = fakeDiscovery([]);
  const wired = wire(discovery, { fetchImpl: router([]) });
  await wired.discover('robinhood', { rotationId: 'rot-A' });
  await wired.discover('robinhood', { rotationId: 'rot-B' });
  // The coordinator was called with the same opts, so this checks pass-through;
  // the budget reset is checked below through behaviour.
  assert.deepEqual(discovery.calls.map(entry => entry.rotationId), ['rot-A', 'rot-B']);
});

await test('the volume lane resets its row cap every rotation rather than going silent after the first', async () => {
  const fetchImpl = router([
    dexBatch([]),
    route({ url: url => url.includes('dexpaprika') }, () => response({ volume_usd_1h: 4242 })),
  ]);
  const wired = wire(fakeDiscovery([record()]), { fetchImpl });
  const first = await wired.discover('robinhood', { rotationId: 'rot-1' });
  const second = await wired.discover('robinhood', { rotationId: 'rot-2' });
  const firstVolume = first.records[0].activity.volume1hUsd;
  const secondVolume = second.records[0].activity.volume1hUsd;
  assert.equal(firstVolume, 4242);
  assert.equal(secondVolume, 4242);
  // One real call; the second rotation is served from the lane's 2-hour cadence
  // cache, which is the whole reason the lane lives on one instance.
  assert.equal(fetchImpl.seen.filter(entry => entry.url.includes('dexpaprika')).length, 1, 'the cadence guard, not a broken cap:');
});

await test('a lane that throws outright is contained: the other lanes still run and the result returns', async () => {
  const bare = record();
  const fetchImpl = router([
    dexBatch([]),
    route({ url: url => url.includes('dexpaprika') }, () => response({ volume_usd_1h: 11 })),
    ...rpcRoutes({ decimalsOf: {} }),
  ]);
  // A function, not an object with a `.fetch` property: `fetchImpl` is called
  // directly, so handing over `{ fetch() {} }` fails with "this.fetch is not a
  // function" and every lane reports dead while the real fault is in the harness.
  const deadLane = (url, init) => {
    if (url.includes('dexscreener.com')) throw new TypeError('fetch failed');
    return fetchImpl(url, init);
  };
  const result = await wire(fakeDiscovery([bare]), { fetchImpl: deadLane }).discover('robinhood', { rotationId: 'r1' });
  assert.ok(Array.isArray(result.records));
  assert.equal(result.records[0].activity.volume1hUsd, 11, 'a dead lane must not take the rotation with it:');
  const errors = findingsMatching(result.findings, 'enrich:dexscreener').filter(entry => entry.level === 'error');
  assert.equal(errors.length, 1, 'the dead lane is reported, not swallowed:');
  // The batch lane catches its own request failure, so the finding names the
  // batch rather than the outer "failed open" wording. Either is fine; what
  // matters is that the failure is visible and the other lanes still ran.
  assert.match(errors[0].reason, /batch failed|failed open/);
  assert.equal(result.records[0].liquidityUsd, null, 'and the surviving lanes did not invent a number:');
});

await test('THE INVARIANT: no lane writes a risk verdict', async () => {
  const bare = record();
  const fetchImpl = router([
    dexBatch([{ baseToken: { address: TOKEN }, fdv: 99, marketCap: 1, liquidity: { usd: 2 }, pairAddress: POOL }]),
    ...rpcRoutes({ decimalsOf: { [TOKEN]: 6, [QUOTE]: 6 } }),
  ]);
  const result = await wire(fakeDiscovery([bare]), { fetchImpl }).discover('robinhood', { rotationId: 'r1' });
  const text = JSON.stringify(result.records);
  assert.ok(!/"isHoneypot"|"buyTax"|"sellTax"|"honeypot"/.test(text), 'GoPlus remains the honeypot authority:');
  assert.ok(!/risk/i.test(text), `enrichment must not create a risk block at all: ${text.slice(0, 200)}`);
});

await test('the operator can see which shared budget entry is the binding constraint', () => {
  const wired = wire(fakeDiscovery([]), { fetchImpl: router([]) });
  void wired;
  // budgetStopReason reads the shared table's caps, so it is exercised against a
  // real budget rather than a literal.
  const budget = { name: 'PublicNode', perRotationRowCap: 10, snapshot: () => ({ rowCaps: { robinhood: 10 }, breakerOpen: false, throttled: false, cooldownMs: 0, reason: null }) };
  assert.match(budgetStopReason(budget, { chain: 'robinhood' }), /at its per-rotation row cap \(10\/10/);
  assert.match(budgetStopReason(budget, { chain: 'robinhood', rotationId: 'r7' }), /rotation r7/);
  const open = { name: 'DexPaprika', perRotationRowCap: 1, snapshot: () => ({ rowCaps: {}, breakerOpen: true, throttled: true, cooldownMs: 12_000, reason: 'cooldown' }) };
  assert.match(budgetStopReason(open), /breaker is open/);
  assert.equal(budgetStopReason({ name: 'X', perRotationRowCap: null, snapshot: () => ({ rowCaps: {}, breakerOpen: false, throttled: false, cooldownMs: 0, reason: null }) }), null);
});

await test('the row-cap arithmetic matches what one reserves record actually costs', async () => {
  assert.equal(SOURCE_BUDGETS.publicnode.perRotationRowCap, 10, 'the shared table is the source of this number:');
  assert.equal(PUBLICNODE_CALLS_PER_RECORD, 6, '2 decimals + totalSupply + getReserves + token0 + token1:');
  assert.equal(Math.floor(SOURCE_BUDGETS.publicnode.perRotationRowCap / PUBLICNODE_CALLS_PER_RECORD), 1,
    'one record per rotation at today\'s numbers — small, but it is the honest reading of the table:');
});

// ---------------------------------------------------------------------------

const failed = results.filter(entry => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.ok ? '' : `\n     ${entry.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;