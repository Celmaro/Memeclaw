import assert from 'node:assert/strict';
import { config } from '../../src/config.mjs';
import { createRecord } from '../../src/ingest/record.mjs';
import { parsePool } from '../../src/ingest/adapters/geckoterminal.mjs';
import { toDiscoveryRow, INGEST_DISCOVERY_PROVIDERS } from '../../src/ingest/row-contract.mjs';
import { DiscoveryCoordinator, createIngestDiscovery } from '../../src/ingest/coordinator.mjs';
import { discoveryScreen } from '../../src/scoring.mjs';
import { allowedDiscoveryRow } from '../../src/scanner.mjs';

// node --test cannot spawn in this sandbox (EPERM), so tests run in-process.
// Every assertion is a regression guard for a measured fact or a seam contract.
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

const NOW_SEC = 1_800_000_000;
const screenConfig = { ...config, chain: 'robinhood' };
const RH_ADDR = '0x0123456789abcdef0123456789abcdef01234567';

function gtRecord(overrides = {}) {
  return createRecord({
    chain: 'robinhood',
    address: RH_ADDR,
    source: 'geckoterminal',
    priceUsd: 0.001,
    fdvUsd: 60_000,
    marketCapUsd: null,
    liquidityUsd: 12_000,
    pairCreatedAtSec: NOW_SEC - 3600,
    volume1hUsd: 5_000,
    volume5mUsd: 400,
    capturedAtSec: NOW_SEC,
    ...overrides,
  });
}

function gtRow(overrides = {}) {
  return { ...toDiscoveryRow(gtRecord()), ...overrides };
}

await test('row contract keeps measured market cap, FDV and seconds apart', () => {
  const row = toDiscoveryRow(gtRecord());
  assert.equal(row.market_cap, null);
  assert.equal(row.fdv_usd, 60_000);
  assert.equal(row.creation_timestamp, NOW_SEC - 3600, 'creation_timestamp must stay seconds: ageSec = nowSec - created');
  assert.equal(row.marketProvider, 'GECKOTERMINAL');
  assert.equal(row.ingestSource, 'geckoterminal');
  assert.equal(row.price, 0.001);
  assert.equal(row.liquidity, 12_000);
  assert.equal(row.volume_1h, 5_000);
  assert.ok(Array.isArray(row.ingestUnresolved));
});

await test('row contract rejects a record without chain/address instead of emitting a partial row', () => {
  assert.equal(toDiscoveryRow(null), null);
  assert.equal(toDiscoveryRow({ chain: 'robinhood' }), null);
});

await test('parsePool captures price_usd and keeps FDV labelled (live GT shape, robinhood)', () => {
  const pool = {
    attributes: {
      name: 'MEOW/WETH',
      address: '0x' + '9'.repeat(40),
      price_usd: '0.0042',
      pool_created_at: new Date((NOW_SEC - 700) * 1000).toISOString(),
      fdv_usd: '60000',
      market_cap_usd: null,
      reserve_in_usd: '12000.5',
      volume_usd: { m5: '500', h1: '4000' },
      transactions: { m5: { buys: 10, sells: 5 } },
    },
    relationships: {
      base_token: { data: { id: 'robinhood_0x' + '4'.repeat(40) } },
      quote_token: { data: { id: 'robinhood_0x' + 'c'.repeat(40) } },
      dex: { data: { id: 'robinhood_uniswap_v4' } },
    },
  };
  const record = parsePool('robinhood', pool, { capturedAtSec: NOW_SEC });
  assert.ok(record, 'robinhood GT id must parse (slug robinhood, omitted from /networks but serving)');
  assert.equal(record.price, 0.0042);
  assert.equal(record.size.marketCap, null);
  assert.equal(record.size.fdv, 60_000);
  assert.equal(record.sizeIsFdvOnly, true);
  assert.equal(record.symbol, 'MEOW');
  assert.equal(record.address, '0x' + '4'.repeat(40), 'token is relationships.base_token, not attributes.address (pool)');
  assert.ok(record.unresolved.includes('security'), 'GT carries no security; the record must say so');
});

await test('discoveryScreen: unknown security is reported in unknownFields, not rejected', () => {
  const screen = discoveryScreen(gtRow(), screenConfig, NOW_SEC);
  assert.equal(screen.pass, true, `expected pass, got: ${screen.reasons.join('；')}`);
  assert.ok(screen.unknownFields.includes('rugRatio'));
  assert.ok(screen.unknownFields.includes('bundler'));
  assert.ok(screen.unknownFields.includes('insider'));
  assert.ok(screen.unknownFields.includes('wash'));
  assert.ok(screen.unknownFields.includes('honeypot'));
  assert.ok(!screen.reasons.some(reason => reason.includes('数据未知')), screen.reasons.join('；'));
  assert.equal(screen.priorityBand, true, '60k sits inside the 20k-80k priority band');
});

await test('discoveryScreen: FDV substitutes for an unreported cap, labelled and banded', () => {
  const screen = discoveryScreen(gtRow(), screenConfig, NOW_SEC);
  assert.equal(screen.mc, 60_000);
  assert.ok(screen.unknownFields.includes('marketCap(fdvBasis)'), 'an FDV pass must not look like a market-cap pass');
  assert.ok(!screen.unknownFields.includes('marketCap'));

  const oversized = discoveryScreen(gtRow({ market_cap: null, fdv_usd: 900_000 }), screenConfig, NOW_SEC);
  assert.equal(oversized.pass, false);
  assert.ok(oversized.reasons.includes('市值不在发现范围'));

  const noSize = discoveryScreen(gtRow({ market_cap: null, fdv_usd: null }), screenConfig, NOW_SEC);
  assert.equal(noSize.pass, false);
  assert.ok(noSize.reasons.includes('市值数据未知'), 'no cap and no FDV stays fail-closed');
});

await test('discoveryScreen: known adverse security still rejects (fail-closed where the fact exists)', () => {
  const rug = discoveryScreen(gtRow({ rug_ratio: 0.5 }), screenConfig, NOW_SEC);
  assert.equal(rug.pass, false);
  assert.ok(rug.reasons.includes('rug风险过高'));

  const bundler = discoveryScreen(gtRow({ bundler_trader_amount_rate: 0.45 }), screenConfig, NOW_SEC);
  assert.ok(bundler.reasons.includes('捆绑机器人占比过高'));

  const honeypot = discoveryScreen(gtRow({ is_honeypot: true }), screenConfig, NOW_SEC);
  assert.ok(honeypot.reasons.includes('检测到貔貅盘'));
});

await test('discoveryScreen: structural gates stay fail-closed', () => {
  const stale = discoveryScreen(gtRow({ creation_timestamp: NOW_SEC - 40 * 86_400 }), screenConfig, NOW_SEC);
  assert.ok(stale.reasons.includes('超过观察年龄上限'));
  const thin = discoveryScreen(gtRow({ liquidity: 500 }), screenConfig, NOW_SEC);
  assert.ok(thin.reasons.includes('流动性不足') || thin.reasons.includes('流动性低于深审门槛'));
  const badAddress = discoveryScreen(gtRow({ address: 'not-an-address' }), screenConfig, NOW_SEC);
  assert.ok(badAddress.reasons.includes('地址格式异常'));
});

await test('seam filter: AVE always admitted, ingest providers only through the registry', () => {
  assert.equal(allowedDiscoveryRow({ marketProvider: 'AVE' }, undefined), true);
  assert.equal(allowedDiscoveryRow({ marketProvider: 'GECKOTERMINAL' }, undefined), false, 'no ingest wired => original single-source behaviour');
  assert.equal(allowedDiscoveryRow({ marketProvider: 'GECKOTERMINAL' }, ['GECKOTERMINAL']), true);
  assert.equal(allowedDiscoveryRow({ marketProvider: 'SMUGGLED' }, ['GECKOTERMINAL']), false);
  assert.equal(allowedDiscoveryRow(null, ['GECKOTERMINAL']), false);
  assert.deepEqual([...INGEST_DISCOVERY_PROVIDERS], ['GECKOTERMINAL']);
});

await test('coordinator fails open per emitter and records observations before the merge', async () => {
  const coordinator = new DiscoveryCoordinator({
    timeoutMs: 500,
    emitters: [
      {
        id: 'a',
        provider: 'PROV_A',
        discover: () => [
          gtRecord(),
          gtRecord({ address: '0x0223456789abcdef0123456789abcdef01234567' }),
        ],
      },
      {
        id: 'b',
        provider: 'PROV_B',
        discover: () => { throw new Error('boom'); },
      },
    ],
  });
  assert.deepEqual(coordinator.providers, ['PROV_A', 'PROV_B']);
  const result = await coordinator.discover('robinhood', { rotationId: 1 });
  assert.equal(result.records.length, 2, 'one failing emitter must not sink the others');
  assert.equal(result.observations.length, 2);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].level, 'error');
  assert.match(result.findings[0].reason, /boom/);
  assert.equal(coordinator.snapshot().records, 2);
});

await test('coordinator merges duplicates but keeps one observation per source', async () => {
  const coordinator = new DiscoveryCoordinator({
    timeoutMs: 500,
    emitters: [
      { id: 'a', provider: 'PROV_A', discover: () => [gtRecord({ capturedAtSec: NOW_SEC - 10 })] },
      { id: 'b', provider: 'PROV_B', discover: () => [gtRecord({ capturedAtSec: NOW_SEC })] },
    ],
  });
  const result = await coordinator.discover('robinhood');
  assert.equal(result.records.length, 1, 'same chain:address must merge, not duplicate');
  assert.equal(result.observations.length, 2, 'provenance survives even when the merge collapses the row');
});

await test('coordinator timeout fails open and the abandoned rejection cannot escape as unhandled', async () => {
  const coordinator = new DiscoveryCoordinator({
    timeoutMs: 30,
    emitters: [{
      id: 'slow',
      provider: 'PROV_S',
      discover: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 120)),
    }],
  });
  const result = await coordinator.discover('robinhood');
  assert.equal(result.records.length, 0);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].reason, /timed out/);
  // Outlive the abandoned promise: if the raced branch were not no-op-caught,
  // node --test would fail this file with an unhandledRejection.
  await new Promise(resolve => setTimeout(resolve, 200));
});

await test('coordinator drops cross-chain contamination from an emitter', async () => {
  const coordinator = new DiscoveryCoordinator({
    timeoutMs: 500,
    emitters: [{
      id: 'a',
      provider: 'PROV_A',
      discover: () => [gtRecord({ chain: 'base' }), gtRecord()],
    }],
  });
  const result = await coordinator.discover('robinhood');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].chain, 'robinhood');
});

await test('createIngestDiscovery registers exactly the probed keyless emitter, with no network at construction', () => {
  const ingest = createIngestDiscovery();
  assert.deepEqual(ingest.providers, ['GECKOTERMINAL']);
  assert.equal(typeof ingest.discover, 'function');
  assert.equal(typeof ingest.beginRotation, 'function');
});

const failed = results.filter(entry => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.ok ? '' : `\n     ${entry.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
