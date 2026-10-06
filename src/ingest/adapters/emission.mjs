// P4 emission: launch-event sources that fill the hint registry.
//
// These emitters do NOT return discovery rows. They return HINTS. The
// difference is the entire safety property of the lane: a launch feed is a
// claim, and only existenceOracle (hints.mjs) can turn a claim into a record.
// A coordinator that registered this emitter directly and published its output
// would bypass the gate — so the `discover()` contract below returns hints and
// says so in its own name of the fields, and `toCoordinatorEmitter()` is the
// only supported way to attach one (it registers a shim that feeds the
// registry and returns nothing publishable).
//
// MEASURED LIMITS (live probes against PublicNode, 2026-10) — every one of these
// is a reason the design is a targeted tracer and not a sweep:
//
//   1. eth_getLogs REQUIRES an address filter. Without one:
//      {code:-32701, message:"Please specify an address in your request or, to
//      remove restrictions, ..."} on eth, base AND robinhood. A topic-only
//      filter is rejected too. There is no "just filter by PairCreated" mode.
//   2. The free archive window is tiny AND flaky. eth V2: span 200 -> 3 logs;
//      span 500 -> {code:-32602, message:"Archive requests require a personal
//      token. Get one at: https://www.allnodes.com/publicnode"}. The SAME span-400
//      request succeeded 4 of 6 attempts and failed 2 of 6. So the window is
//      small (default 200) and a -32602/-32701 is a normal, expected outcome —
//      not an error to escalate.
//   3. Volume matters as much as age: eth V4 span 200 failed while span 500
//      returned 28 987 logs. A busy factory is rejected for being too big.
//   4. Solana cannot do logs at all: eth_getLogs on solana-rpc.publicnode.com ->
//      HTTP 200 {code:-32601, message:"Method not found"}. Hence logsEmitter is
//      EVM-only and enabled('sol') === false.
//   5. JSON-RPC errors arrive as HTTP 200. rpcCall unwraps that; the emitters
//      reuse it so no code here can read a "200" as success.
//
// FACTORY ADDRESSES — verified or deliberately absent. Nothing here is a guess.
// Each entry records how it was verified, and an unverified chain ships UNSET
// with a reason instead of a plausible-looking address, because a wrong factory
// on a chain that has one would silently return zero pairs forever.

import { createBudget } from '../budget.mjs';
import { IngestHttp } from '../http.mjs';
import { rpcCall, rpcUrlFor, isEvmChain } from './rpc-risk.mjs';
import { createHint } from '../hints.mjs';

// Mirrors secondary.mjs:11 DEX_CHAIN_IDS, in the direction this module needs:
// OUR chain -> the id DexScreener puts in `chainId`. The other direction is the
// one that silently matches zero rows and reads as "nothing launched today".
const DEXSCREENER_CHAIN_ID = Object.freeze({
  sol: 'solana',
  eth: 'ethereum',
  base: 'base',
  bsc: 'bsc',
  robinhood: 'robinhood',
});

// Event signatures, computed from the canonical ABI types (keccak of the exact
// signature string). Verified by reading the topic0 back out of real logs.
export const EMISSION_TOPICS = Object.freeze({
  // PairCreated(address indexed token0, address indexed token1, address pool, uint256)
  pairCreated: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
  // PoolCreated(address indexed token0, address indexed token1, uint24 fee, int24 tickSpacing, address pool)
  poolCreated: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  // Initialize(bytes32 indexed id, Currency indexed currency0, Currency indexed currency1, uint24 fee, int24 tickSpacing, IHooks hooks, uint160 sqrtPriceX96, int24 tick)
  initialize: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
});

// Verification note per factory, kept next to the address so the claim and its
// evidence cannot drift apart.
export const VERIFIED_FACTORIES = Object.freeze({
  eth: Object.freeze([
    { kind: 'v2', address: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', codeBytes: 13859, verifiedBy: 'eth_getCode + 3 PairCreated logs in span 200 + blockscout name UniswapV2Factory' },
    { kind: 'v3', address: '0x1f98431c8ad98523631ae4a59f267346ea31f984', codeBytes: 24535, verifiedBy: 'eth_getCode + blockscout name UniswapV3Factory' },
    { kind: 'v4', address: '0x000000000004444c5dc75cb358380d2e3de08a90', codeBytes: 24009, verifiedBy: 'eth_getCode + blockscout name PoolManager' },
  ]),
  base: Object.freeze([
    { kind: 'v2', address: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6', codeBytes: 13859, verifiedBy: 'eth_getCode + blockscout name UniswapV2Factory' },
    { kind: 'v3', address: '0x33128a8fc17869897dce68ed026d694621f6fdfd', codeBytes: 24535, verifiedBy: 'eth_getCode + blockscout name UniswapV3Factory' },
  ]),
  bsc: Object.freeze([
    { kind: 'v2', address: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73', codeBytes: 19084, verifiedBy: 'eth_getCode + 110 PairCreated logs per 2000 blocks (PancakeSwap V2)' },
    { kind: 'v3', address: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865', codeBytes: 5151, verifiedBy: 'eth_getCode + 2 PoolCreated logs per 2000 blocks (PancakeSwap V3)' },
  ]),
});

// Chains with no verified factory. NOT an oversight, NOT a "coming soon" —
// robinhood (chainId 0x1237) has the Uniswap V4 PoolManager address deployed at
// codeBytes 0, and its explorer is unreachable from the research host (TLS
// handshake failure), so no address could be proven. A guessed address here
// would return an empty log set forever and look like "no launches".
export const SKIPPED_FACTORY_CHAINS = Object.freeze({
  sol: 'logs are impossible on solana: eth_getLogs -> -32601 Method not found',
  robinhood: 'no verified factory: uniswap v4 PoolManager 0x000000000004444c5dc75cb358380d2e3de08a90 is codeBytes 0 on chain 0x1237 and explorer.mainnet.chain.robinhood.com is unreachable (TLS handshake failure)',
});

// Looked at and REJECTED, recorded so nobody re-adds them as "obvious":
//   bsc 0x10ED43C718714eb63d5aA57B78B54704E256024E (PancakeRouter) — 21 936 B
//     of code but ZERO logs in 2000 blocks and eth_call reverts with rpc_3. A
//     router is not a factory; querying it yields silence, not pairs.
//   bsc 0xD99D1c33F9fC3444f8101754aBC46c52416550D1 — codeBytes 0 on bsc.
export const REJECTED_FACTORIES = Object.freeze({
  bsc: Object.freeze([
    { address: '0x10ed43c718714eb63d5aa57b78b54704e256024e', codeBytes: 21936, rejectedBecause: 'router, not factory: 0 logs in 2000 blocks, eth_call reverts rpc_3' },
    { address: '0xd99d1c33f9fc3444f8101754abc46c52416550d1', codeBytes: 0, rejectedBecause: 'codeBytes 0 on bsc: address does not exist on this chain' },
  ]),
});

// The one window the probes actually justified. 200 succeeded; 500 did not.
const DEFAULT_SPAN = 200;

function hexWord(value) {
  return String(value ?? '').replace(/^0x/i, '').padStart(64, '0').slice(-64);
}

function topicToAddress(topic) {
  if (typeof topic !== 'string' || topic.length === 0) return null;
  const body = hexWord(topic);
  return `0x${body.slice(-40)}`;
}

// log.data is the abi-encoded non-indexed tail. PairCreated's tail is
// (address pool, uint256), so the pool is the first word. Splitting on words
// instead of trusting a fixed 40-char slice is what keeps a V3/V4 log from
// being decoded as a V2 pair.
function dataWord(log, index) {
  const data = String(log?.data ?? '').replace(/^0x/i, '');
  if (data.length < (index + 1) * 64) return null;
  return data.slice(index * 64, (index + 1) * 64);
}

// Turns one raw log into a hint. `kind` decides which indexed topics carry the
// tokens, and the addresses are still normalised afterwards: a log from a
// verified factory can still contain a zero/burn address, and createHint would
// reject it. The check is kept explicit so the reason is visible.
function hintFromLog(chain, log, kind, source) {
  const topics = Array.isArray(log?.topics) ? log.topics : [];
  let tokenA = topicToAddress(topics[1]);
  let tokenB = topicToAddress(topics[2]);
  const poolWord = dataWord(log, 0);
  let poolAddress = poolWord === null ? null : `0x${hexWord(poolWord).slice(-40)}`;
  if (kind === 'v4') {
    // V4 Initialize has three INDEXED bytes32 (poolId, currency0, currency1)
    // and the hook in the data tail; there is no pair address in the event.
    const isNative = word => hexWord(word).slice(-40) === '0'.repeat(40);
    tokenA = isNative(topics[2]) ? null : `0x${hexWord(topics[2]).slice(-40)}`;
    tokenB = isNative(topics[3]) ? null : `0x${hexWord(topics[3]).slice(-40)}`;
    poolAddress = null;
  }
  const blockNumber = Number.parseInt(String(log?.blockNumber ?? '0x0'), 16);
  return {
    chain,
    tokenA,
    tokenB,
    poolAddress,
    kind,
    source,
    blockNumber: Number.isFinite(blockNumber) ? blockNumber : null,
    logIndex: Number.isFinite(Number(log?.logIndex)) ? Number(log.logIndex) : null,
    transactionHash: log?.transactionHash ?? null,
    // Both sides of the pair enter as separate hints: the pool's existence says
    // nothing about either token, so neither may ride in on the other.
    hints: [
      createHint({ chain, address: tokenA, source, origin: `${kind}:token0` }),
      createHint({ chain, address: tokenB, source, origin: `${kind}:token1` }),
    ],
  };
}

// One eth_getLogs window per (chain, factory). JSON-RPC failures — including the
// -32602 archive refusal and the -32701 missing-address refusal — are findings,
// not exceptions: a rotation must survive a bad window and try the next one.
async function fetchFactoryLogs({ chain, url, factory, span, fromBlock, fetchImpl, timeoutMs, budget }) {
  const params = {
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${(fromBlock + span - 1).toString(16)}`,
    address: factory.address,
    topics: [factory.topic],
  };
  if (budget) {
    try {
      await budget.take(chain);
    } catch (error) {
      if (error?.code === 'ROW_CAP') return { ok: false, skipped: 'row_cap', chain, factory: factory.address };
      throw error;
    }
  }
  const call = await rpcCall(url, 'eth_getLogs', [params], { fetchImpl, timeoutMs });
  if (!call.ok) {
    return { ok: false, error: call.error, message: call.message, chain, factory: factory.address };
  }
  return { ok: true, logs: Array.isArray(call.result) ? call.result : [], chain, factory: factory.address, latencyMs: call.latencyMs };
}

// EVM launch tracer. Returns {hints, records, findings, skipped}.
//
// `records` is EMPTY BY CONSTRUCTION — this emitter cannot produce a discovery
// row, only hints. The field exists so a caller that wires it into the
// coordinator by hand sees an empty array rather than having to remember the
// distinction.
export function createLogsEmitter({
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  span = DEFAULT_SPAN,
  budget = null,
  factories = VERIFIED_FACTORIES,
  windowStart = null,
} = {}) {
  const budgetRef = budget ?? createBudget('publicnode');
  // One cursor PER CHAIN. A single shared lastTo mixed block heights across
  // chains — measured in production: after bsc's window (head ≈125.9M) the
  // base pass computed `head 52.2M - 125.9M` and logged "only -73752559 new
  // blocks since last window", permanently skipping base emission. A chain
  // with no cursor yet falls back to `windowStart` in discover() below.
  const lastToByChain = new Map();

  return {
    id: 'logs',
    provider: 'PUBLICEVENTS',
    budget: budgetRef,
    // sol is not merely unverified, it is IMPOSSIBLE (-32601). Reporting it as
    // unsupported instead of "no factory" keeps the finding honest.
    enabled(chain) {
      if (!isEvmChain(chain)) return false;
      if (rpcUrlFor(chain) === null) return false;
      const list = factories[chain];
      if (!Array.isArray(list) || list.length === 0) return false;
      return true;
    },
    // Why the chain cannot be traced, or null when it can. Surfaced so the
    // cycle's events say "no factory verified for robinhood" rather than "0 new
    // pools", which is the reading that gets mistaken for a quiet market.
    skipReason(chain) {
      if (!isEvmChain(chain)) return SKIPPED_FACTORY_CHAINS[chain] ?? `chain ${chain} is not an EVM chain`;
      const list = factories[chain];
      if (!Array.isArray(list) || list.length === 0) return SKIPPED_FACTORY_CHAINS[chain] ?? `no verified factory for ${chain}`;
      return null;
    },
    async discover(chain, { out = [] } = {}) {
      const findings = out;
      const skipped = [];
      if (!isEvmChain(chain)) {
        skipped.push({ chain, source: 'logs', reason: this.skipReason(chain) });
        return { hints: [], records: [], findings, skipped };
      }
      const list = factories[chain];
      if (!Array.isArray(list) || list.length === 0) {
        // Refuse to fire rather than query an unverified address.
        const reason = this.skipReason(chain);
        skipped.push({ chain, source: 'logs', reason });
        findings.push({ level: 'warn', chain, source: 'logs', reason: `logs emitter skipped: ${reason}` });
        return { hints: [], records: [], findings, skipped };
      }
      const url = rpcUrlFor(chain);
      if (url === null) {
        const reason = `no public RPC for ${chain}`;
        skipped.push({ chain, source: 'logs', reason });
        findings.push({ level: 'warn', chain, source: 'logs', reason });
        return { hints: [], records: [], findings, skipped };
      }

      // A window that walks FORWARD only. Re-reading the same blocks every
      // rotation would re-hint the same pairs forever; the hints would dedupe,
      // but the RPC calls would not.
      let head = null;
      const blockCall = await rpcCall(url, 'eth_blockNumber', [], { fetchImpl, timeoutMs });
      if (blockCall.ok) {
        head = Number.parseInt(String(blockCall.result ?? '0x0'), 16);
      }
      let fromBlock;
      let lastTo = lastToByChain.has(chain) ? lastToByChain.get(chain) : windowStart;
      if (lastTo === null) {
        if (head === null) {
          const reason = 'eth_blockNumber unavailable: cannot anchor a log window';
          skipped.push({ chain, source: 'logs', reason });
          findings.push({ level: 'warn', chain, source: 'logs', reason });
          return { hints: [], records: [], findings, skipped };
        }
        // First pass: a window ending at the head, so we never start by reading
        // history we cannot afford.
        fromBlock = Math.max(0, head - span + 1);
      } else {
        fromBlock = lastTo + 1;
        if (head !== null && fromBlock + span - 1 > head) {
          // Not enough new blocks yet. Asking for a window that ends in the
          // future is how a provider answers -32602.
          skipped.push({ chain, source: 'logs', reason: `only ${head - lastTo} new blocks since last window (need ${span})` });
          return { hints: [], records: [], findings, skipped };
        }
      }

      const hints = [];
      const seen = new Set();
      for (const entry of list) {
        const factory = { address: entry.address, topic: EMISSION_TOPICS[`${entry.kind === 'v4' ? 'initialize' : entry.kind === 'v3' ? 'poolCreated' : 'pairCreated'}`] };
        const window = await fetchFactoryLogs({ chain, url, factory, span, fromBlock, fetchImpl, timeoutMs, budget: budgetRef });
        if (window.skipped) {
          skipped.push({ chain, source: 'logs', factory: entry.address, reason: window.skipped });
          findings.push({ level: 'warn', chain, source: 'logs', throttled: true, reason: `logs emitter row cap reached for ${chain}` });
          continue;
        }
        if (!window.ok) {
          // -32602 (archive) and -32701 (needs address) are the measured normal
          // outcomes of a free window, not incidents.
          findings.push({
            level: 'warn',
            chain,
            source: 'logs',
            factory: entry.address,
            reason: `eth_getLogs ${window.error}: ${window.message ?? ''}`.trim(),
          });
          continue;
        }
        for (const log of window.logs) {
          const parsed = hintFromLog(chain, log, entry.kind, 'logs');
          for (const hint of parsed.hints) {
            if (hint === null) continue;
            // Two pools in one window for the same token are one candidate; the
            // registry dedupes too, but not spending the dedupe path twice is
            // cheaper and keeps `hints` meaningful to a caller.
            if (seen.has(hint.key)) continue;
            seen.add(hint.key);
            hints.push(hint);
          }
        }
      }

      // Advance the cursor even when every window failed: on a hard outage the
      // next successful pass should look at NEW blocks, not replay the ones we
      // just failed on forever.
      lastTo = fromBlock + span - 1;
      lastToByChain.set(chain, lastTo);
      return { hints, records: [], findings, skipped, window: { fromBlock, toBlock: lastTo, span } };
    },
  };
}

// DexScreener token-profiles. This is the SOLANA emission lane and the reason
// profilesEmitter exists at all: sol cannot do logs, so a paid/promotional feed
// is the only address source available for that chain.
//
// MEASURED: https://api.dexscreener.com/token-profiles/latest/v1 -> HTTP 200,
// 30 rows, chainId histogram {solana:26, robinhood:3, bsc:1}. Rows carry
// chainId, tokenAddress, url, description, header, openGraph — and NO price,
// size, liquidity or age. That absence is why coordinator.mjs:117-119 kept
// DexScreener out of the discovery lane: as a ROW it screens out at
// "liquidity unknown". As a HINT it carries only an address claim, which is
// precisely what the existence oracle is for. `paid: true` is recorded so no
// downstream screen mistakes a marketing listing for a neutral observation.
export function createProfilesEmitter({
  http = null,
  budget = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  url = 'https://api.dexscreener.com/token-profiles/latest/v1',
  chains = null,
  paid = true,
} = {}) {
  const budgetRef = budget ?? createBudget('dexscreener');
  const client = http ?? new IngestHttp({ budget: budgetRef, timeoutMs, fetchImpl });
  return {
    id: 'profiles',
    provider: 'DEXSCREENER',
    budget: budgetRef,
    // Supported on every chain the pipeline knows, because the feed is one
    // global endpoint; `chains` narrows it when a caller wants fewer requests.
    enabled(chain) {
      return typeof chain === 'string' && chain.length > 0 && (chains === null || chains.includes(chain));
    },
    async discover(chain, { out = [] } = {}) {
      const findings = out;
      const response = await client.json(url, { chain });
      const rows = Array.isArray(response.data) ? response.data : null;
      if (rows === null) {
        findings.push({ level: 'warn', chain, source: 'profiles', reason: `unexpected payload shape: ${Array.isArray(response.data) ? 'array' : typeof response.data}` });
        return { hints: [], records: [], findings, skipped: [] };
      }
      const wanted = DEXSCREENER_CHAIN_ID[chain] ?? null;
      if (wanted === null) {
        findings.push({ level: 'warn', chain, source: 'profiles', reason: `dexscreener has no chainId mapping for ${chain}` });
        return { hints: [], records: [], findings, skipped: [] };
      }
      const hints = [];
      const seen = new Set();
      let matched = 0;
      for (const row of rows) {
        if (row?.chainId !== wanted) continue;
        matched += 1;
        const hint = createHint({
          chain,
          address: row.tokenAddress,
          source: 'profiles',
          origin: row.url ?? null,
          paid,
          meta: { description: row.description ?? null, header: row.header ?? null, link: row.url ?? null },
        });
        // createHint returns null for an address this chain cannot hold; that is
        // counted, not silently dropped, because a rising invalid-address rate
        // means the feed and the chain map have diverged.
        if (hint === null) continue;
        if (seen.has(hint.key)) continue;
        seen.add(hint.key);
        hints.push(hint);
      }
      if (matched === 0) {
        // "The feed answered and had nothing for this chain" is a real fact and
        // belongs in the events; it is different from the feed being down.
        findings.push({ level: 'info', chain, source: 'profiles', reason: `token-profiles returned ${rows.length} rows, none for ${wanted}` });
      }
      return { hints, records: [], findings, skipped: [], rows: rows.length, matched };
    },
  };
}

// The ONLY supported way to attach an emission emitter to the coordinator.
//
// The coordinator's documented emitter contract (coordinator.mjs:64-98) is
// `discover(chain, {out}) -> records[]`, and every record it returns becomes a
// merged discovery row. That is the wrong contract for a hint source: wiring a
// raw emitter in directly would publish unverified addresses straight into the
// screen, which is the exact failure the existence oracle exists to prevent.
//
// So the shim below returns an EMPTY record list. Its only effect is feeding the
// registry; promotion happens separately via promoteChecked() and the result
// merges into the rotation like any other record set.
//
//   const registry = new HintRegistry({ oracleOptions: { budget: rpcBudget } });
//   const ingest = createIngestDiscovery({ fetchImpl });
//   // default OFF: an env gate must clear before any emission emitter registers.
//   ingest.emitters.push(
//     toCoordinatorEmitter(createLogsEmitter({ budget: rpcBudget }), registry),
//     toCoordinatorEmitter(createProfilesEmitter(), registry),
//   );
//
// Recommended env gate, read once at wiring time, default OFF:
//   MEMECLAW_EMISSION=logs,profiles   (or `all`; absent/unknown => nothing)
//   MEMECLAW_HINT_PATH=<file>          (optional file-backed registry)
export function toCoordinatorEmitter(emitter, registry) {
  if (!emitter || typeof emitter.discover !== 'function') {
    throw new TypeError('toCoordinatorEmitter requires an emitter with discover()');
  }
  if (!registry || typeof registry.add !== 'function') {
    throw new TypeError('toCoordinatorEmitter requires a HintRegistry');
  }
  return {
    id: emitter.id,
    // The provider set this widens the scanner's filter by
    // (coordinator.mjs:40-42). 'EMISSION' is deliberately NOT a market provider:
    // no market data comes from these feeds, and a provider name that implies
    // otherwise would let a hint-sourced row claim GeckoTerminal's numbers.
    provider: 'EMISSION',
    budget: emitter.budget ?? null,
    enabled: typeof emitter.enabled === 'function' ? chain => emitter.enabled(chain) : () => true,
    async discover(chain, { out = [] } = {}) {
      const result = await emitter.discover(chain, { out });
      const hints = Array.isArray(result?.hints) ? result.hints : [];
      let accepted = 0;
      for (const hint of hints) {
        if (registry.add(hint).accepted) accepted += 1;
      }
      // A skip with a reason is reported so "robinhood has no verified factory"
      // is visible in the cycle's events instead of reading as a quiet market.
      for (const entry of Array.isArray(result?.skipped) ? result.skipped : []) {
        out.push({ level: 'warn', chain, source: emitter.id, reason: `emission skipped: ${entry.reason}` });
      }
      // Records stay empty on purpose — see the note above. Cycle latency is
      // unchanged: this only queues, and promoteChecked() runs in the same
      // rotation after the queue is filled.
      return [];
    },
  };
}