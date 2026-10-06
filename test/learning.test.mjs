import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BASELINE_WEIGHTS,
  BAND,
  OUTCOME_THRESHOLDS,
  RATCHET_STEP,
  WEIGHT_CAPS,
  WEIGHT_KEYS,
  appendEvent,
  classifyOutcome,
  deriveEventId,
  deriveFeedKey,
  feedOutcome,
  projectWeights,
  readWeights,
  recalibrate,
  replayEvents,
  weightBounds,
  writeWeights,
} from '../src/learning.mjs';

const quiet = { onWarn: () => {} };
const sumOf = weights => WEIGHT_KEYS.reduce((sum, key) => sum + weights[key], 0);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeclaw-learning-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const win = (address, extra = {}) => ({ address, chain: 'sol', result: 'WIN', ...extra });
const loss = (address, extra = {}) => ({ address, chain: 'sol', result: 'LOSS', ...extra });

test('appendEvent writes one JSONL line per event and fills eventId/at', t => {
  const dir = tempDir(t);
  const stored = appendEvent(dir, { type: 'OUTCOME_TERMINAL', outcome: win('a') });
  assert.equal(typeof stored.eventId, 'string');
  assert.ok(stored.eventId.length > 0);
  assert.ok(stored.at > 0);

  const lines = fs.readFileSync(path.join(dir, 'learning-events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).type, 'OUTCOME_TERMINAL');
});

test('append + replay roundtrip folds terminal wins back into weights', t => {
  const dir = tempDir(t);
  feedOutcome(dir, win('addr-1'), quiet);
  feedOutcome(dir, win('addr-2'), quiet);
  feedOutcome(dir, loss('addr-3'), quiet);

  const replay = replayEvents(dir, quiet);
  assert.equal(replay.total, 3);
  assert.equal(replay.skipped, 0);
  assert.equal(Object.keys(replay.outcomes).length, 3);
  assert.equal(replay.outcomes[deriveFeedKey(win('addr-1'))].result, 'WIN');
  assert.equal(replay.outcomes[deriveFeedKey(loss('addr-3'))].result, 'LOSS');
  // Two wins against one loss: the win weights rise and defensive gives back
  // the renormalized share. The λ shift is uniform, so the direction of every
  // weight follows the sign of its own ratchet.
  assert.ok(replay.weights.smartMoney > BASELINE_WEIGHTS.smartMoney);
  assert.ok(replay.weights.liquidity > BASELINE_WEIGHTS.liquidity);
  assert.ok(replay.weights.defensive < BASELINE_WEIGHTS.defensive);
  assert.ok(Math.abs(sumOf(replay.weights) - 1) < 1e-9);
});

test('a corrupt middle line is skipped, never fatal; surrounding lines still replay', t => {
  const dir = tempDir(t);
  feedOutcome(dir, win('good-1'), quiet);
  const file = path.join(dir, 'learning-events.jsonl');
  fs.appendFileSync(file, '{"broken": \n');
  feedOutcome(dir, loss('good-2'), quiet);
  feedOutcome(dir, loss('good-3'), quiet);

  const intact = replayEvents(dir, quiet);
  const replay = replayEvents(dir, quiet);
  assert.equal(replay.total, 4);
  assert.equal(replay.skipped, 1);
  assert.equal(Object.keys(replay.outcomes).length, 3);
  assert.equal(replay.appliedFeedKeys.size, 3);
  // The corrupt line is skipped, not fatal: the rest still folds to the same
  // weights a clean log would produce.
  assert.ok(replay.weights.defensive > BASELINE_WEIGHTS.defensive);
  assert.deepEqual(replay.weights, intact.weights);
});

test('replay tolerates a missing file and an empty file', t => {
  const dir = tempDir(t);
  const missing = replayEvents(dir, quiet);
  assert.equal(missing.total, 0);
  assert.equal(missing.skipped, 0);
  assert.deepEqual(missing.weights, projectWeights(BASELINE_WEIGHTS));

  fs.writeFileSync(path.join(dir, 'learning-events.jsonl'), '');
  const empty = replayEvents(dir, quiet);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.weights, projectWeights(BASELINE_WEIGHTS));
});

test('replay skips non-object lines too', t => {
  const dir = tempDir(t);
  feedOutcome(dir, win('ok-1'), quiet);
  fs.appendFileSync(path.join(dir, 'learning-events.jsonl'), '[1,2,3]\n"just a string"\n');
  const replay = replayEvents(dir, quiet);
  assert.equal(replay.skipped, 2);
  assert.equal(Object.keys(replay.outcomes).length, 1);
});

test('the ratchet never exceeds the caps under sustained pressure', t => {
  const dir = tempDir(t);
  for (let i = 0; i < 60; i += 1) feedOutcome(dir, win(`w-${i}`), quiet);
  for (let i = 0; i < 60; i += 1) feedOutcome(dir, loss(`l-${i}`), quiet);

  const { weights } = replayEvents(dir, quiet);
  for (const key of WEIGHT_KEYS) {
    assert.ok(weights[key] <= WEIGHT_CAPS[key] + 1e-9, `${key} ${weights[key]} > cap ${WEIGHT_CAPS[key]}`);
    assert.ok(weights[key] >= 0, `${key} went negative`);
  }
});

test('40 wins keep every weight inside the ±30% band after renormalization', t => {
  const dir = tempDir(t);
  for (let i = 0; i < 40; i += 1) {
    const result = feedOutcome(dir, win(`band-${i}`), quiet);
    assert.equal(result.applied, true);
  }

  const { weights } = replayEvents(dir, quiet);
  const { lo, hi } = weightBounds();
  for (const key of WEIGHT_KEYS) {
    assert.ok(weights[key] >= lo[key] - 1e-9, `${key} ${weights[key]} < band floor ${lo[key]}`);
    assert.ok(weights[key] <= hi[key] + 1e-9, `${key} ${weights[key]} > band ceiling ${hi[key]}`);
    assert.ok(
      Math.abs(weights[key] - BASELINE_WEIGHTS[key]) <= BASELINE_WEIGHTS[key] * BAND + 1e-9,
      `${key} drifted further than ±${BAND * 100}% of baseline`
    );
  }
  assert.ok(Math.abs(sumOf(weights) - 1) < 1e-9);
  // The ratchet must actually move, otherwise the band assertion is vacuous.
  assert.ok(weights.smartMoney > BASELINE_WEIGHTS.smartMoney);
  assert.ok(weights.defensive < BASELINE_WEIGHTS.defensive);
});

test('projectWeights renormalizes to exactly 1 and respects caps + band', () => {
  const extreme = { smartMoney: 99, liquidity: 0.0001, defensive: -5 };
  const projected = projectWeights(extreme);
  const { lo, hi } = weightBounds();
  assert.ok(Math.abs(sumOf(projected) - 1) < 1e-9);
  for (const key of WEIGHT_KEYS) {
    assert.ok(projected[key] >= lo[key] - 1e-9 && projected[key] <= hi[key] + 1e-9);
    assert.ok(projected[key] <= WEIGHT_CAPS[key] + 1e-9);
  }
});

test('projectWeights is idempotent on its own output', () => {
  const once = projectWeights({ smartMoney: 0.41, liquidity: 0.3, defensive: 0.29 });
  const twice = projectWeights(once);
  for (const key of WEIGHT_KEYS) assert.ok(Math.abs(once[key] - twice[key]) < 1e-9);
});

test('double-feeding the same outcome is a no-op', t => {
  const dir = tempDir(t);
  const outcome = win('double-1');
  const first = feedOutcome(dir, outcome, quiet);
  assert.equal(first.applied, true);

  const second = feedOutcome(dir, outcome, quiet);
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'already_applied');
  assert.equal(second.eventId, first.eventId);

  const replay = replayEvents(dir, quiet);
  // Two log lines (the audit trail keeps both), but one applied fold.
  assert.equal(replay.total, 2);
  assert.equal(replay.appliedFeedKeys.size, 1);
  assert.deepEqual(replay.weights, first.weights);
});

test('a realized EXITED exit is never re-fed, even with a freshly minted eventId', t => {
  const dir = tempDir(t);
  const exit = { address: 'exit-token', chain: 'sol', currentState: 'EXITED', result: 'WIN', exitId: 'exit-777' };

  const first = feedOutcome(dir, exit, quiet);
  assert.equal(first.applied, true);
  assert.equal(first.feedKey, 'exit:exit-777');

  // A later cycle re-polls the same realized exit; it carries a new eventId
  // because the caller minted it fresh, but the exit identity is unchanged.
  const refetched = { ...exit, eventId: 'ev_minted_later', currentState: 'EXITED' };
  const second = feedOutcome(dir, refetched, quiet);
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'already_applied');

  const replay = replayEvents(dir, quiet);
  assert.equal(replay.appliedFeedKeys.size, 1);
  assert.deepEqual(replay.weights, first.weights);
});

test('an explicitly drained realized exit is rejected as already applied', t => {
  const dir = tempDir(t);
  const drained = { address: 'drained-token', chain: 'bsc', result: 'LOSS', exitId: 'exit-888', drained: true };
  const result = feedOutcome(dir, drained, quiet);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'already_applied');
});

test('a neutral / timed-out close moves no weight', t => {
  const dir = tempDir(t);
  const before = replayEvents(dir, quiet).weights;
  const neutral = feedOutcome(dir, { address: 'flat-1', chain: 'sol', result: 'NEUTRAL' }, quiet);
  assert.equal(neutral.applied, false);
  assert.equal(neutral.reason, 'neutral_close');

  const timeout = feedOutcome(dir, { address: 'flat-2', chain: 'sol', result: 'TIMEOUT' }, quiet);
  assert.equal(timeout.applied, false);
  assert.equal(timeout.reason, 'neutral_close');

  const after = replayEvents(dir, quiet);
  assert.deepEqual(after.weights, before);
  assert.equal(after.appliedFeedKeys.size, 0);
});

test('a non-terminal outcome is rejected without touching weights', t => {
  const dir = tempDir(t);
  const before = replayEvents(dir, quiet).weights;
  const pending = feedOutcome(dir, { address: 'open-1', chain: 'sol', currentState: 'X_REVIEW' }, quiet);
  assert.equal(pending.applied, false);
  assert.equal(pending.reason, 'not_terminal');
  assert.deepEqual(replayEvents(dir, quiet).weights, before);
});

test('classifyOutcome honours the ported terminal thresholds', () => {
  assert.equal(classifyOutcome({ gainRatio: OUTCOME_THRESHOLDS.winGainRatio + 0.1 }).label, 'WIN');
  assert.equal(classifyOutcome({ gainRatio: 1.2 }).terminal, false);
  assert.equal(classifyOutcome({ lossRatio: OUTCOME_THRESHOLDS.lossLossRatio - 0.1 }).label, 'LOSS');
  assert.equal(classifyOutcome({ lossRatio: 0.95 }).terminal, false);
  assert.equal(classifyOutcome({ result: 'WIN' }).terminal, true);
  assert.equal(classifyOutcome({ result: 'LOSS' }).terminal, true);
  assert.equal(classifyOutcome({}).label, 'UNKNOWN');
});

test('deriveEventId is deterministic and exit-scoped', () => {
  const a = { address: 'tok', chain: 'sol', result: 'WIN', exitId: 'e-1' };
  const b = { address: 'other', chain: 'bsc', result: 'LOSS', exitId: 'e-1' };
  assert.equal(deriveEventId(a), deriveEventId({ ...a }));
  assert.equal(deriveEventId(a), deriveEventId(b), 'the exit identity must dominate the payload');
  assert.notEqual(deriveEventId(a), deriveEventId({ ...a, exitId: 'e-2' }));
  assert.equal(deriveFeedKey(a), 'exit:e-1');
});

test('recalibrate is pure: it never touches the filesystem', t => {
  const dir = tempDir(t);
  const before = { ...BASELINE_WEIGHTS };
  const result = recalibrate(before, win('pure-1'));
  assert.equal(result.applied, true);
  assert.deepEqual(before, BASELINE_WEIGHTS, 'input weights must not be mutated');
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('a WIN raises smart money and liquidity; a LOSS raises defensive', () => {
  const won = recalibrate(BASELINE_WEIGHTS, win('x'));
  assert.equal(won.label, 'WIN');
  assert.ok(won.deltas.smartMoney > 0);
  assert.ok(won.deltas.liquidity > 0);
  assert.ok(Math.abs(won.deltas.smartMoney) <= RATCHET_STEP + 1e-9);

  const lost = recalibrate(BASELINE_WEIGHTS, loss('y'));
  assert.equal(lost.label, 'LOSS');
  assert.ok(lost.deltas.defensive > 0);
});

test('the weights sidecar roundtrips and a missing one reads as null', t => {
  const dir = tempDir(t);
  assert.equal(readWeights(dir), null);

  const payload = writeWeights(dir, { smartMoney: 0.42, liquidity: 0.3, defensive: 0.28 });
  assert.ok(Math.abs(payload.weightsSum - 1) < 1e-9);

  const loaded = readWeights(dir);
  assert.ok(loaded);
  for (const key of WEIGHT_KEYS) assert.ok(Math.abs(loaded.weights[key] - payload.weights[key]) < 1e-9);
  // The sidecar is a cache of the log, never its source: with an empty log the
  // authoritative replay stays at the baseline no matter what the cache holds.
  assert.deepEqual(replayEvents(dir, quiet).weights, projectWeights(BASELINE_WEIGHTS));
});

test('readWeights survives a corrupted sidecar without throwing', t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'swarm-learning.json'), '{ not json');
  assert.equal(readWeights(dir), null);
});

test('a missing directory is created gracefully on first write', t => {
  const parent = tempDir(t);
  const dir = path.join(parent, 'nested', 'state');
  assert.equal(fs.existsSync(dir), false);

  const replay = replayEvents(dir, quiet);
  assert.equal(replay.total, 0);

  const fed = feedOutcome(dir, win('fresh-1'), quiet);
  assert.equal(fed.applied, true);
  assert.ok(fs.existsSync(path.join(dir, 'learning-events.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, 'swarm-learning.json')));
});

test('the module refuses an uninjected store instead of guessing a path', () => {
  assert.throws(() => appendEvent(undefined, { type: 'X' }), TypeError);
  assert.throws(() => feedOutcome({}, win('z')), TypeError);
});

test('state survives a full restart: a fresh replay equals the persisted weights', t => {
  const dir = tempDir(t);
  const sequence = [win('r-1'), loss('r-2'), win('r-3'), { address: 'r-4', result: 'NEUTRAL' }];
  for (const outcome of sequence) feedOutcome(dir, outcome, quiet);

  const firstRun = replayEvents(dir, quiet);
  const restarted = replayEvents(dir, quiet);
  assert.deepEqual(restarted.weights, firstRun.weights, 'replay must be a pure fold, not a running mutation');
  const sidecar = readWeights(dir);
  for (const key of WEIGHT_KEYS) assert.ok(Math.abs(sidecar.weights[key] - firstRun.weights[key]) < 1e-9);
});
