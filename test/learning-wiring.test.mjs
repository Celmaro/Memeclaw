// P5 wiring: the scanner cycle must feed each outcome's FIRST h2 sample into
// the append-only learning log exactly once, and a learning I/O failure must
// surface as an event instead of ever stalling the funnel.
//
// Three seams are asserted here and nowhere else:
//   1. feed fires with the right verdict (WIN / NEUTRAL) and feedKey
//   2. the prior-cycle diff makes a repeat cycle append NOTHING (no log bloat)
//   3. an unreadable state dir is caught: the cycle still completes and a
//      LEARNING event lands in state.events
//
// Disk: every test points settings.stateDir at its own temp location (the
// wiring writes through settings.stateDir, never the real ./state), and cleans
// up afterwards. Zero network: the provider is a literal fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { Scanner } from '../src/scanner.mjs';

const ca = n => '0x' + n.toString(16).padStart(40, '0');
const CA = ca(1);
const CA_NEUTRAL = ca(9);
const POOL = ca(2);
const HOUR2 = 2 * 60 * 60_000;

const tmp = label => fs.mkdtempSync(path.join(os.tmpdir(), `memeclaw-learn-${label}-`));

function rowFor(address, { now, baselineAt, price }) {
  const sourceUpdatedAt = baselineAt + HOUR2 + 60_000; // h2 sample lags 60s — inside the grace window
  return {
    address, chain: 'bsc', marketProvider: 'AVE', symbol: 'MOCK', name: 'Mock',
    market_cap: 50_000, liquidity: 5_000, price,
    creation_timestamp: Math.floor(now / 1000) - 3600,
    pool_created_at: Math.floor(now / 1000) - 3600, first_trade_at: Math.floor(now / 1000) - 3500,
    poolCreatedAt: now - 3600_000, firstTradeAt: now - 3500_000,
    capturedAt: sourceUpdatedAt, sourceUpdatedAt, expiresAt: sourceUpdatedAt + 60_000, stale: false,
    holder_count: 100, volume_5m: 1000, buy_volume_5m: 600, sell_volume_5m: 400,
    buys_5m: 40, sells_5m: 10, buys_24h: 200, sells_24h: 100,
    rug_ratio: null, bundler_rate: null, rat_trader_amount_rate: null, is_honeypot: null, is_wash_trading: null,
    pairAddress: POOL,
    poolEvidence: { source: 'AVE', identityBasis: 'response', chain: 'bsc', pair: POOL, target_token: address,
      token0_address: address, token1_address: ca(3), amm: 'pancakeswap_v2',
      created_at: Math.floor(now / 1000) - 3600, first_trade_at: Math.floor(now / 1000) - 3500,
      tvl: 5000, volume_u_5m: 1000, token0_price_usd: price, token1_price_usd: 1,
      capturedAt: sourceUpdatedAt, sourceUpdatedAt, expiresAt: sourceUpdatedAt + 60_000 },
  };
}

function outcomeFor(address, baselineAt, baselinePrice) {
  return { address, chain: 'bsc', symbol: 'MOCK', baselineAt, baselinePrice,
    baselineProvider: 'AVE', initialDecision: 'X_REVIEW', latestDecision: 'X_REVIEW',
    latestFailed: [], lastAuditedAt: baselineAt, samples: {} };
}

function memoryState(value = {}) {
  return {
    value: { activeChain: 'bsc', candidates: [], auditQueue: [], outcomes: [], events: [],
      riskExclusions: {}, chainStates: {}, sourceHealth: {}, ...value },
    save(next = this.value) { this.value = structuredClone(next); },
  };
}

function readEvents(dir) {
  const file = path.join(dir, 'learning-events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const settingsFor = stateDir => ({ ...config, chain: 'bsc', stateDir, maxDeepAuditsPerCycle: 0 });

test('a fresh h2 sample feeds the learning log: WIN applies, mid-band records NEUTRAL', async () => {
  const dir = tmp('feed');
  try {
    const now = Date.now();
    const baselineWin = now - HOUR2 - 90_000;
    const baselineFlat = now - HOUR2 - 90_000; // same lag: a tighter offset pushes expiresAt onto `now` and the price reads stale
    const state = memoryState({ outcomes: [outcomeFor(CA, baselineWin, 1), outcomeFor(CA_NEUTRAL, baselineFlat, 2)] });
    const provider = { keyEpoch: 0, configured: async () => true,
      discover: async () => [rowFor(CA, { now, baselineAt: baselineWin, price: 1.6 }),
        rowFor(CA_NEUTRAL, { now, baselineAt: baselineFlat, price: 2 })] };
    const scanner = new Scanner({ provider, state, settings: settingsFor(dir) });
    await scanner.cycle();

    const events = readEvents(dir);
    // deriveFeedKey() prefixes explicit keys with `event:` (learning.mjs:186-187).
    const win = events.find(event => event.feedKey === `event:bsc:${CA}:h2`);
    assert.ok(win, 'the WIN outcome must reach learning-events.jsonl');
    assert.equal(win.type, 'OUTCOME_TERMINAL');
    assert.equal(win.applied, true);
    assert.equal(win.outcome.result, 'WIN');
    const flat = events.find(event => event.feedKey === `event:bsc:${CA_NEUTRAL}:h2`);
    assert.ok(flat, 'a mid-band outcome must be recorded as NEUTRAL, not dropped as UNKNOWN');
    assert.equal(flat.type, 'OUTCOME_NEUTRAL');
    assert.equal(flat.applied, false);
    assert.equal(flat.outcome.result, 'NEUTRAL');
    // The sidecar only exists because the WIN applied.
    assert.ok(fs.existsSync(path.join(dir, 'swarm-learning.json')));
    // The sample itself is on the outcome row the UI already reads.
    const winRow = state.value.outcomes.find(item => item.address === CA);
    assert.ok(winRow.samples.h2, 'updateOutcomeTracking must still own the sample write');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the prior-cycle diff feeds each outcome exactly once — a repeat cycle appends nothing', async () => {
  const dir = tmp('idem');
  try {
    const now = Date.now();
    const baselineAt = now - HOUR2 - 90_000;
    const state = memoryState({ outcomes: [outcomeFor(CA, baselineAt, 1)] });
    const provider = { keyEpoch: 0, configured: async () => true,
      discover: async () => [rowFor(CA, { now, baselineAt, price: 1.6 })] };
    const scanner = new Scanner({ provider, state, settings: settingsFor(dir) });
    await scanner.cycle();
    const afterFirst = readEvents(dir);
    assert.equal(afterFirst.filter(event => event.feedKey === `event:bsc:${CA}:h2`).length, 1);

    await scanner.cycle(); // same state, same row: h2 already present in prior
    await scanner.cycle();
    const afterThird = readEvents(dir);
    assert.equal(afterThird.length, afterFirst.length,
      'a re-observed h2 must not append again — the diff guard owns dedupe, the log stays small');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a learning I/O failure surfaces as a LEARNING event and the cycle still completes', async () => {
  const dir = tmp('fail');
  try {
    const notADir = path.join(dir, 'not-a-directory');
    fs.writeFileSync(notADir, 'x'); // stateDir points at a FILE: every append must throw
    const now = Date.now();
    const baselineAt = now - HOUR2 - 90_000;
    const state = memoryState({ outcomes: [outcomeFor(CA, baselineAt, 1)] });
    const provider = { keyEpoch: 0, configured: async () => true,
      discover: async () => [rowFor(CA, { now, baselineAt, price: 1.6 })] };
    const scanner = new Scanner({ provider, state, settings: settingsFor(notADir) });
    await scanner.cycle(); // must NOT throw

    const learningEvent = state.value.events.find(event => event.type === 'LEARNING');
    assert.ok(learningEvent, 'the failure must be visible as an event, not swallowed');
    assert.match(learningEvent.message, /学习日志写入失败/);
    // The funnel itself is untouched: the sample was still written.
    const row = state.value.outcomes.find(item => item.address === CA);
    assert.ok(row?.samples?.h2, 'outcome sampling must survive a learning failure');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
