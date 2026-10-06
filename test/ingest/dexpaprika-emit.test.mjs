// Tests for the DexPaprika tokens/search discovery emitter: envelope key is
// `results` (NOT pools/tokens — reading the wrong key reports "0 rows" against
// a body that contains them), ISO created_at → seconds, fdv-only sizing stays
// LABELLED, an empty feed is an info finding rather than an error, and the
// Bearer key rides only when present.

import assert from 'node:assert/strict';
import { parseTokenRow, createDexPaprikaEmitter } from '../../src/ingest/adapters/dexpaprika.mjs';
import { toDiscoveryRow } from '../../src/ingest/row-contract.mjs';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

// Shape from the live robinhood capture (2026-10): tokens/search rows.
const ROW = {
  address: '0x52c4000000000000000000000000000000000003',
  fdv_usd: 1197111.6464078696,
  liquidity_usd: 199340.9573620682,
  volume_usd_24h: 513787.897,
  txns_24h: 1055,
  created_at: '2026-10-05T12:29:19Z',
};

await test('token row: ISO → epoch seconds, fdv-only sizing stays labelled, security unresolved', () => {
  const record = parseTokenRow(ROW, { chain: 'robinhood', capturedAtSec: 1_800_000_000 });
  assert.ok(record);
  assert.equal(record.source, 'dexpaprika');
  assert.equal(record.pairCreatedAtSec, Math.round(Date.parse('2026-10-05T12:29:19Z') / 1000));
  assert.equal(record.size.fdv, 1197111.6464078696);
  assert.equal(record.size.marketCap, null, 'rows carry fdv_usd and no market_cap — never renamed');
  assert.equal(record.sizeIsFdvOnly, true, 'the label the screen substitutes a FDV basis under');
  assert.equal(record.liquidityUsd, 199340.9573620682);
  assert.equal(record.evidence.volume24hUsd, 513787.897);
  assert.ok(record.unresolved.includes('security'), 'a market screener never fetched security — provenance, not "no risk"');
  assert.ok(record.unresolved.includes('holders'));
});

await test('row bridge: fdv rides fdv_usd (screen substitutes a labelled basis), no cap invented', () => {
  const row = toDiscoveryRow(parseTokenRow(ROW, { chain: 'robinhood' }));
  assert.equal(row.marketProvider, 'DEXPAPRIKA');
  assert.equal(row.fdv_usd, 1197111.6464078696);
  assert.equal(row.market_cap, null);
  assert.equal(row.liquidity, 199340.9573620682);
  assert.equal(row.volume_24h, 513787.897);
  assert.ok(!('bundler_rate' in row), 'no risk bridge from a screener — absent stays absent');
});

await test('rejects rows without an address; unparseable created_at stays null, never NaN', () => {
  assert.equal(parseTokenRow({ fdv_usd: 1 }), null);
  assert.equal(parseTokenRow(null), null);
  const bad = parseTokenRow({ address: ROW.address, created_at: 'not-a-date' });
  assert.equal(bad.pairCreatedAtSec, null, 'null feeds 创建时间未知 instead of an age of NaN years');
});

await test('enabled(): measured chains only', () => {
  const emitter = createDexPaprikaEmitter({ apiKey: '' });
  for (const chain of ['sol', 'eth', 'bsc', 'base', 'robinhood']) assert.equal(emitter.enabled(chain), true, chain);
  assert.equal(emitter.enabled('tron'), false);
  assert.equal(emitter.provider, 'DEXPAPRIKA');
});

await test('discover(): results envelope, measured URL params, Bearer only when keyed', async () => {
  const calls = [];
  const fakeHttp = {
    async json(url, options) {
      calls.push({ url, options });
      return { data: { results: [ROW], has_next_page: true }, latencyMs: 670 };
    },
  };
  const keyed = createDexPaprikaEmitter({ apiKey: 'PK', http: fakeHttp });
  const findings = [];
  const records = await keyed.discover('robinhood', { out: findings });
  assert.equal(records.length, 1);
  const { url, options } = calls[0];
  assert.ok(url.includes('/networks/robinhood/tokens/search'), 'robinhood is a first-class id here');
  assert.ok(url.includes('order_by=created_at') && url.includes('sort=desc'), 'chronological feed');
  assert.ok(!url.includes('limit='), 'unproven param on this route must stay out');
  assert.equal(options.headers.authorization, 'Bearer PK');
  assert.equal(findings[0].level, 'info');
  assert.ok(findings[0].reason.includes('1/1'));

  calls.length = 0;
  const unkeyed = createDexPaprikaEmitter({ apiKey: '', http: fakeHttp });
  await unkeyed.discover('eth', { out: [] });
  assert.ok(!('authorization' in calls[0].options.headers), 'keyless runs without an auth header');
  assert.ok(calls[0].url.includes('/networks/ethereum/tokens/search'), 'eth is `ethereum` on this source');
});

await test('discover(): an empty feed is an INFO finding, not an error (measured bsc reality)', async () => {
  const emitter = createDexPaprikaEmitter({
    apiKey: '',
    http: { async json() { return { data: { results: [], has_next_page: false }, latencyMs: 400 }; } },
  });
  const findings = [];
  const records = await emitter.discover('bsc', { out: findings });
  assert.deepEqual(records, []);
  assert.equal(findings[0].level, 'info');
  assert.ok(findings[0].reason.includes('0 rows'));
});

await test('discover(): http errors fail open as findings, never throws', async () => {
  const emitter = createDexPaprikaEmitter({
    apiKey: '',
    http: { async json() { const e = new Error('HTTP 404 from api.dexpaprika.com'); throw e; } },
  });
  const findings = [];
  const records = await emitter.discover('sol', { out: findings });
  assert.deepEqual(records, []);
  assert.equal(findings[0].level, 'error');
  assert.equal(findings[0].source, 'dexpaprika');
  assert.ok(findings[0].reason.includes('404'));
});

const failed = results.filter(entry => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.ok ? '' : `\n     ${entry.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
