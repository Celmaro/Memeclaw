// Tests for the multi-chain fan-out: one rotation, one beginRotation (row caps
// are per chain per rotation — resetting per chain would multiply the measured
// row budget by five), per-chain findings kept chain-attributed, and the
// disabled-chain skip honored before any fetch.

import assert from 'node:assert/strict';
import { DiscoveryCoordinator, createIngestDiscovery } from '../../src/ingest/coordinator.mjs';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

await test('discoverAll: all chains in one rotation, beginRotation EXACTLY once', async () => {
  // Production shape: every emitter owns its OWN budget (createIngestDiscovery
  // allocates one per source) — a shared budget would be reset once per
  // emitter, which is idempotent upfront but masks a real per-source cap bug.
  const rotationsA = [];
  const rotationsB = [];
  const budgetA = { beginRotation: id => rotationsA.push(id) };
  const budgetB = { beginRotation: id => rotationsB.push(id) };
  const coordinator = new DiscoveryCoordinator({
    timeoutMs: 5_000,
    emitters: [
      {
        id: 'e1',
        provider: 'P1',
        budget: budgetA,
        async discover(chain, { out = [] } = {}) {
          out.push({ level: 'info', chain, source: 'e1', reason: `${chain} ok` });
          return [{ chain, address: `0x${'1'.repeat(40)}`, source: 'e1' }];
        },
      },
      {
        id: 'e2',
        provider: 'P2',
        budget: budgetB,
        async discover(chain, { out = [] } = {}) {
          if (chain === 'eth') out.push({ level: 'warn', chain, source: 'e2', reason: 'eth boom' });
          return chain === 'bsc' ? [{ chain, address: `0x${'2'.repeat(40)}`, source: 'e2' }] : [];
        },
      },
    ],
  });
  const result = await coordinator.discoverAll(['eth', 'bsc'], { rotationId: 7 });
  assert.deepEqual(rotationsA, [7], 'one rotation id per budget, not one per chain — row caps would reset otherwise');
  assert.deepEqual(rotationsB, [7]);
  assert.equal(result.records.length, 3, 'e1 both chains + e2 bsc');
  assert.deepEqual(new Set(result.records.map(r => r.chain)), new Set(['eth', 'bsc']));
  assert.ok(result.findings.some(f => f.chain === 'eth' && f.reason === 'eth boom'), 'chain attribution survives aggregation');
  assert.ok(result.findings.some(f => f.chain === 'bsc' && f.source === 'e1'));
  assert.equal(coordinator.lastRun.records, 3);
  assert.equal(coordinator.lastRun.chain, 'eth,bsc');
  assert.deepEqual(coordinator.providers, ['P1', 'P2']);
});

await test('discoverAll: a disabled chain is skipped before the fetch, an emitter failure stays open', async () => {
  const calls = [];
  const coordinator = new DiscoveryCoordinator({
    timeoutMs: 5_000,
    emitters: [
      {
        id: 'sol-only',
        provider: 'SOLONLY',
        enabled: chain => chain === 'sol',
        async discover(chain) {
          calls.push(chain);
          return [{ chain, address: 'So11111111111111111111111111111111111111112', source: 'sol-only' }];
        },
      },
      {
        id: 'boom',
        provider: 'BOOM',
        async discover(chain, { out = [] } = {}) {
          throw new Error(`${chain} exploded`);
        },
      },
    ],
  });
  const result = await coordinator.discoverAll(['eth', 'sol'], { rotationId: 1 });
  assert.deepEqual(calls, ['sol'], 'disabled chain never fetched');
  assert.equal(result.records.length, 1);
  const errors = result.findings.filter(f => f.level === 'error');
  assert.equal(errors.length, 2, 'one failure finding per chain, cycle never dies');
  assert.ok(errors.every(f => f.source === 'boom'));
  assert.deepEqual(new Set(errors.map(f => f.chain)), new Set(['eth', 'sol']));
});

await test('createIngestDiscovery: emitter selection, unknown names rejected loudly', () => {
  const gt = createIngestDiscovery({ emitters: ['gt'] });
  assert.deepEqual(gt.providers, ['GECKOTERMINAL']);
  const all = createIngestDiscovery({ emitters: ['gt', 'gmgn', 'dexpaprika', 'pumpfun'] });
  assert.deepEqual(new Set(all.providers), new Set(['GECKOTERMINAL', 'GMGN', 'DEXPAPRIKA', 'PUMPFUN']));
  assert.ok(all.emitters.length === 4, 'every requested emitter registered');
  const single = createIngestDiscovery({ emitters: ['dexpaprika'] });
  assert.deepEqual(single.providers, ['DEXPAPRIKA'], 'per-source selection for gradual rollout');
  assert.throws(() => createIngestDiscovery({ emitters: ['nope'] }), /no known emitters/);
  assert.throws(() => createIngestDiscovery({ emitters: [] }), /no known emitters/);
});

await test('createIngestDiscovery: default stays gt-only (production gate unchanged for old configs)', () => {
  const legacy = createIngestDiscovery();
  assert.deepEqual(legacy.providers, ['GECKOTERMINAL'], 'omitting emitters behaves exactly as before this build');
});

const failed = results.filter(entry => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.ok ? '' : `\n     ${entry.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
