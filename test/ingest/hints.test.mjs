import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HintRegistry, existenceOracle, promoteChecked, HINT_DISPOSITION } from '../../src/ingest/hints.mjs';
import { createLogsEmitter, createProfilesEmitter, toCoordinatorEmitter, VERIFIED_FACTORIES, SKIPPED_FACTORY_CHAINS, EMISSION_TOPICS } from '../../src/ingest/adapters/emission.mjs';
import { normalizeTokenAddress } from '../../src/address.mjs';

// `node --test <file>` cannot run here: the runner spawns a child process and
// this sandbox denies it (measured: spawn EPERM on a 2-test file, exit 1).
// node:test's in-process runner works when the FILE is executed directly —
// `node test/ingest/hints.test.mjs` prints real TAP and still exits non-zero on
// failure (both measured). Zero network: every fetch below is a local stub.
const results = [];
function check(name, fn) {
  test(name, async () => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error: error.message });
      throw error;
    }
  });
}

const EVM = '0x0123456789abcdef0123456789abcdef01234567';
const EVM2 = '0xfedcba9876543210fedcba9876543210fedcba98';
const EVM3 = '0x1111111111111111111111111111111111111111';
const SOL = '9EjTpSkgFzWUY5zdaEQynkNNz17eVKQnYwyU7igWwyWR';
const NOW = 1_800_000_000_000;

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(),
    text: async () => JSON.stringify(payload),
  };
}

// The measured PublicNode failure shape: HTTP 200 carrying a JSON-RPC error.
// Every test that expects "the RPC was unreachable" uses exactly this, because
// a status-only check would call it success.
function rpcError(code, message) {
  return jsonResponse({ jsonrpc: '2.0', id: 1, error: { code, message } });
}

// ---------------------------------------------------------------- registry ---

check('hint TTL expires an unpromoted hint instead of holding it forever', () => {
  let now = NOW;
  const registry = new HintRegistry({ ttlMs: 1_000, clock: () => now });
  registry.add({ chain: 'base', address: EVM, source: 'logs' });
  assert.equal(registry.size(), 1);
  now += 2_000;
  assert.equal(registry.size(), 0, 'an expired hint must not stay queued');
  assert.equal(registry.snapshot().stats.expired, 1);
});

check('hints dedupe by chain:address and keep the FIRST sighting', () => {
  const registry = new HintRegistry({ clock: () => NOW });
  const first = registry.add({ chain: 'base', address: EVM, source: 'logs', discoveredAtMs: NOW });
  assert.equal(first.accepted, true);
  const again = registry.add({ chain: 'base', address: EVM.toUpperCase(), source: 'profiles', discoveredAtMs: NOW + 5_000 });
  assert.equal(again.accepted, false);
  assert.equal(again.reason, 'duplicate');
  assert.equal(again.hint.source, 'logs', 'the earlier sighting wins: the duplicate must not overwrite it');
  assert.equal(registry.size(), 1);
});

check('the same address on two chains is two distinct hints', () => {
  const registry = new HintRegistry({ clock: () => NOW });
  registry.add({ chain: 'base', address: EVM, source: 'logs' });
  registry.add({ chain: 'eth', address: EVM, source: 'logs' });
  assert.equal(registry.size(), 2, 'dedupe key is chain:address, not address alone');
});

check('an address that cannot exist on the chain is rejected, not queued', () => {
  const registry = new HintRegistry({ clock: () => NOW });
  const zero = registry.add({ chain: 'base', address: `0x${'0'.repeat(40)}`, source: 'logs' });
  assert.equal(zero.accepted, false);
  assert.equal(zero.reason, 'invalid_address');
  assert.equal(registry.add({ chain: 'base', address: 'not-an-address', source: 'logs' }).accepted, false);
  assert.equal(registry.add({ chain: 'sol', address: EVM, source: 'logs' }).accepted, false, 'an EVM address is not a solana address');
  assert.equal(registry.size(), 0);
});

check('the registry drops the OLDEST hint when it hits the cap', () => {
  let now = NOW;
  const registry = new HintRegistry({ maxHints: 3, clock: () => now });
  for (const address of [EVM, EVM2, EVM3]) registry.add({ chain: 'base', address, source: 'logs', discoveredAtMs: now });
  now += 1_000;
  const fourth = registry.add({ chain: 'base', address: '0x2222222222222222222222222222222222222222', source: 'logs', discoveredAtMs: now });
  assert.equal(fourth.accepted, true);
  assert.equal(registry.size(), 3);
  assert.equal(registry.pending().some(hint => hint.address === EVM), false, 'the oldest is evicted');
  assert.equal(registry.pending().some(hint => hint.address === '0x2222222222222222222222222222222222222222'), true);
});

check('drain empties the queue and hands over the hints', () => {
  const registry = new HintRegistry({ clock: () => NOW });
  registry.add({ chain: 'base', address: EVM, source: 'logs' });
  const drained = registry.drain();
  assert.equal(drained.length, 1);
  assert.equal(registry.size(), 0);
});

check('a file-backed registry survives a restart and never throws on a read-only path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memeclaw-hints-'));
  const file = join(dir, 'hints.jsonl');
  const first = new HintRegistry({ path: file, clock: () => NOW });
  first.add({ chain: 'base', address: EVM, source: 'logs', paid: true });
  assert.equal(first.persistenceError, null);
  const text = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(text.length, 1);

  const reloaded = new HintRegistry({ path: file, clock: () => NOW });
  assert.equal(reloaded.size(), 1, 'a restart must not silently drop the queue');
  assert.equal(reloaded.pending()[0].paid, true);

  // A path that cannot be written is recorded, not thrown: a read-only volume
  // must not take the funnel down.
  const broken = new HintRegistry({ path: join(dir, 'missing-dir', 'hints.jsonl'), clock: () => NOW });
  const result = broken.add({ chain: 'base', address: EVM2, source: 'logs' });
  assert.equal(result.accepted, true, 'the hint is still queued in memory');
  assert.match(broken.persistenceError, /append_failed/);
});

check('a corrupt line in the hint file does not discard the rest of the queue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memeclaw-hints-'));
  const file = join(dir, 'hints.jsonl');
  const registry = new HintRegistry({ path: file, clock: () => NOW });
  registry.add({ chain: 'base', address: EVM, source: 'logs' });
  // Append a garbage line AFTER two good ones. The queue is a log, so a crash
  // mid-write corrupts one line, not the file: both the earlier and the later
  // valid hints must still load. (Writing the garbage between two good lines
  // tests nothing here — the same key cannot appear twice in one file.)
  writeFileSync(file, `${JSON.stringify({ chain: 'base', address: EVM, source: 'logs', discoveredAtMs: NOW })}\n`
    + 'not json at all\n'
    + `${JSON.stringify({ chain: 'base', address: EVM2, source: 'logs', discoveredAtMs: NOW })}\n`);
  const reloaded = new HintRegistry({ path: file, clock: () => NOW });
  assert.equal(reloaded.size(), 2, 'the corrupt line costs one hint, not the queue');
  assert.deepEqual(
    reloaded.pending().map(hint => hint.address).sort(),
    [EVM, EVM2].sort(),
  );
});

// ------------------------------------------------------------------ oracle ---

check('EVM oracle: non-empty code is exists:true with the byte count', async () => {
  const calls = [];
  const result = await existenceOracle(EVM, 'base', {
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body).method);
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x60806040' });
    },
  });
  assert.equal(result.exists, true);
  assert.equal(result.transportDown, false);
  assert.equal(result.method, 'eth_getCode');
  assert.equal(result.codeBytes, 4);
  assert.deepEqual(calls, ['eth_getCode']);
});

check('EVM oracle: empty code is exists:FALSE, not a transport failure', async () => {
  const result = await existenceOracle(EVM, 'base', {
    fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x' }),
  });
  assert.equal(result.exists, false);
  assert.equal(result.transportDown, false);
});

check('oracle: a JSON-RPC error inside HTTP 200 is transportDown, NEVER exists', async () => {
  // The measured PublicNode answer to an over-wide window: HTTP 200 + error.
  const result = await existenceOracle(EVM, 'eth', {
    fetchImpl: async () => rpcError(-32602, 'Archive requests require a personal token.'),
  });
  assert.equal(result.exists, null, 'exists must stay null; collapsing it to false deletes real candidates');
  assert.equal(result.transportDown, true);
  assert.equal(result.error, 'rpc_-32602');
  assert.equal(result.method, 'eth_getCode');
});

check('oracle: a network failure and a non-200 both fail OPEN', async () => {
  const network = await existenceOracle(EVM, 'eth', {
    fetchImpl: async () => { throw new Error('socket hang up'); },
  });
  assert.equal(network.exists, null);
  assert.equal(network.transportDown, true);
  assert.equal(network.error, 'network');

  const http = await existenceOracle(EVM, 'eth', {
    fetchImpl: async () => jsonResponse({ nope: true }, { status: 503 }),
  });
  assert.equal(http.exists, null);
  assert.equal(http.transportDown, true);
  assert.equal(http.error, 'http_503');
});

check('oracle: an unusable address is exists:false without spending a request', async () => {
  let called = 0;
  const result = await existenceOracle('nope', 'base', { fetchImpl: async () => { called += 1; return jsonResponse({}); } });
  assert.equal(result.exists, false);
  assert.equal(result.reason, 'invalid_address');
  assert.equal(called, 0);
});

check('oracle: solana existence is getAccountInfo, and a null value is a real "does not exist"', async () => {
  let method = null;
  const exists = await existenceOracle(SOL, 'sol', {
    fetchImpl: async (url, init) => {
      method = JSON.parse(init.body).method;
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', executable: false } } });
    },
  });
  assert.equal(method, 'getAccountInfo');
  assert.equal(exists.exists, true);
  assert.equal(exists.owner, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

  const absent = await existenceOracle(SOL, 'sol', {
    fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: { value: null } }),
  });
  assert.equal(absent.exists, false, 'value:null on a probed random 32-byte account is the absent case');
  assert.equal(absent.transportDown, false);
});

check('oracle: an unsupported chain fails open rather than inventing an answer', async () => {
  const result = await existenceOracle(EVM, 'doge', { fetchImpl: async () => jsonResponse({}) });
  assert.equal(result.exists, null);
  assert.equal(result.transportDown, true);
  assert.equal(result.reason, 'unsupported_chain');
});

// -------------------------------------------------------------- promotion ---

check('promotion happens ONLY on exists === true', async () => {
  const registry = new HintRegistry({ clock: () => NOW });
  registry.add({ chain: 'base', address: EVM, source: 'logs', discoveredAtMs: NOW });
  const result = await promoteChecked(registry, async () => ({ exists: true, transportDown: false, method: 'eth_getCode', codeBytes: 100 }));
  assert.equal(result.promoted, 1);
  assert.equal(result.dispositions[0].disposition, HINT_DISPOSITION.PROMOTED);
  assert.equal(result.records[0].address, normalizeTokenAddress('base', EVM));
  assert.equal(result.records[0].source, 'logs');
  assert.equal(registry.size(), 0, 'a promoted hint leaves the queue');
});

check('promotion accepts nothing else: false and null both refuse', async () => {
  for (const answer of [{ exists: false, transportDown: false }, { exists: null, transportDown: false }, { exists: undefined }, {}, null]) {
    const registry = new HintRegistry({ clock: () => NOW });
    registry.add({ chain: 'base', address: EVM, source: 'logs' });
    const result = await promoteChecked(registry, async () => answer);
    assert.equal(result.promoted, 0, `answer ${JSON.stringify(answer)} must not promote`);
    assert.equal(result.records.length, 0);
  }
});

check('a NON-EXISTENT address fails CLOSED: the hint is dropped, not re-queued', async () => {
  const registry = new HintRegistry({ clock: () => NOW });
  registry.add({ chain: 'base', address: EVM, source: 'logs' });
  const result = await promoteChecked(registry, async () => ({ exists: false, transportDown: false, reason: 'eth_getCode' }));
  assert.equal(result.promoted, 0);
  assert.equal(result.dispositions[0].disposition, HINT_DISPOSITION.ABSENT);
  assert.equal(registry.size(), 0, 'a phantom address must not come back next rotation');
});

check('TRANSPORT DOWN fails open: the hint is retained and the SOURCE is cooled down', async () => {
  const registry = new HintRegistry({ clock: () => NOW, cooldownFloorMs: 30_000 });
  registry.add({ chain: 'base', address: EVM, source: 'logs', discoveredAtMs: NOW });
  const result = await promoteChecked(registry, async () => ({ exists: null, transportDown: true, reason: 'rpc_-32602' }));
  assert.equal(result.promoted, 0);
  assert.equal(registry.size(), 1, 'the hint survives a transport failure');
  assert.equal(result.dispositions[0].disposition, HINT_DISPOSITION.TRANSPORT_DOWN);
  assert.equal(result.dispositions[0].retained, true);
  assert.equal(registry.isCoolingDown('logs'), true);
});

check('a cooling source does NOT starve the funnel: other sources keep promoting', async () => {
  const registry = new HintRegistry({ clock: () => NOW, cooldownFloorMs: 30_000 });
  registry.add({ chain: 'base', address: EVM, source: 'dead', discoveredAtMs: NOW });
  registry.add({ chain: 'base', address: EVM2, source: 'live', discoveredAtMs: NOW });
  registry.add({ chain: 'base', address: EVM3, source: 'live', discoveredAtMs: NOW });

  // First pass: 'dead' was checked and could not be reached.
  const first = await promoteChecked(registry, async (address) => (
    normalizeTokenAddress('base', address) === normalizeTokenAddress('base', EVM)
      ? { exists: null, transportDown: true, reason: 'rpc_-32602' }
      : { exists: true, transportDown: false, codeBytes: 10 }
  ));
  assert.equal(first.promoted, 2, 'the two live hints promote in the same pass as the failure');
  assert.equal(registry.isCoolingDown('dead'), true);

  // Second pass: the dead source's remaining hint is skipped by the cooldown,
  // and the skip costs zero oracle calls.
  let calls = 0;
  const second = await promoteChecked(registry, async () => { calls += 1; return { exists: true }; });
  assert.equal(calls, 0, 'a source in cooldown must not be re-probed');
  assert.equal(second.promoted, 0);
  assert.equal(second.dispositions[0].disposition, HINT_DISPOSITION.SKIPPED_COOLDOWN);
  assert.equal(registry.size(), 1, 'the hinted address is still queued for after the cooldown');
});

check('the cooldown expires on its own — nothing is left permanently stuck', async () => {
  let now = NOW;
  const registry = new HintRegistry({ clock: () => now, cooldownFloorMs: 30_000 });
  registry.add({ chain: 'base', address: EVM, source: 'logs', discoveredAtMs: now });
  await promoteChecked(registry, async () => ({ exists: null, transportDown: true, reason: 'network' }), { clock: () => now });
  assert.equal(registry.isCoolingDown('logs'), true);
  now += 30_001;
  assert.equal(registry.isCoolingDown('logs'), false);
  const retried = await promoteChecked(registry, async () => ({ exists: true, transportDown: false }), { clock: () => now });
  assert.equal(retried.promoted, 1, 'after the cooldown the hint is retried and promotes');
});

check('an oracle that throws is contained: it becomes a transport failure, not a crash', async () => {
  const registry = new HintRegistry({ clock: () => NOW });
  registry.add({ chain: 'base', address: EVM, source: 'logs' });
  const result = await promoteChecked(registry, async () => { throw new Error('boom'); });
  assert.equal(result.promoted, 0);
  assert.equal(result.dispositions[0].disposition, HINT_DISPOSITION.TRANSPORT_DOWN);
  assert.equal(registry.size(), 1);
});

check('promotion is capped per pass and the remainder stays queued for the next rotation', async () => {
  const registry = new HintRegistry({ clock: () => NOW });
  for (const [index, address] of [EVM, EVM2, EVM3].entries()) {
    registry.add({ chain: 'base', address, source: 'logs', discoveredAtMs: NOW + index });
  }
  const result = await promoteChecked(registry, async () => ({ exists: true, transportDown: false }), { limit: 2 });
  assert.equal(result.checked, 2);
  assert.equal(result.promoted, 2);
  assert.equal(registry.size(), 1, 'a hint is never dropped just because a pass ran out of budget');
  assert.equal(result.dispositions.at(-1).disposition, HINT_DISPOSITION.SKIPPED_LIMIT);
});

check('a promoted record labels its unknowns instead of shipping nulls as facts', () => {
  const registry = new HintRegistry({ clock: () => NOW });
  const hint = registry.add({ chain: 'base', address: EVM, source: 'profiles', paid: true }).hint;
  const record = registry.promote(hint, { checked: { exists: true, method: 'eth_getCode', codeBytes: 12 } });
  assert.equal(record.size.fdv, null);
  assert.equal(record.size.marketCap, null);
  assert.equal(record.liquidityUsd, null);
  assert.equal(record.pairCreatedAtSec, null);
  assert.ok(record.unresolved.includes('existence_verified_only'));
  assert.ok(record.unresolved.includes('liquidity_unknown'));
  assert.equal(record.evidence.oracle.exists, true);
  assert.equal(record.evidence.paid, true);
});

check('a promoted hint is not re-promoted on a later rotation', async () => {
  const registry = new HintRegistry({ clock: () => NOW });
  registry.add({ chain: 'base', address: EVM, source: 'logs' });
  const first = await promoteChecked(registry, async () => ({ exists: true }));
  assert.equal(first.promoted, 1, 'the hint promotes on the first rotation');
  // The launch feed sees the address again next rotation. Re-checking it would
  // spend an RPC call per rotation to re-learn something already proved, and
  // would double-count it if the record set is merged.
  const readd = registry.add({ chain: 'base', address: EVM, source: 'logs' });
  assert.equal(readd.accepted, false);
  assert.equal(readd.reason, 'already_promoted');
  assert.equal(registry.size(), 0, 'a promoted address does not re-enter the queue');
});

// ----------------------------------------------------------- logs emitter ---

check('logs emitter refuses to fire on a chain with no verified factory', async () => {
  const emitter = createLogsEmitter({ fetchImpl: async () => { throw new Error('network must not be touched'); } });
  const findings = [];
  // robinhood has no verified factory; sol cannot do logs at all.
  const robinhood = await emitter.discover('robinhood', { out: findings });
  assert.deepEqual(robinhood.hints, []);
  assert.equal(robinhood.skipped.length, 1);
  assert.match(robinhood.skipped[0].reason, /no verified factory/);
  assert.ok(findings.some(entry => /skipped/.test(entry.reason)), 'the skip must be visible in the events');

  const sol = await emitter.discover('sol', { out: findings });
  assert.deepEqual(sol.hints, []);
  assert.match(sol.skipped[0].reason, /Method not found/);
  assert.equal(emitter.enabled('sol'), false);
  assert.equal(emitter.enabled('robinhood'), false);
});

check('every shipped factory address is on-chain and recorded with its verification', () => {
  for (const [chain, list] of Object.entries(VERIFIED_FACTORIES)) {
    assert.ok(Array.isArray(list) && list.length > 0, `${chain} must have at least one verified factory`);
    for (const entry of list) {
      assert.equal(normalizeTokenAddress(chain, entry.address), entry.address, `${chain} ${entry.address} must be a valid lowercase token address`);
      assert.ok(entry.codeBytes > 0, `${chain} ${entry.address} shipped with no measured code size`);
      assert.match(entry.verifiedBy, /\S/, `${chain} ${entry.address} shipped without a verification note`);
    }
  }
  // The chains we deliberately do NOT cover carry a stated reason.
  for (const chain of ['sol', 'robinhood']) {
    assert.ok(SKIPPED_FACTORY_CHAINS[chain], `${chain} must ship a skip reason`);
  }
  assert.equal(Object.keys(SKIPPED_FACTORY_CHAINS).every(chain => !(chain in VERIFIED_FACTORIES)), true);
});

check('logs emitter decodes PairCreated into one hint per token side', async () => {
  const topic = EMISSION_TOPICS.pairCreated;
  const pool = '0x000000000000000000000000cccccccccccccccccccccccccccccccccccccc';
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'eth_blockNumber') return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x64' });
    if (body.method === 'eth_getLogs') {
      // The address filter is MANDATORY (measured -32701 without it), so the
      // stub asserts the emitter actually sends one.
      assert.ok(body.params[0].address, 'eth_getLogs must carry an address filter');
      assert.deepEqual(body.params[0].topics, [topic]);
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: [{
          topics: [topic, `0x${EVM.slice(2).padStart(64, '0')}`, `0x${EVM2.slice(2).padStart(64, '0')}`],
          data: `0x${pool.slice(2).padStart(64, '0')}${'0'.repeat(63)}1`,
          blockNumber: '0x64',
          logIndex: '0x0',
          transactionHash: '0xabc',
        }],
      });
    }
    throw new Error(`unexpected method ${body.method}`);
  };
  const emitter = createLogsEmitter({ fetchImpl, span: 10 });
  const result = await emitter.discover('base', { out: [] });
  assert.equal(result.hints.length, 2, 'both sides of the pair are separate candidates');
  const addresses = result.hints.map(hint => hint.address).sort();
  assert.deepEqual(addresses, [EVM, EVM2].sort());
  assert.equal(result.records.length, 0, 'the logs emitter can never emit a discovery record');
  assert.deepEqual(result.window, { fromBlock: 0x64 - 10 + 1, toBlock: 0x64, span: 10 });
});

check('logs emitter drops a burn address out of a real PairCreated log', async () => {
  const topic = EMISSION_TOPICS.pairCreated;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'eth_blockNumber') return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x64' });
    return jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: [{
        topics: [topic, `0x${EVM.slice(2).padStart(64, '0')}`, `0x${'0'.repeat(64)}`],
        data: `0x${'0'.repeat(64)}${'0'.repeat(63)}1`,
        blockNumber: '0x64',
        logIndex: '0x0',
        transactionHash: '0xabc',
      }],
    });
  };
  const result = await createLogsEmitter({ fetchImpl, span: 10 }).discover('base', { out: [] });
  assert.equal(result.hints.length, 1, 'the zero address side must not become a candidate');
  assert.equal(result.hints[0].address, EVM);
});

check('a JSON-RPC error in a log window is a finding, never an exception', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'eth_blockNumber') return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x64' });
    return rpcError(-32602, 'Archive requests require a personal token.');
  };
  const findings = [];
  const result = await createLogsEmitter({ fetchImpl, span: 10 }).discover('eth', { out: findings });
  assert.deepEqual(result.hints, []);
  assert.ok(findings.some(entry => /rpc_-32602/.test(entry.reason)), 'the archive refusal is reported');
  assert.equal(findings.every(entry => entry.level === 'warn'), true);
});

check('the log window walks forward instead of replaying the same blocks forever', async () => {
  // One eth_getLogs per (chain, factory), so base issues the SAME window twice in
  // a pass — once for each of its two verified factories. A replay means reading
  // a window a PREVIOUS pass already read, not issuing two requests: comparing
  // raw request counts would flag base's two factories as a rewind.
  const windows = [];
  let head = 0x64;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'eth_blockNumber') return jsonResponse({ jsonrpc: '2.0', id: 1, result: `0x${head.toString(16)}` });
    windows.push(`${body.params[0].fromBlock}-${body.params[0].toBlock}`);
    return jsonResponse({ jsonrpc: '2.0', id: 1, result: [] });
  };
  const factoriesPerPass = VERIFIED_FACTORIES.base.length;
  const emitter = createLogsEmitter({ fetchImpl, span: 10 });
  await emitter.discover('base', { out: [] });
  head = 0x200;
  await emitter.discover('base', { out: [] });
  assert.equal(windows.length, factoriesPerPass * 2, 'each pass queries one window per factory');
  const first = windows.slice(0, factoriesPerPass);
  const second = windows.slice(factoriesPerPass);
  assert.equal(new Set(first).size, 1, 'one pass reads one window for every factory');
  assert.notEqual(first[0], second[0], 'the next pass must read NEW blocks, not replay the last window');
  // The cursor must also land exactly at the head of the last window it read.
  assert.equal(second[0], '0x65-0x6e', `window must advance by exactly span, got ${second[0]}`);
});

check('logs emitter waits instead of asking for blocks that do not exist yet', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'eth_blockNumber') return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x64' });
    throw new Error('must not query a window past the head');
  };
  const emitter = createLogsEmitter({ fetchImpl, span: 50 });
  await emitter.discover('base', { out: [] });
  const second = await emitter.discover('base', { out: [] });
  assert.match(second.skipped[0].reason, /new blocks/);
});

// ------------------------------------------------------- profiles emitter ---

check('profiles emitter attributes rows to the requested chain only', async () => {
  const rows = [
    { chainId: 'solana', tokenAddress: SOL, url: 'https://dexscreener.com/solana/x', description: 'a' },
    { chainId: 'solana', tokenAddress: SOL, url: 'https://dexscreener.com/solana/x', description: 'dup' },
    { chainId: 'bsc', tokenAddress: EVM, url: 'https://dexscreener.com/bsc/y' },
    { chainId: 'solana', tokenAddress: 'not-base58!', url: 'https://dexscreener.com/solana/z' },
  ];
  const emitter = createProfilesEmitter({
    fetchImpl: async () => jsonResponse(rows),
    chains: ['sol'],
  });
  const result = await emitter.discover('sol', { out: [] });
  assert.equal(result.hints.length, 1, 'dedupe by chain:address and reject what sol cannot hold');
  assert.equal(result.hints[0].address, SOL);
  assert.equal(result.hints[0].paid, true, 'a promotional listing is labelled as such');
  assert.equal(result.matched, 3, 'the row count is reported, including the unusable one');
  assert.equal(result.records.length, 0, 'profiles carry no size fields and can never be rows');
});

check('profiles emitter says "answered, nothing for this chain" instead of failing silently', async () => {
  const findings = [];
  // The feed answers with one solana row, but we ask about bsc. "Nothing for you"
  // is a real answer and belongs in the events; silence would read as a dead feed.
  const emitter = createProfilesEmitter({ fetchImpl: async () => jsonResponse([{ chainId: 'solana', tokenAddress: SOL }]), chains: ['bsc'] });
  const result = await emitter.discover('bsc', { out: findings });
  assert.deepEqual(result.hints, []);
  assert.equal(result.rows, 1, 'the feed did answer');
  assert.equal(result.matched, 0);
  assert.ok(
    findings.some(entry => entry.level === 'info' && /none for bsc/.test(entry.reason)),
    `expected an info finding naming bsc, got ${JSON.stringify(findings)}`,
  );
});

// --------------------------------------------------- coordinator plumbing ---

check('the coordinator shim queues hints and returns NO records (the gate cannot be bypassed)', async () => {
  const registry = new HintRegistry({ clock: () => NOW });
  const raw = createProfilesEmitter({ fetchImpl: async () => jsonResponse([{ chainId: 'base', tokenAddress: EVM }]), chains: ['base'] });
  const shim = toCoordinatorEmitter(raw, registry);
  assert.equal(shim.id, 'profiles');
  assert.equal(shim.provider, 'EMISSION', 'not a market provider: no price data comes from here');
  const records = await shim.discover('base', { out: [] });
  assert.deepEqual(records, [], 'a raw emitter wired in directly would publish unverified addresses');
  assert.equal(registry.size(), 1, 'but the hint IS queued');
});

check('the shim rejects a missing registry instead of silently dropping hints', () => {
  assert.throws(() => toCoordinatorEmitter({ discover: async () => ({ hints: [] }) }, null), /HintRegistry/);
  assert.throws(() => toCoordinatorEmitter(null, new HintRegistry()), /discover/);
});

check('shim registration widens the provider set by exactly one entry', async () => {
  const { DiscoveryCoordinator } = await import('../../src/ingest/coordinator.mjs');
  const registry = new HintRegistry({ clock: () => NOW });
  const coordinator = new DiscoveryCoordinator({
    emitters: [toCoordinatorEmitter(createProfilesEmitter({ fetchImpl: async () => jsonResponse([]) }), registry)],
  });
  assert.deepEqual(coordinator.providers, ['EMISSION']);
  const run = await coordinator.discover('base');
  assert.equal(run.records.length, 0, 'even through the real coordinator, no hint becomes a row');
});

// ------------------------------------------------------------------ report ---

// node:test queues every test() above and runs them after this module finishes
// evaluating, so the summary has to live in an after() hook: a plain
// console.log at the bottom of the file would print "0/34 passed" before a
// single test had executed. node:test also owns the process exit code, so this
// summary is for the human reading the log, not for the exit status.
after(() => {
  const failed = results.filter(entry => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  for (const entry of failed) console.log(`FAIL ${entry.name}\n     ${entry.error}`);
});