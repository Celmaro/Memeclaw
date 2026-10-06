// Tests for multi-chain ingest routing: park foreign-chain rows, consume the
// active chain's backlog only where fresh did not arrive (fresh FIRST — the
// scanner's dedupe keeps the first occurrence), replace instead of duplicate,
// and bound the park by TTL + cap so a stalled emitter cannot grow it forever.

import assert from 'node:assert/strict';
import { routeIngestRows } from '../../src/ingest/routing.mjs';

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
const row = (chain, address, capturedAt = NOW) => ({ chain, address, capturedAt });
const eth = a => row('eth', a);
const bsc = a => row('bsc', a);

await test('active rows first, parked backlog appended only where fresh is absent', () => {
  const park = new Map();
  // Rotation 1: eth is active; bsc rows arrive and must be parked.
  const r1 = routeIngestRows(park, [eth('0x' + '1'.repeat(40)), bsc('0x' + '2'.repeat(40))], 'eth', { now: NOW });
  assert.equal(r1.length, 1, 'only the active chain screens this cycle');
  assert.equal(r1[0].chain, 'eth');
  assert.equal(park.get('bsc').length, 1, 'foreign row parked for bsc\'s turn');

  // Rotation 2 (bsc active): fresh bsc rows exist for the SAME address and the
  // parked one must not double up; a parked-only address rides along.
  const r2 = routeIngestRows(park, [bsc('0x' + '2'.repeat(40)), bsc('0x' + '3'.repeat(40))], 'bsc', { now: NOW + 1000 });
  assert.equal(r2.length, 2, 'fresh + parked-only, no duplicates');
  assert.equal(r2[0].address, '0x' + '2'.repeat(40), 'fresh wins its address');
  assert.equal(r2[1].address, '0x' + '3'.repeat(40), 'parked-only rides');
  assert.equal(park.has('bsc'), false, 'the active chain park is consumed by its own cycle');
});

await test('fresh always precedes parked for the same address (dedupe keeps first)', () => {
  const park = new Map();
  const addr = '0x' + 'a'.repeat(40);
  park.set('eth', [eth(addr)]); // stale backlog with a capturedAt older than fresh
  const r = routeIngestRows(park, [eth(addr)], 'eth', { now: NOW });
  assert.equal(r.length, 1, 'overlap collapses to one row');
  assert.equal(r[0].capturedAt, NOW, 'the fresh row is the one that survives');
});

await test('re-discovery REPLACES a parked row instead of queueing duplicates', () => {
  const park = new Map();
  const addr = '0x' + 'b'.repeat(40);
  routeIngestRows(park, [bsc(addr)], 'eth', { now: NOW });
  // Second rotation carries a NEW capture stamp — rows age in place only when
  // nothing re-discovered them.
  routeIngestRows(park, [row('bsc', addr, NOW + 60_000)], 'eth', { now: NOW + 60_000 });
  assert.equal(park.get('bsc').length, 1, 'newest wins per address');
  assert.equal(park.get('bsc')[0].capturedAt, NOW + 60_000, 'the re-discovered row replaced its predecessor');
});

await test('EVM dedupe is case-insensitive, solana stays case-sensitive', () => {
  const park = new Map();
  const mixed = '0xABCDEF0000000000000000000000000000000001';
  routeIngestRows(park, [bsc(mixed)], 'eth', { now: NOW });
  routeIngestRows(park, [bsc(mixed.toLowerCase())], 'eth', { now: NOW + 1000 });
  assert.equal(park.get('bsc').length, 1, 'same EVM token, two cases → one park entry');

  const park2 = new Map();
  routeIngestRows(park2, [row('sol', 'So1111111111111111111111111111111111111111a')], 'eth', { now: NOW });
  routeIngestRows(park2, [row('sol', 'So1111111111111111111111111111111111111111A')], 'eth', { now: NOW + 1000 });
  assert.equal(park2.get('sol').length, 2, 'base58 is case-sensitive — a/A are distinct mints');
});

await test('TTL prunes stale parked rows; cap keeps the newest tail', () => {
  const park = new Map();
  const stale = row('sol', 'Stale111111111111111111111111111111111111111', NOW - 61 * 60_000);
  const live = row('sol', 'Live1111111111111111111111111111111111111111', NOW - 10 * 60_000);
  routeIngestRows(park, [stale, live], 'eth', { now: NOW });
  const sol = park.get('sol');
  assert.ok(!sol.some(r => r.address.startsWith('Stale')), 'older than 60 min TTL dropped at next rotation');

  const park2 = new Map();
  const many = Array.from({ length: 10 }, (_, i) => row('bsc', `0x${String(i).padStart(40, '0')}`, NOW));
  routeIngestRows(park2, many, 'eth', { now: NOW, capPerChain: 3 });
  assert.equal(park2.get('bsc').length, 3, 'cap bounds the park');
  assert.equal(park2.get('bsc')[2].address, '0x0000000000000000000000000000000000000009', 'newest tail kept');
});

await test('degenerate inputs never throw', () => {
  const park = new Map();
  assert.deepEqual(routeIngestRows(park, [], 'eth', { now: NOW }), []);
  assert.deepEqual(routeIngestRows(park, [null, undefined, { noChain: true }, 42], 'eth', { now: NOW }), []);
  assert.deepEqual(routeIngestRows(park, [eth('0x' + 'c'.repeat(40))], 'eth', { now: NOW }).length, 1);
});

const failed = results.filter(entry => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.ok ? '' : `\n     ${entry.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
