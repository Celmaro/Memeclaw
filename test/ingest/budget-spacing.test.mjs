// Regression for the take() spacing fix: check-and-reserve must be ONE
// synchronous step. With the old order (check → await bucket → reserve) two
// concurrent callers — the multi-chain fan-out's normal case, since chains run
// in parallel against one per-host bucket — both passed the spacing check
// before either reserved, and double-fired: the host's measured spacing
// guarantee was silently void the first time two chains were discovered at
// once.

import assert from 'node:assert/strict';
import { SourceBudget } from '../../src/ingest/budget.mjs';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

await test('two concurrent takes reserve serially: second waits a full spacing, never double-fires', async () => {
  let t = 0;
  const sleeps = [];
  const budget = new SourceBudget({
    name: 'T',
    host: 't.example',
    spacingMs: 1_000,
    capacity: 10,          // bucket never blocks — spacing is the only gate under test
    refillMs: 1,
    cooldownFloorMs: 1,
    breakerThreshold: 3,
    perRotationRowCap: null,
    clock: () => t,
    sleep: async ms => { sleeps.push(ms); t += ms; },
  });
  await Promise.all([budget.take('eth'), budget.take('bsc')]);
  // With the fix the first caller reserves synchronously before yielding on the
  // bucket, so the second caller's spacing check sees that reservation and
  // sleeps a full interval — the reservation lands at t=1000 and t=2000.
  assert.equal(budget.lastRequestAt, 2_000, 'reservations must be a full spacing apart, not simultaneous');
  assert.ok(sleeps.every(ms => ms >= 0), 'sleeps are non-negative');
  assert.ok(sleeps.length >= 1, 'the losing caller waited');
});

await test('row cap still throws BEFORE any reservation (no slot burned by a refused row)', async () => {
  let t = 0;
  const budget = new SourceBudget({
    name: 'T2',
    host: 't2.example',
    spacingMs: 0,
    capacity: 10,
    refillMs: 1,
    cooldownFloorMs: 1,
    breakerThreshold: 3,
    perRotationRowCap: 1,
    clock: () => t,
    sleep: async () => {},
  });
  await budget.take('eth');
  await assert.rejects(() => budget.take('eth'), error => error.code === 'ROW_CAP');
  await budget.take('bsc');
  assert.equal(budget.snapshot().rowCaps.eth, 1, 'per-chain cap counts granted rows only');
  assert.equal(budget.snapshot().rowCaps.bsc, 1);
});

const failed = results.filter(entry => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.ok ? '' : `\n     ${entry.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
