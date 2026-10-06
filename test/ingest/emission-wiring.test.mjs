// P4 emission wiring tests — the seams ONLY this file owns:
//   env gate → emitter registration → hint queue → oracle promotion →
//   record merge → row-contract admission (EMISSION) → scanner filter pass.
// Emitter internals and registry/oracle semantics are covered by
// test/ingest/hints.test.mjs (37 cases); do not duplicate them here.
//
// Zero network: existenceOracle is injected; discovery is a stub coordinator
// that mimics the real one (public .emitters array + providers getter).

import assert from 'node:assert/strict';
import { attachEmission, parseEmissionWant } from '../../src/ingest/emission-wiring.mjs';
import { HintRegistry, createHint } from '../../src/ingest/hints.mjs';
import { toDiscoveryRow } from '../../src/ingest/row-contract.mjs';
import { allowedDiscoveryRow } from '../../src/scanner.mjs';

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
const ADDR = '0x' + 'a'.repeat(40);

function stubDiscovery(records = [], findings = []) {
  const stub = {
    emitters: [{ id: 'gt', provider: 'GECKOTERMINAL', budget: null, enabled: () => true, discover: async () => [] }],
    records, findings,
    get providers() { return [...new Set(this.emitters.map(emitter => emitter.provider))]; },
    async discover() {
      this.lastResult = { records: this.records, observations: [], findings: this.findings };
      return this.lastResult;
    },
    beginRotation() {},
    snapshot() { return null; },
  };
  return stub;
}

function seedHint(registry, overrides = {}) {
  const hint = createHint({ chain: 'eth', address: ADDR, source: 'logs', origin: 'factory',
    discoveredAtMs: NOW - 1000, ...overrides });
  assert.ok(hint, 'fixture hint must be valid');
  const added = registry.add(hint);
  assert.equal(added.accepted, true, added.reason ?? '');
  return hint;
}

const newRegistry = () => new HintRegistry({ clock: () => NOW });

// ---------------------------------------------------------------- env gate

await test('parseEmissionWant: all / comma list / absent / unknown enable nothing', () => {
  assert.deepEqual(parseEmissionWant(''), { logs: false, profiles: false });
  assert.deepEqual(parseEmissionWant(undefined), { logs: false, profiles: false });
  assert.deepEqual(parseEmissionWant('garbage'), { logs: false, profiles: false });
  assert.deepEqual(parseEmissionWant('profile'), { logs: false, profiles: false }, 'no substring matches');
  assert.deepEqual(parseEmissionWant('logs'), { logs: true, profiles: false });
  assert.deepEqual(parseEmissionWant('logs,profiles'), { logs: true, profiles: true });
  assert.deepEqual(parseEmissionWant('all'), { logs: true, profiles: true });
});

await test('closed gate: no emitters registered, discover is a passthrough', async () => {
  const stub = stubDiscovery();
  const registry = newRegistry();
  const wrapped = attachEmission(stub, { want: '', registry });
  assert.equal(stub.emitters.length, 1, 'a closed gate must not push anything');
  assert.deepEqual(wrapped.providers, ['GECKOTERMINAL']);
  const result = await wrapped.discover('eth');
  assert.equal(result, stub.lastResult, 'closed gate must delegate, not rebuild');
  assert.equal(registry.size(), 0);
});

await test('open gate: both shims registered, providers widens to EMISSION (and only then)', () => {
  const wrapped = attachEmission(stubDiscovery(), { want: 'all', registry: newRegistry() });
  assert.equal(wrapped.emitters.length, 3, 'gt + logs + profiles');
  assert.ok(wrapped.providers.includes('EMISSION'));
  assert.deepEqual(wrapped.emission.enabled, { logs: true, profiles: true });
  const closed = attachEmission(stubDiscovery(), { want: 'nope', registry: newRegistry() });
  assert.equal(closed.emitters.length, 1);
  assert.ok(!closed.providers.includes('EMISSION'));
});

await test('attachEmission refuses anything that is not a coordinator', () => {
  assert.throws(() => attachEmission({}, { want: 'all', registry: newRegistry() }), TypeError);
  assert.throws(() => attachEmission(null, { want: 'all', registry: newRegistry() }), TypeError);
});

// ------------------------------------------------------- promotion plumbing

await test('oracle exists=true: hint becomes a record that PASSES the scanner filter via EMISSION', async () => {
  const stub = stubDiscovery();
  const registry = newRegistry();
  seedHint(registry);
  const oracle = async () => ({ exists: true, method: 'eth_getCode', codeBytes: 13859 });
  const wrapped = attachEmission(stub, { want: 'all', registry, oracle });
  const result = await wrapped.discover('eth');

  assert.equal(result.records.length, 1, 'the promoted record must merge into the record set');
  const row = toDiscoveryRow(result.records[0]);
  assert.equal(row.marketProvider, 'EMISSION');
  assert.equal(row.ingestSource, 'logs', 'true origin survives provenance');
  assert.equal(allowedDiscoveryRow(row, wrapped.providers), true,
    'the exact admission path: source→EMISSION tag matches the registered shim');
  assert.equal(registry.size(), 0, 'a promoted hint leaves the queue');
  // PROMOTED is a normal outcome — it must not become a warn event.
  assert.equal(result.findings.filter(entry => entry.level === 'warn').length, 0);
});

await test('promotion colliding with a measured record keeps ONE row (measured first)', async () => {
  const measured = { chain: 'eth', address: ADDR.toUpperCase().replace('0X', '0x') };
  const stub = stubDiscovery([measured]);
  const registry = newRegistry();
  seedHint(registry);
  const wrapped = attachEmission(stub, { want: 'all', registry, oracle: async () => ({ exists: true, method: 'eth_getCode', codeBytes: 1 }) });
  const result = await wrapped.discover('eth');
  assert.equal(result.records.length, 1, 'case-insensitive address dedupe');
  assert.equal(result.records[0], measured, 'the measured record wins; promotion only adds evidence elsewhere');
});

await test('oracle exists=false: hint dropped, no record, ABSENT stays out of warn findings', async () => {
  const stub = stubDiscovery();
  const registry = newRegistry();
  seedHint(registry);
  const wrapped = attachEmission(stub, { want: 'all', registry, oracle: async () => ({ exists: false, method: 'eth_getCode', reason: 'empty code' }) });
  const result = await wrapped.discover('eth');
  assert.equal(result.records.length, 0);
  assert.equal(registry.size(), 0, 'an absent address must not re-queue');
  assert.equal(result.findings.filter(entry => entry.level === 'warn').length, 0, 'ABSENT is normal oracle output');
});

await test('oracle failure: hint RETAINED, source cooldown opened, warn finding surfaces', async () => {
  const stub = stubDiscovery();
  const registry = newRegistry();
  seedHint(registry);
  const wrapped = attachEmission(stub, { want: 'all', registry, oracle: async () => { throw new Error('boom'); } });
  const result = await wrapped.discover('eth');
  assert.equal(result.records.length, 0);
  assert.equal(registry.size(), 1, 'fail-open: transport trouble keeps the hint');
  assert.ok(registry.isCoolingDown('logs'), 'the SOURCE is silenced so the next rotation does not hammer it');
  const warn = result.findings.find(entry => entry.level === 'warn');
  assert.ok(warn, 'the cooldown must be visible as a cycle event');
  assert.equal(warn.source, 'logs');
});

await test('a promotion-pass crash never escapes discover (fail-open with a finding)', async () => {
  const stub = stubDiscovery();
  // A registry whose pending() explodes is the cheapest honest repro.
  const registry = newRegistry();
  registry.pending = () => { throw new Error('registry exploded'); };
  const wrapped = attachEmission(stub, { want: 'all', registry });
  const result = await wrapped.discover('eth');
  assert.equal(result.records.length, 0);
  assert.ok(result.findings.some(entry => entry.level === 'warn' && /promotion pass failed/.test(entry.reason)));
});

await test('findings from the base coordinator survive the decoration', async () => {
  const stub = stubDiscovery([], [{ level: 'warn', chain: 'eth', source: 'gt', reason: 'base finding' }]);
  const wrapped = attachEmission(stub, { want: 'logs', registry: newRegistry(), oracle: async () => ({ exists: null, transportDown: true, reason: 'down' }) });
  const result = await wrapped.discover('eth');
  assert.ok(result.findings.some(entry => entry.reason === 'base finding'));
});

const failed = results.filter(entry => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.ok ? '' : `\n     ${entry.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
