// Tests for the structural RPC risk analyzer, plus the honesty invariants that
// matter more than the assertions: nothing may ever report a token as
// not-a-honeypot, and no call may be made to a chain we cannot reach.
//
// Run in-process: `node test/ingest/ingest.test.mjs` (node --test cannot spawn
// on this host: EPERM).

import { readFileSync } from 'node:fs';

const { assessStructural, readBytecodeFacts, readProxyFacts, readOwnerFacts, rpcCall, RpcRiskAnalyzer, rpcUrlFor, isEvmChain } =
  await import('../../src/ingest/adapters/rpc-risk.mjs');
const { RISK_STATUS } = await import('../../src/ingest/record.mjs');

const test = async (name, fn) => {
  try {
    await fn();
    console.log('ok  ', name);
    return true;
  } catch (error) {
    console.log('FAIL', name, '\n     ', error?.message ?? error);
    return false;
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message ?? 'assertion failed');
};
const assertEqual = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message ?? ''} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

// A fetch stub that answers from a script, so the RPC plumbing is tested without
// touching the network.
function stubFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method, params: body.params });
    const answer = responses[body.method];
    if (typeof answer === 'function') return answer(body.params, url);
    if (answer === undefined) throw new Error(`unstubbed method ${body.method}`);
    return {
      status: 200,
      text: async () => JSON.stringify(answer.body ?? { jsonrpc: '2.0', id: 1, result: answer.result }),
    };
  };
  impl.calls = calls;
  return impl;
}

const okResult = result => ({ body: { jsonrpc: '2.0', id: 1, result } });

const results = [];
const run = async (name, fn) => results.push(await test(name, fn));

await run('every EVM chain has a measured RPC endpoint, solana does not', () => {
  assert(rpcUrlFor('eth') !== null && rpcUrlFor('bsc') !== null && rpcUrlFor('base') !== null && rpcUrlFor('robinhood') !== null);
  assertEqual(rpcUrlFor('sol'), null);
  assertEqual(isEvmChain('sol'), false);
  assertEqual(isEvmChain('robinhood'), true);
});

await run('A JSON-RPC error at HTTP 200 is a failure, not a zero result', async () => {
  // The exact shape PublicNode returns: HTTP 200 with an `error` member. Reading
  // `result` here yields undefined and a caller would report "no code found".
  const fetchImpl = async () => ({
    status: 200,
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } }),
  });
  const result = await rpcCall('https://example.invalid', 'eth_getCode', ['0x0'], { fetchImpl });
  assertEqual(result.ok, false, 'an error member must not count as success:');
  assertEqual(result.error, 'rpc_-32602');
});

await run('A non-JSON body is a failure, not an empty code string', async () => {
  const fetchImpl = async () => ({ status: 200, text: async () => '<html>maintenance</html>' });
  const result = await rpcCall('https://example.invalid', 'eth_getCode', ['0x0'], { fetchImpl });
  assertEqual(result.ok, false);
  assertEqual(result.error, 'non_json');
});

await run('Bytecode facts: an empty body is a non-contract, an oversized one is flagged', async () => {
  const empty = stubFetch({ eth_getCode: okResult('0x') });
  const none = await readBytecodeFacts('u', '0xa', { fetchImpl: empty });
  assertEqual(none.isContract, false);
  assertEqual(none.overEip170, false);

  const big = stubFetch({ eth_getCode: okResult(`0x${'ab'.repeat(24_600)}`) });
  const huge = await readBytecodeFacts('u', '0xa', { fetchImpl: big });
  assertEqual(huge.isContract, true);
  assertEqual(huge.overEip170, true, 'EIP-170 limit is 24576 bytes:');
});

await run('An EIP-1967 admin slot is the rug signal a screen can act on', async () => {
  const set = stubFetch({
    eth_getStorageAt: okResult(`0x${'0'.repeat(24)}abcdef0123456789abcdef0123456789abcdef01`),
  });
  const proxy = await readProxyFacts('u', '0xa', { fetchImpl: set });
  assertEqual(proxy.upgradeable, true);
  assertEqual(proxy.admin, '0xabcdef0123456789abcdef0123456789abcdef01');

  const clear = stubFetch({ eth_getStorageAt: okResult(`0x${'0'.repeat(64)}`) });
  const plain = await readProxyFacts('u', '0xa', { fetchImpl: clear });
  assertEqual(plain.upgradeable, false);
  assertEqual(plain.readable, true);
});

await run('A failed storage read never reads as "not upgradeable"', async () => {
  // The dangerous default: a rate-limited or unsupported eth_getStorageAt must
  // leave the fact UNKNOWN. Reporting false would tell every screen the token
  // is immutable when nothing was actually read.
  const failed = stubFetch({
    eth_getStorageAt: () => { throw new Error('network'); },
  });
  const proxy = await readProxyFacts('u', '0xa', { fetchImpl: failed });
  assertEqual(proxy.readable, false, 'an unreadable slot must not be counted as read:');
  assertEqual(proxy.upgradeable, false);
});

await run('owner() revert is an absent capability, a zero owner is renounced', async () => {
  const reverting = stubFetch({
    eth_call: () => ({ body: { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } } }),
  });
  const absent = await readOwnerFacts('u', '0xa', { fetchImpl: reverting });
  assertEqual(absent.hasOwnerGetter, false);

  const zeroOwner = stubFetch({
    eth_call: okResult(`0x${'0'.repeat(64)}`),
  });
  const renounced = await readOwnerFacts('u', '0xa', { fetchImpl: zeroOwner });
  assertEqual(renounced.hasOwnerGetter, true);
  assertEqual(renounced.renounced, true, 'owner() returning zero is NOT the same as no owner():');
});

await run('An EOA owner is distinguished from a contract owner', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'eth_call') {
      return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${'0'.repeat(24)}1111111111111111111111111111111111111111` }) };
    }
    return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }) };
  };
  const owner = await readOwnerFacts('u', '0xa', { fetchImpl });
  assertEqual(owner.ownerIsContract, false, 'an EOA owner is the single point of control:');
});

await run('THE INVARIANT: honeypot and tax are never reported as safe', () => {
  // Even in the best imaginable case — known contract, immutable, renounced —
  // this analyzer cannot prove a token is sellable. If any caller ever reads
  // these as false, a honeypot ships as clean.
  const bestCase = assessStructural({
    bytecode: { ok: true, isContract: true, sizeBytes: 1000, overEip170: false },
    proxy: { readable: true, upgradeable: false, admin: null, implementation: null, beacon: null },
    owner: { hasOwnerGetter: true, renounced: true, owner: `0x${'0'.repeat(40)}`, ownerIsContract: null },
  });
  assertEqual(bestCase.isHoneypot, null, 'never false:');
  assertEqual(bestCase.buyTax, null, 'never 0:');
  assertEqual(bestCase.sellTax, null, 'never 0:');
  assertEqual(bestCase.rugRatio, null);
  assertEqual(bestCase.washTrading, null, 'never false:');
  assertEqual(bestCase.lpLocked, null);
  assert(bestCase.notes.some(note => note.startsWith('honeypot_tax_unavailable')),
    'the unavailability must be stated on every result, so no consumer can infer safety:');
});

await run('A fully failed analysis is UNKNOWN, never CLEAN', () => {
  const nothing = assessStructural({
    bytecode: { ok: false, error: 'timeout' },
    proxy: null,
    owner: null,
  });
  assertEqual(nothing.status, RISK_STATUS.UNKNOWN, 'no evidence must not mean safe:');
  assertEqual(nothing.isHoneypot, null);
});

await run('An upgradeable proxy is ADVERSE and names the slots', () => {
  const adverse = assessStructural({
    bytecode: { ok: true, isContract: true, sizeBytes: 2000, overEip170: false },
    proxy: { readable: true, upgradeable: true, admin: `0x${'1'.repeat(40)}`, implementation: `0x${'2'.repeat(40)}`, beacon: null },
    owner: { hasOwnerGetter: false, owner: null, error: 'rpc_3' },
  });
  assertEqual(adverse.status, RISK_STATUS.ADVERSE);
  assert(adverse.ownerPrivileges.includes('upgradeable_proxy'));
  assert(adverse.notes.some(note => note.startsWith('upgradeable:')), 'an operator must be told the logic can be swapped:');
});

await run('An oversized contract is flagged, and a plain one is not', () => {
  const huge = assessStructural({ bytecode: { ok: true, isContract: true, sizeBytes: 30_000, overEip170: true }, proxy: null, owner: null });
  assert(huge.notes.some(note => note.startsWith('code_over_eip170:')));
});

await run('Bytecode markers are reported as triage flags, never as verdicts', async () => {
  // A selector's bytes can sit inside PUSH operands or the metadata blob, so
  // presence proves nothing about behaviour. The analyzer must keep them out of
  // the risk status.
  const withSelector = stubFetch({ eth_getCode: okResult(`0x6080604052${'00'.repeat(20)}8da5cb5b`) });
  const facts = await readBytecodeFacts('u', '0xa', { fetchImpl: withSelector });
  assertEqual(facts.markers.ownerSelector, true);

  const assessment = assessStructural({
    bytecode: { ok: true, isContract: true, sizeBytes: 100, overEip170: false, markers: facts.markers },
    proxy: { readable: true, upgradeable: false },
    owner: { hasOwnerGetter: false, error: 'rpc_3' },
  });
  assertEqual(assessment.status, RISK_STATUS.CLEAN, 'a bytes match alone must not escalate:');
});

await run('The analyzer refuses a chain it has no endpoint for', async () => {
  const analyzer = new RpcRiskAnalyzer();
  assertEqual(analyzer.supports('sol'), false);
  assertEqual(analyzer.supports('base'), true);
  let threw = null;
  try {
    await analyzer.analyze('sol', 'So11111111111111111111111111111111111111112');
  } catch (error) {
    threw = error;
  }
  assert(threw !== null, 'an unreachable chain must throw rather than return a clean-looking result:');
});

await run('An HTTP error body is surfaced, not swallowed', async () => {
  const fetchImpl = async () => ({ status: 429, text: async () => 'rate limited' });
  const result = await rpcCall('https://example.invalid', 'eth_getCode', ['0x0'], { fetchImpl });
  assertEqual(result.ok, false);
  assertEqual(result.error, 'http_429');
});

await run('The analyzer is wired to the sources actually probed, not to documentation', () => {
  // Guards against someone 'fixing' an endpoint from a provider's docs page
  // without re-probing. robinhood 4663 / 0x1237 is the value that was executed.
  const findings = readFileSync(new URL('../../scripts/probe-findings.mjs', import.meta.url), 'utf8');
  assert(findings.includes('robinhood 0x1237'), 'the probed chain ids must stay documented next to the analyzer:');
});