// Tests for the GMGN trenches emitter: the measured row schema, the three-state
// risk bridge (OMIT-if-null — a present-but-null key would make the screen
// reject as 数据未知 instead of reporting unknown evidence), and fail-open
// discovery (a throttle is one finding, never a throw, never a retry).

import assert from 'node:assert/strict';
import { parseTrenchRow, createGmgnEmitter } from '../../src/ingest/adapters/gmgn.mjs';
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

// Fixture shaped from the live robinhood capture (190,625 B / 60 rows, keys
// verbatim); values representative, not copied wholesale.
const ROW = {
  address: '0xee27000000000000000000000000000000000001',
  chain: 'robinhood',
  created_timestamp: 1791261144,
  market_cap: 42000,
  liquidity: 9000,
  price: 0.0001,
  holder_count: 2,
  symbol: 'RTRD2',
  name: 'RTRD Two',
  pool_address: '0x2660000000000000000000000000000000000002',
  volume_24h: 12345,
  buys_24h: 1,
  sells_24h: 0,
  swaps_24h: 1,
  is_honeypot: 'no',
  is_wash_trading: false,
  bundler_trader_amount_rate: 0,
  rat_trader_amount_rate: 0,
  suspected_insider_hold_rate: 0,
  buy_tax: 0.0899,
  sell_tax: 0,
  top_10_holder_rate: 0.5,
  burn_status: 'yes',
  owner_renounced: true,
  open_source: true,
  creator_created_count: 764,
  twitter: 'rtrd',
  telegram: 'https://t.me/rtrd',
  website: 'https://rtrd.example',
  x_user_follower: 120,
  launchpad: 'pump',
  creation_tool: '',
};

await test('measured row: source, cap-not-FDV, seconds, risk UNKNOWN (never CLEAN)', () => {
  const record = parseTrenchRow(ROW, { capturedAtSec: 1_800_000_000 });
  assert.ok(record, 'row parses');
  assert.equal(record.source, 'gmgn');
  assert.equal(record.chain, 'robinhood');
  assert.equal(record.size.marketCap, 42000, 'market_cap is recorded as a measured cap');
  assert.equal(record.size.fdv, null, 'trenches rows carry no fdv — stays null');
  assert.equal(record.sizeIsFdvOnly, false, 'cap present, fdv absent → not an fdv-only claim');
  assert.equal(record.pairCreatedAtSec, 1791261144, 'epoch seconds pass through unchanged');
  assert.equal(record.liquidityUsd, 9000);
  assert.equal(record.holders, 2);
  assert.equal(record.evidence.volume24hUsd, 12345);
  assert.equal(record.risk.status, 'unknown', 'measured-clean-looking values must NOT declare CLEAN');
  assert.equal(record.risk.isHoneypot, false, 'is_honeypot: "no" → measured false');
  assert.equal(record.risk.bundlerRate, 0);
  assert.equal(record.risk.buyTax, 0.0899);
  assert.ok(record.risk.fieldsPresent >= 5, 'several risk fields measured');
  assert.ok(!record.unresolved.includes('security'), 'measured risk → security is not unresolved');
});

await test('measured adverse values flip status to adverse (honeypot yes)', () => {
  const record = parseTrenchRow({ ...ROW, is_honeypot: 'yes', bundler_trader_amount_rate: 0.42 });
  assert.equal(record.risk.status, 'adverse');
  assert.equal(record.risk.isHoneypot, true);
});

await test('thin row: zero measured risk → unresolved security, UNKNOWN status', () => {
  const record = parseTrenchRow({ address: ROW.address, chain: 'robinhood', created_timestamp: ROW.created_timestamp });
  assert.equal(record.risk.status, 'unknown');
  assert.equal(record.risk.fieldsPresent, 0);
  assert.ok(record.unresolved.includes('security'));
  assert.equal(record.size.marketCap, null);
  assert.ok(record.unresolved.includes('marketCap'));
});

await test('row bridge is three-state: measured values flow, nulls OMIT keys, no rug_ratio invented', () => {
  const row = toDiscoveryRow(parseTrenchRow(ROW, {}));
  assert.equal(row.marketProvider, 'GMGN');
  assert.equal(row.market_cap, 42000);
  assert.equal(row.fdv_usd, null);
  assert.equal(row.volume_24h, 12345, '24h volume rides evidence → screen volume term');
  assert.equal(row.bundler_rate, 0, 'measured zero is a VALUE, not an absence');
  assert.equal(row.rat_trader_amount_rate, 0);
  assert.equal(row.is_honeypot, false);
  assert.equal(row.is_wash_trading, false);
  assert.ok(!('rug_ratio' in row), 'trenches rows have no rug_ratio — absent stays absent');
  assert.ok(!('holder_count' in row) || row.holder_count === 2);

  const thin = toDiscoveryRow(parseTrenchRow({ address: ROW.address, chain: 'robinhood' }, {}));
  assert.ok(!('bundler_rate' in thin), 'null risk must be OMITTED — present-but-null would reject as 数据未知');
  assert.ok(!('is_honeypot' in thin));
  assert.ok(!('rat_trader_amount_rate' in thin));
  assert.equal(thin.market_cap, null, 'no cap → key present but null feeds 市值数据未知 (screen rule), no fabrication');
});

await test('rejects rows without an address; accepts ms timestamps defensively', () => {
  assert.equal(parseTrenchRow({ chain: 'robinhood' }), null);
  assert.equal(parseTrenchRow(null), null);
  const ms = parseTrenchRow({ ...ROW, created_timestamp: 1791261144000 });
  assert.equal(ms.pairCreatedAtSec, 1791261144, 'epoch ms normalized to seconds');
});

await test('enabled(): false without key or for an unmeasured chain', () => {
  const unkeyed = createGmgnEmitter({ apiKey: '' });
  assert.equal(unkeyed.enabled('robinhood'), false, 'no key → silent skip, not a finding every rotation');
  const keyed = createGmgnEmitter({ apiKey: 'K' });
  assert.equal(keyed.enabled('robinhood'), true);
  assert.equal(keyed.enabled('sol'), true);
  assert.equal(keyed.enabled('tron'), false, 'chain outside measured quote map stays dark');
  assert.equal(keyed.provider, 'GMGN');
});

await test('discover(): envelope parsed, request contract honored (fresh uuid, quote list, X-APIKEY)', async () => {
  const calls = [];
  const fakeHttp = {
    async json(url, options) {
      calls.push({ url, options });
      return { data: { code: 0, data: { new_creation: [ROW] } }, latencyMs: 844 };
    },
  };
  const emitter = createGmgnEmitter({ apiKey: 'SECRET', http: fakeHttp });
  const findings = [];
  const records = await emitter.discover('robinhood', { out: findings });
  assert.equal(records.length, 1);
  assert.equal(records[0].source, 'gmgn');
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.ok(url.includes('chain=robinhood'));
  assert.ok(/timestamp=\d{10}/.test(url), 'unix seconds timestamp');
  assert.ok(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(url), 'fresh UUID client_id');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['X-APIKEY'], 'SECRET', 'key in header, never in URL');
  assert.ok(!url.includes('SECRET'), 'key must never appear in the URL');
  const body = JSON.parse(options.body);
  assert.equal(body.version, 'v2');
  assert.deepEqual(body.new_creation.quote_address_type, [11, 20, 24, 12, 0], 'robinhood quote list from vendor client');
  assert.equal(body.new_creation.limit, 50);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].source, 'gmgn');
  assert.equal(findings[0].level, 'info');
});

await test('discover(): empty envelope warns with code; never throws', async () => {
  const emitter = createGmgnEmitter({
    apiKey: 'K',
    http: { async json() { return { data: { code: 5001, message: 'quota', data: {} }, latencyMs: 3 }; } },
  });
  const findings = [];
  const records = await emitter.discover('sol', { out: findings });
  assert.deepEqual(records, []);
  assert.equal(findings[0].level, 'warn');
  assert.ok(findings[0].reason.includes('5001'));
  assert.ok(findings[0].reason.includes('quota'));
});

await test('discover(): a throttle becomes ONE warn finding, no throw, no retry', async () => {
  let attempts = 0;
  const emitter = createGmgnEmitter({
    apiKey: 'K',
    http: { async json() { attempts += 1; const e = new Error('HTTP 429 from openapi.gmgn.ai'); e.throttled = true; throw e; } },
  });
  const findings = [];
  const records = await emitter.discover('eth', { out: findings });
  assert.deepEqual(records, []);
  assert.equal(attempts, 1, 'retrying during a GMGN cooldown extends the IP ban — exactly one attempt');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].throttled, true);
  assert.equal(findings[0].level, 'warn');
  assert.equal(findings[0].chain, 'eth', 'finding stays chain-attributed');
});

const failed = results.filter(entry => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.ok ? '' : `\n     ${entry.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
