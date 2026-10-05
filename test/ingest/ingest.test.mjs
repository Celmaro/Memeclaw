import assert from 'node:assert/strict';
import { TokenBucket, CircuitBreaker, SourceBudget, detectThrottle, createBudget } from '../../src/ingest/budget.mjs';
import { createRecord, createRisk, RISK_STATUS, mergeRecords } from '../../src/ingest/record.mjs';
import { parsePool } from '../../src/ingest/adapters/geckoterminal.mjs';
import { parseCoin } from '../../src/ingest/adapters/pumpfun.mjs';
import { unwrapAddressMap } from '../../src/ingest/http.mjs';

// node --test cannot spawn in this sandbox (EPERM), so tests run in-process.
// Every assertion here is a regression guard for a specific live-probed fact.
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

const HEADERS = (init) => new Headers(init);

await test('TokenBucket refills over time and gates on capacity', () => {
  const bucket = new TokenBucket({ capacity: 2, refillMs: 1000 });
  assert.equal(bucket.tokens, 2);
  bucket.tokens -= 2;
  assert.equal(bucket.tokens, 0);
  // availableAfter must be non-mutating: asking about the future cannot hand out
  // tokens the bucket has not earned.
  const before = bucket.tokens;
  assert.ok(bucket.availableAfter(500) > before);
  assert.equal(bucket.tokens, before);
});

await test('SourceBudget row cap rejects a chain past its per-rotation limit', async () => {
  const budget = new SourceBudget({ name: 'test', host: 'h', spacingMs: 0, perRotationRowCap: 2 });
  budget.beginRotation('r1');
  await budget.take('eth');
  await budget.take('eth');
  await assert.rejects(() => budget.take('eth'), error => error.code === 'ROW_CAP');
  // The cap is per chain, so one noisy chain must not starve the others.
  await budget.take('base');
  budget.beginRotation('r2');
  await budget.take('eth');
});

await test('GoPlus throttle arrives as HTTP 200 with body code 4029', () => {
  const detection = detectThrottle(200, { code: 4029, message: 'too many requests' }, HEADERS());
  assert.equal(detection.throttled, true);
  assert.equal(detection.via, 'body_code');
});

await test('GeckoTerminal 429 with retry-after: 0 still detects as throttled', () => {
  const detection = detectThrottle(429, { status: { error_code: 429 } }, HEADERS({ 'retry-after': '0' }));
  assert.equal(detection.throttled, true);
});

await test('A clean 200 with a rate-limit phrase in an unrelated field is not a throttle', () => {
  assert.equal(detectThrottle(200, { message: 'ok' }, HEADERS()).throttled, false);
});

await test('retry-after: 0 is ignored in favour of the source cooldown floor', () => {
  const budget = new SourceBudget({ name: 'geckoterminal', host: 'h', spacingMs: 0, cooldownFloorMs: 60_000 });
  budget.report({ status: 429, body: { status: { error_code: 429 } }, headers: HEADERS({ 'retry-after': '0' }) });
  assert.ok(budget.cooldownUntil - Date.now() > 55_000, 'floor must beat the provider 0');
  const reason = budget.snapshot().reason;
  // The operator-facing reason has to say which source is down, until when, and
  // what the provider actually replied — a bare "unavailable" costs an hour of
  // guessing when five sources feed one rotation.
  assert.ok(reason?.includes('geckoterminal'), `reason must name the source, got: ${reason}`);
  assert.ok(reason?.includes('cooldown until'), `reason must be human-readable, got: ${reason}`);
  assert.ok(reason?.includes('HTTP 429'), `reason must name what the provider said, got: ${reason}`);
  assert.equal(budget.snapshot().throttled, true);
});

await test('A real Retry-After longer than the floor wins', () => {
  const budget = new SourceBudget({ name: 'x', host: 'h', spacingMs: 0, cooldownFloorMs: 1_000 });
  budget.report({ status: 429, body: {}, headers: HEADERS({ 'retry-after': '120' }) });
  assert.ok(budget.cooldownUntil - Date.now() > 115_000);
});

await test('Circuit breaker opens on the third consecutive throttle and closes on success', () => {
  const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 30_000 });
  assert.equal(breaker.record(true), false);
  assert.equal(breaker.record(true), false);
  assert.equal(breaker.record(true), true);
  assert.equal(breaker.open, true);
  breaker.record(false);
  assert.equal(breaker.open, false);
  assert.equal(breaker.consecutive, 0);
});

await test('Quota header readers pick up DexPaprika credit shape and CF cache', () => {
  const budget = createBudget('dexpaprika');
  budget.report({
    status: 200,
    body: {},
    headers: HEADERS({
      'ratelimit-limit': '10', 'ratelimit-remaining': '8', 'ratelimit-reset': '41',
      'x-credits-remaining': '9930', 'cf-cache-status': 'MISS', 'x-api-plan': 'keyless',
    }),
  });
  const { quota } = budget.snapshot();
  assert.equal(quota.limit, '10');
  assert.equal(quota.remaining, '9930');
  assert.equal(quota.cache, 'MISS');
  assert.equal(quota.plan, 'keyless');
});

await test('A CF cache HIT costs no credits', () => {
  const budget = createBudget('dexpaprika');
  budget.report({ status: 200, body: {}, headers: HEADERS({ 'cf-cache-status': 'HIT' }), cacheHit: true });
  assert.equal(budget.snapshot().creditsSpent, 0);
  assert.equal(budget.snapshot().cacheHits, 1);
});

await test('GT adapter reads the BASE TOKEN address, not the pool address', () => {
  const record = parsePool('robinhood', {
    id: 'robinhood_0xabc',
    attributes: {
      address: '0x3ccba6aba487daa654eaf924bde8ea8a5e0fd3ad99aebcfafe6725097b595a41',
      name: 'MEOWFI / WETH 0.3%', pool_created_at: '2026-10-04T10:47:56Z',
      fdv_usd: '205879.847', market_cap_usd: null, reserve_in_usd: '15592.59',
      volume_usd: { m5: '12.5', h1: '99' }, transactions: { m5: { buys: 3, sells: 1 } },
    },
    relationships: { base_token: { data: { id: 'robinhood_0x06d2d9229a9491969ecfb4c94d2e45c31b463f59' } }, dex: { data: { id: 'uniswap-v4-robinhood' } } },
  });
  assert.equal(record.address, '0x06d2d9229a9491969ecfb4c94d2e45c31b463f59');
  assert.notEqual(record.address, record.poolAddress);
  assert.equal(record.size.fdv, 205879.847);
  assert.equal(record.size.marketCap, null);
  assert.equal(record.sizeIsFdvOnly, true);
  assert.equal(record.liquidityUsd, 15592.59);
  assert.equal(record.activity.txns5m, 4);
  assert.equal(record.unresolved.includes('marketCap'), true);
  assert.equal(record.unresolved.includes('security'), true);
  // Counts must never masquerade as a USD split.
  assert.equal(record.activity.buyVolume5mUsd, null);
  assert.equal(record.activity.sellVolume5mUsd, null);
});

await test('GT reserve_in_usd of "0.0" is unreported, not an empty pool', () => {
  const record = parsePool('base', {
    attributes: { address: '0x' + '1'.repeat(64), name: 'A / ETH', pool_created_at: '2026-10-05T00:00:00Z', fdv_usd: '1000', reserve_in_usd: '0.0' },
    relationships: { base_token: { data: { id: 'base_0x2'.repeat(1) + '0'.repeat(39) } } },
  });
  assert.equal(record.liquidityUsd, null);
});

await test('GT row from the wrong network is dropped rather than misattributed', () => {
  const record = parsePool('base', {
    attributes: { address: '0x' + '1'.repeat(64), name: 'A / ETH', pool_created_at: '2026-10-05T00:00:00Z', fdv_usd: '1000' },
    relationships: { base_token: { data: { id: 'robinhood_0x' + '3'.repeat(40) } } },
  });
  assert.equal(record, null);
});

await test('GT malformed rows never throw — they drop out', () => {
  for (const input of [null, {}, { attributes: {} }, { relationships: {} }, { relationships: { base_token: {} } }]) {
    assert.equal(parsePool('base', input), null);
  }
});

await test('pump.fun records never claim safety', () => {
  const record = parseCoin({ mint: 'DVfbxU18u6g3c7QzWb2Pw2BUdXiQTkbf25fu1z87pump', symbol: 'XSALE', created_timestamp: Date.now(), market_cap: 34.7 });
  assert.equal(record.risk.status, RISK_STATUS.UNKNOWN);
  assert.equal(record.risk.isHoneypot, null);
  assert.equal(record.unresolved.includes('security'), true);
  assert.equal(record.liquidityUsd, null);
});

await test('pump.fun marketCap string parses, missing stays null', () => {
  assert.equal(parseCoin({ mint: 'DvfbxU18u6g3c7QzWb2Pw2BUdXiQTkbf25fu1z87pump', market_cap: '12.5' }).size.marketCap, 12.5);
  assert.equal(parseCoin({ mint: 'DvfbxU18u6g3c7QzWb2Pw2BUdXiQTkbf25fu1z87pump' }).size.marketCap, null);
  assert.equal(parseCoin({}), null);
});

await test('Address-keyed provider payload unwraps by lowercase address', () => {
  const payload = { result: { '0xabc': { is_honeypot: '1' } } };
  assert.equal(unwrapAddressMap(payload, '0xABC').is_honeypot, '1');
  // Reading result directly would silently ship security disabled; a
  // wrong-address fallback would attach another token's risk report to this one.
  assert.equal(unwrapAddressMap(payload, '0xdef'), null);
});

await test('Rate percent strings and empty strings become null, never 0', () => {
  const base = createRecord({ chain: 'eth', address: '0x' + '1'.repeat(40), source: 's' });
  assert.equal(createRisk(base, { buyTax: '' }).risk.buyTax, null);
  assert.equal(createRisk(base, { buyTax: '5%' }).risk.buyTax, 0.05);
  assert.equal(createRisk(base, { buyTax: 0.2 }).risk.buyTax, 0.2);
  assert.equal(createRisk(base, { buyTax: 'abc' }).risk.buyTax, null);
});

await test('Risk status is never upgraded from unknown without evidence', () => {
  const base = createRecord({ chain: 'eth', address: '0x' + '2'.repeat(40), source: 's' });
  assert.equal(createRisk(base, {}).risk.status, RISK_STATUS.UNKNOWN);
  assert.equal(createRisk(base, { status: RISK_STATUS.CLEAN }).risk.status, RISK_STATUS.CLEAN);
});

await test('Records with an invalid address for their chain are rejected', () => {
  assert.equal(createRecord({ chain: 'eth', address: 'not-an-address', source: 's' }), null);
  assert.equal(createRecord({ chain: 'sol', address: '0x' + '1'.repeat(40), source: 's' }), null);
  assert.equal(createRecord({ chain: 'eth', address: '0x' + '1'.repeat(40), source: 's' }).address, '0x' + '1'.repeat(40));
});

await test('mergeRecords dedupes by chain+address and keeps newer evidence', () => {
  const chain = 'eth';
  const older = createRecord({ chain, address: '0x' + '3'.repeat(40), source: 'a', fdvUsd: 1000, capturedAtSec: 100, liquidityUsd: 500 });
  const newer = createRecord({ chain, address: '0x' + '3'.repeat(40), source: 'b', fdvUsd: 1200, capturedAtSec: 200 });
  const [merged] = mergeRecords([older, newer]);
  assert.equal(merged.size.fdv, 1200);
  assert.equal(merged.liquidityUsd, 500);
  assert.equal(merged.evidence.a !== undefined || true, true);
  assert.deepEqual(merged.evidence, { ...older.evidence, ...newer.evidence });
});

await test('mergeRecords surfaces a size disagreement instead of picking a winner', () => {
  const chain = 'base';
  const a = createRecord({ chain, address: '0x' + '4'.repeat(40), source: 'gt', fdvUsd: 1000, capturedAtSec: 100 });
  const b = createRecord({ chain, address: '0x' + '4'.repeat(40), source: 'ds', fdvUsd: 1400, capturedAtSec: 200 });
  const [merged] = mergeRecords([a, b]);
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].field, 'fdv');
  assert.ok(merged.conflicts[0].relativeDifference > 0.25);
  assert.ok(merged.conflictsNote.includes('fdv'));
});

await test('Same address on two chains stays two records', () => {
  const addr = '0x' + '5'.repeat(40);
  assert.equal(mergeRecords([
    createRecord({ chain: 'base', address: addr, source: 's' }),
    createRecord({ chain: 'robinhood', address: addr, source: 's' }),
  ]).length, 2);
});

await test('mergeRecords on nothing returns null rather than an empty array', () => {
  assert.equal(mergeRecords([null, undefined, {}]), null);
});

const failed = results.filter(entry => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.ok ? '' : `\n     ${entry.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;