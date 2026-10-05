// Tests for the P3 signal layer.
//
// Two invariants matter more than the individual numbers and are asserted
// everywhere below:
//
//   1. Signals are EVIDENCE, never gates. Nothing here may be able to produce a
//      `failed`, `checks` or `blockingUnknownFields` value — the only fields
//      classifyDeepResult() reads. A degraded signal must be inert.
//   2. Missing input degrades toward neutral and says so. It never becomes a
//      confident read, and for botRisk it fails OPEN (unknown adds 0 risk).
//
// Zero network: every input is a literal. Run in-process (`node
// test/ingest/signals.test.mjs`) because node --test cannot spawn on this host
// (EPERM) — same convention as test/ingest/coordinator.test.mjs.

import assert from 'node:assert/strict';
import {
  BOT_SIGNAL_WEIGHTS,
  CONVERGENCE_DEFAULTS,
  PUBLISH_DEDUP_DEFAULTS,
  botRisk,
  flowConvergenceScore,
  publishDedup,
  signalEvidenceBundle,
  walletScore
} from '../../src/ingest/signals.mjs';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

const NOW = 1_800_000_000_000;
const WINDOW_MS = CONVERGENCE_DEFAULTS.windowMs;
const at = offsetMs => ({ at: NOW - offsetMs });

const buy = (wallet, usd, offsetMs = 0) => ({ wallet, usd, at: NOW - offsetMs });

// ---------------------------------------------------------------- convergence

await test('breadth + volume scale the score and converge above the threshold', () => {
  const events = [];
  // 10 distinct wallets => breadth capped at 1; $60k => volume 1.
  for (let i = 0; i < 10; i += 1) events.push(buy(`w${i}`, 6_000));
  const result = flowConvergenceScore(events, {}, NOW);
  assert.equal(result.converged, true);
  assert.equal(result.distinctWallets, 10);
  assert.equal(result.windowTotalUsd, 60_000);
  assert.equal(result.score, 90);
  assert.equal(result.reasons.length, 1);
});

await test('THE CONCENTRATION CUTOFF: one wallet above 50% of window volume scores exactly 50 and is not converged', () => {
  // $30k from one wallet against $25k from nine others = 54.5% share, on a
  // window large enough that the volume term alone would have scored 90.
  const events = [buy('whale', 30_000)];
  for (let i = 0; i < 9; i += 1) events.push(buy(`w${i}`, 25_000 / 9));
  const result = flowConvergenceScore(events, {}, NOW);
  assert.equal(result.converged, false);
  assert.equal(result.score, 50, 'concentration must score exactly neutral, never a partial pass');
  assert.equal(result.distinctWallets, 10);
  assert.ok(result.windowTotalUsd > 50_000, `volume alone would have scored 90, got $${result.windowTotalUsd}`);
  assert.ok(result.reasons.some(reason => /集中而非汇聚/.test(reason)), `reasons must name concentration: ${JSON.stringify(result.reasons)}`);
});

await test('the 50% cutoff is inclusive of its boundary in both directions', () => {
  // Exactly 50% is NOT concentrated (the rule is `share > 0.5`), so the blend
  // runs instead of short-circuiting.
  const atBoundary = flowConvergenceScore([buy('a', 12_500), buy('b', 12_500)], {}, NOW);
  assert.equal(atBoundary.windowTotalUsd, 25_000);
  assert.notEqual(atBoundary.score, 50, 'at exactly 50% the blend must run, not short-circuit');
  assert.ok(
    atBoundary.score < CONVERGENCE_DEFAULTS.minConvergenceScore,
    `2 wallets cannot clear the ${CONVERGENCE_DEFAULTS.minConvergenceScore} convergence threshold, got ${atBoundary.score}`
  );
  assert.equal(atBoundary.converged, false, 'a two-wallet window is never a broad base');

  // One cent over the boundary must flip to exactly neutral.
  const overBoundary = flowConvergenceScore([buy('a', 12_501), buy('b', 12_499)], {}, NOW);
  assert.equal(overBoundary.score, 50);
  assert.equal(overBoundary.converged, false);
});

await test('an empty window is neutral 50, reports itself, and never converges', () => {
  const result = flowConvergenceScore([], {}, NOW);
  assert.equal(result.score, 50);
  assert.equal(result.converged, false);
  assert.equal(result.distinctWallets, 0);
  assert.equal(result.windowTotalUsd, 0);
  assert.ok(result.reasons.some(reason => /没有可用买入事件/.test(reason)));
});

await test('events outside the 15-minute window are excluded, and undated events are reported not dropped', () => {
  const inside = [buy('a', 1_000, 60_000), buy('b', 1_000, 60_000)];
  const outside = [buy('c', 900_000, WINDOW_MS + 1_000)];
  const result = flowConvergenceScore([...inside, ...outside], {}, NOW);
  assert.equal(result.windowTotalUsd, 2_000, 'a stale 900k buy must not inflate the window');
  assert.equal(result.distinctWallets, 2);

  const undated = flowConvergenceScore([{ wallet: 'a', usd: 1_000 }, buy('b', 1_000)], {}, NOW);
  assert.equal(undated.windowTotalUsd, 2_000, 'an undated event is kept and counted, not silently discarded');
  assert.ok(undated.reasons.some(reason => /缺少时间戳/.test(reason)));
});

await test('a non-array input degrades to neutral instead of throwing', () => {
  for (const input of [undefined, null, 'nope', 42, {}]) {
    const result = flowConvergenceScore(input, {}, NOW);
    assert.equal(result.score, 50, `input ${JSON.stringify(input)} must degrade`);
    assert.equal(result.converged, false);
  }
});

await test('convergence is deterministic and clock-injected', () => {
  const events = [buy('a', 2_000), buy('b', 2_000), buy('c', 2_000)];
  const first = flowConvergenceScore(events, {}, NOW);
  const second = flowConvergenceScore(events, {}, NOW);
  assert.deepEqual(first, second);
  // Same events, a much later clock: everything has left the window.
  assert.equal(flowConvergenceScore(events, {}, NOW + 10 * WINDOW_MS).windowTotalUsd, 0);
});

// ---------------------------------------------------------------- walletScore

await test('walletScore with no input at all is neutral 50 and degraded', () => {
  const result = walletScore({});
  assert.equal(result.score, 50);
  assert.equal(result.degraded, true);
  assert.equal(result.reasons.length, 2, 'both contributions must be explained');
});

await test('walletScore prefers the USD variant over counts (800x$20 is a net seller)', () => {
  const byUsd = walletScore({ buyUsd1h: 16_000, sellUsd1h: 84_000, walletWinRate: 0.5, walletSamples: 20 }, {}, NOW);
  assert.ok(byUsd.score < 50, `net USD seller must land below neutral, got ${byUsd.score}`);
  assert.ok(byUsd.reasons.some(reason => /USD/.test(reason)), 'the USD path must be named');

  const byCount = walletScore({ buyCount5m: 800, sellCount5m: 200, walletWinRate: 0.5, walletSamples: 20 }, {}, NOW);
  assert.ok(byCount.score > 50, '800 buys vs 200 sells by count reads positive');
  assert.ok(byCount.score > byUsd.score, 'the USD variant must move the score the other way');
});

await test('net flow never moves the score more than the +/20 bound', () => {
  const extremeBuy = walletScore({ buyUsd1h: 1e12, sellUsd1h: 0, walletWinRate: 0.5, walletSamples: 20 });
  const extremeSell = walletScore({ buyUsd1h: 0, sellUsd1h: 1e12, walletWinRate: 0.5, walletSamples: 20 });
  assert.equal(extremeBuy.score, 70);
  assert.equal(extremeSell.score, 30);
});

await test('a thin smart-money sample is not read as a confident verdict', () => {
  const thin = walletScore({ buyUsd1h: 10_000, sellUsd1h: 10_000, walletWinRate: 1, walletSamples: 2 });
  assert.equal(thin.score, 50, 'a 100% win rate on 2 samples must not lift the score');
  assert.equal(thin.degraded, true);
  assert.ok(thin.reasons.some(reason => /样本 2 不足 5/.test(reason)));

  const trusted = walletScore({ buyUsd1h: 10_000, sellUsd1h: 10_000, walletWinRate: 1, walletSamples: 40 });
  assert.equal(trusted.score, 60);
  assert.equal(trusted.degraded, false);
});

await test('walletScore stays inside 0..100 for hostile input', () => {
  for (const input of [{ buyUsd1h: NaN, sellUsd1h: 'x', walletWinRate: 99, walletSamples: 1e9 }, {}, null, 'nope', []]) {
    const result = walletScore(input);
    assert.ok(result.score >= 0 && result.score <= 100, `score ${result.score} out of range for ${JSON.stringify(input)}`);
    assert.equal(typeof result.degraded, 'boolean');
  }
});

// -------------------------------------------------------------------- botRisk

await test('THE FAIL-OPEN INVARIANT: all-unknown bot signals score 0 with degraded true — not 50, not a rejection', () => {
  const result = botRisk({});
  assert.equal(result.score, 0, 'absent data must not manufacture risk');
  assert.equal(result.severity, 'none');
  assert.equal(result.degraded, true);
  assert.deepEqual(result.reasons.map(entry => entry.signal).sort(), Object.keys(BOT_SIGNAL_WEIGHTS).sort());
  assert.ok(result.reasons.every(entry => entry.contribution === 0), 'every unknown signal contributes exactly 0');
});

await test('null and malformed bot signals are unknown, never a clean 0 that hides missing data', () => {
  const result = botRisk({ bundle: null, sniper: -1, gradualBundle: 'abc', washTrading: undefined, concentration: 999 });
  assert.equal(result.score, 0);
  assert.equal(result.degraded, true);
  assert.equal(result.reasons.length, 5, 'all five signals are accounted for, none dropped');
});

await test('botRisk is the bounded sum of named signals and every point is attributable', () => {
  const result = botRisk({ bundle: 0.5, sniper: 0.4, gradualBundle: 0.25, washTrading: 0.2, concentration: 0.1 });
  const expected = 0.5 * 30 + 0.4 * 25 + 0.25 * 20 + 0.2 * 25 + 0.1 * 20;
  assert.equal(result.score, expected);
  assert.equal(result.severity, 'low');
  assert.equal(result.degraded, false);
  assert.equal(result.reasons.find(entry => entry.signal === 'bundle').contribution, 15);
  assert.equal(
    result.reasons.reduce((sum, entry) => sum + entry.contribution, 0),
    result.score,
    'the score must be fully explained by the named reasons'
  );
});

await test('percentage and ratio inputs agree, and the total is capped at 100', () => {
  const asRatio = botRisk({ bundle: 0.9, sniper: 0.9, gradualBundle: 0.9, washTrading: 0.9, concentration: 0.9 });
  const asPercent = botRisk({ bundle: 90, sniper: 90, gradualBundle: 90, washTrading: 90, concentration: 90 });
  assert.deepEqual(asRatio, asPercent, 'a 0-100 percentage is read as the same signal as its ratio');
  assert.equal(asRatio.score, 100);
  assert.equal(asRatio.severity, 'critical');
});

await test('botRisk accepts a clean measured read without flagging it degraded', () => {
  const result = botRisk({ bundle: 0.02, sniper: 0.03, gradualBundle: 0, washTrading: 0.01, concentration: 0.05 });
  assert.ok(result.score < 20);
  assert.equal(result.severity, 'none');
  assert.equal(result.degraded, false, 'measured-and-clean is not the same as unknown');
});

// --------------------------------------------------------- evidence bundle

await test('a bundle with no inputs at all is flagged degraded and carries no numbers', () => {
  const bundle = signalEvidenceBundle({}, { now: NOW });
  assert.equal(bundle.degraded, true);
  assert.equal(bundle.capturedAt, NOW);
  assert.equal('convergence' in bundle, false, 'no fake neutral 50 convergence');
  assert.equal('wallet' in bundle, false, 'no fake neutral 50 wallet score');
  assert.equal('bot' in bundle, false, 'no fake zero bot risk');
});

await test('a bundle with no inputs cannot produce a gate field, whatever it is fed', () => {
  const bundle = signalEvidenceBundle({}, { botSignals: {}, wallet: {} }, NOW);
  for (const gateField of ['failed', 'checks', 'blockingUnknownFields', 'chainPass', 'unknownFields']) {
    assert.equal(gateField in bundle, false, `signal evidence must never carry ${gateField}`);
  }
  assert.equal(bundle.degraded, true);
});

await test('only the parts whose input exists are present; the rest stay absent', () => {
  const bundle = signalEvidenceBundle(
    { txns: { m5: { buys: 40, sells: 10 } } },
    { convergenceEvents: [buy('a', 1_000), buy('b', 1_000), buy('c', 1_000)], now: NOW }
  );
  assert.ok(bundle.convergence, 'convergence events were supplied');
  assert.ok(bundle.wallet, 'buy/sell counts were supplied on the row');
  assert.equal('bot' in bundle, false, 'no bot inputs were supplied');
  assert.ok(bundle.degraded, 'a partial bundle is degraded');
});

await test('a fully supplied bundle is not degraded and is still gate-free', () => {
  const bundle = signalEvidenceBundle(
    { buyUsd1h: 20_000, sellUsd1h: 5_000, walletWinRate: 0.62, walletSamples: 30 },
    {
      convergenceEvents: [buy('a', 1_000), buy('b', 1_000), buy('c', 1_000)],
      botSignals: { bundle: 0.1, sniper: 0.05, gradualBundle: 0, washTrading: 0, concentration: 0.2 },
      now: NOW
    }
  );
  assert.equal(bundle.degraded, false);
  assert.ok(bundle.convergence && bundle.wallet && bundle.bot);
  for (const gateField of ['failed', 'checks', 'blockingUnknownFields']) {
    assert.equal(gateField in bundle, false);
  }
});

await test('the bundle reads GoPlus-style aliases and degrades on a partial bot read', () => {
  const bundle = signalEvidenceBundle({}, { botSignals: { bundler_rate: 0.4, top10_rate: 30 }, now: NOW });
  assert.ok(bundle.bot);
  assert.equal(bundle.bot.score, 0.4 * 30 + 0.3 * 20);
  assert.equal(bundle.bot.degraded, true, 'three unmeasured signals must still be declared');
  assert.equal(bundle.degraded, true);
});

// ----------------------------------------------------------------- publishDedup

await test('the first publish sends, and an immediate repeat is suppressed for the full cooldown', () => {
  const store = new Map();
  const first = publishDedup({ key: 'robinhood:0xabc:CANDIDATE_NEW', now: NOW, store, cooldownMs: 60_000 });
  assert.equal(first.send, true);
  assert.equal(first.remainingMs, 0);

  const repeat = publishDedup({ key: 'robinhood:0xabc:CANDIDATE_NEW', now: NOW + 30_000, store, cooldownMs: 60_000 });
  assert.equal(repeat.send, false);
  assert.equal(repeat.remainingMs, 30_000);
});

await test('the cooldown expires exactly, never early', () => {
  const store = new Map();
  publishDedup({ key: 'k', now: NOW, store, cooldownMs: 60_000 });
  const beforeExpiry = publishDedup({ key: 'k', now: NOW + 59_999, store, cooldownMs: 60_000 });
  assert.equal(beforeExpiry.send, false);
  assert.equal(beforeExpiry.remainingMs, 1);

  const atExpiry = publishDedup({ key: 'k', now: NOW + 60_000, store, cooldownMs: 60_000 });
  assert.equal(atExpiry.send, true);
  assert.equal(atExpiry.remainingMs, 0);
});

await test('the cooldown is per key AND per alert type', () => {
  const store = new Map();
  publishDedup({ key: 'token:CANDIDATE_NEW', now: NOW, store, cooldownMs: 60_000 });
  assert.equal(publishDedup({ key: 'token:RISK_WORSENED', now: NOW, store, cooldownMs: 60_000 }).send, true);
  assert.equal(publishDedup({ key: 'other:CANDIDATE_NEW', now: NOW, store, cooldownMs: 60_000 }).send, true);
  assert.equal(publishDedup({ key: 'token:CANDIDATE_NEW', now: NOW, store, cooldownMs: 60_000 }).send, false);
});

await test('force sends anyway and starts a fresh cooldown rather than leaving the key expired', () => {
  const store = new Map();
  publishDedup({ key: 'k', now: NOW, store, cooldownMs: 60_000 });
  const forced = publishDedup({ key: 'k', now: NOW + 1_000, store, cooldownMs: 60_000, force: true });
  assert.equal(forced.send, true);
  assert.equal(forced.remainingMs, 0);
  assert.equal(publishDedup({ key: 'k', now: NOW + 30_000, store, cooldownMs: 60_000 }).send, false,
    'the forced publish must have re-stamped the key');
});

await test('the store is injectable: a plain object works, and it is the captain’s durable state slot', () => {
  // A plain key→timestamp object is exactly what RadarState.dedupEntries is,
  // so the captain can bind it directly instead of adding an adapter.
  const store = {};
  assert.equal(publishDedup({ key: 'k', now: NOW, store, cooldownMs: 60_000 }).send, true);
  assert.equal(store.k, NOW, 'the stamp must be written back so RadarState.save() can persist it');
  assert.equal(publishDedup({ key: 'k', now: NOW + 1, store, cooldownMs: 60_000 }).send, false);
});

await test('with no store injected, dedup still works in-process', () => {
  const key = `in-memory:${NOW}`;
  assert.equal(publishDedup({ key, now: NOW, cooldownMs: 60_000 }).send, true);
  assert.equal(publishDedup({ key, now: NOW + 1, cooldownMs: 60_000 }).send, false);
  assert.equal(publishDedup({ key: `${key}:2`, now: NOW, cooldownMs: 60_000 }).send, true);
});

await test('a clock that moves backwards still blocks, and a missing key is a caller error', () => {
  const store = new Map();
  publishDedup({ key: 'k', now: NOW, store, cooldownMs: 60_000 });
  store.set('k', NOW + 10 * 60_000); // stamp from the "future"
  assert.equal(publishDedup({ key: 'k', now: NOW, store, cooldownMs: 60_000 }).send, false,
    'a backwards clock must not open a negative remaining window');
  assert.throws(() => publishDedup({ now: NOW, store }), TypeError);
  assert.throws(() => publishDedup({ key: '  ', now: NOW, store }), TypeError);
});

await test('the default cooldown is bounded and documented', () => {
  assert.ok(PUBLISH_DEDUP_DEFAULTS.cooldownMs > 0);
  const store = new Map();
  assert.equal(publishDedup({ key: 'k', now: NOW, store }).send, true);
  const immediate = publishDedup({ key: 'k', now: NOW + 1, store });
  assert.equal(immediate.send, false);
  assert.equal(immediate.remainingMs, PUBLISH_DEDUP_DEFAULTS.cooldownMs - 1);
});

// ------------------------------------------------ real row vocabularies
// The wiring seam reads AVE normalized trending rows (ave.mjs:345-347) and
// ingest rows bridged into the same names (row-contract.mjs), so the aliases
// and the honest window label are part of the contract, not an implementation
// detail.

await test('an AVE trending row reads as USD net flow, labelled with its real 5m window', () => {
  const row = { buys_5m: 40, sells_5m: 10, buy_volume_5m: 8_000, sell_volume_5m: 2_000 };
  const result = walletScore(row);
  // USD wins over counts: (8000-2000)/10000 * 20 = +12.
  assert.equal(result.score, 62);
  assert.ok(result.reasons.some(reason => reason.includes('5 分钟')),
    'a 5m read must say 5 分钟, never masquerade as an hour');
  assert.ok(!result.reasons.some(reason => reason.includes('1 小时')),
    'the window label must follow the key that actually won');
  assert.equal(result.degraded, true, 'no cohort sample exists yet, so the smart-money part is honestly absent');
});

await test('explicit null flow fields in an AVE row degrade to neutral instead of asserting balance', () => {
  const row = { buy_volume_5m: null, sell_volume_5m: null, buys_5m: null, sells_5m: null };
  const result = walletScore(row);
  assert.equal(result.score, 50);
  assert.equal(result.degraded, true);
  assert.ok(result.reasons.some(reason => reason.includes('缺少买卖两侧')),
    'all-null flow must report missing data, not a confident 50');
});

await test('a bridge row carrying counts only still scores from counts', () => {
  const row = { buys_5m: 90, sells_5m: 10 };
  const result = walletScore(row);
  // (90-10)/100 * 20 = +16.
  assert.equal(result.score, 66);
  assert.ok(result.reasons.some(reason => reason.includes('按笔数计')));
});

const failed = results.filter(entry => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.ok ? '' : `\n     ${entry.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;