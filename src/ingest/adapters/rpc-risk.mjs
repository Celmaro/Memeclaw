// Structural risk from a free public JSON-RPC endpoint.
//
// WHY THIS EXISTS AND WHY IT IS SMALLER THAN PROMISED
// ---------------------------------------------------
// The plan assumed a free RPC could replace GoPlus as a risk supplier for fresh
// tokens. Probing PublicNode on all four EVM chains (see
// scripts/probe-findings.mjs for the executed evidence) showed that is false:
//
//   debug_traceCall          absent everywhere (-32601)
//   eth_call + storageDiff   rejected (-32602) -> no fabricated token holder
//   => a SELL cannot be simulated, so honeypot and tax are NOT derivable here.
//
// What IS derivable is structural, and structural risk is worth real money: an
// EIP-1967 proxy means the logic can be swapped for a honeypot AFTER you buy,
// which is the exact failure a static screen is supposed to catch. That plus
// bytecode-size limits and ownership shape covers more of the rug surface than
// it first appears.
//
// The honesty rule this file exists to enforce: `isHoneypot`, `buyTax` and
// `sellTax` are returned as null with an explicit note, never as `false` or
// `0`. A downstream screen that treats null as "not a honeypot" is the failure
// mode this design has to make impossible.

import { RISK_STATUS } from '../record.mjs';
import { CHAIN_META } from '../chain-map.mjs';

// Measured endpoints: eth_chainId answered 0x1 / 0x38 / 0x2105 / 0x1237.
export const PUBLICNODE_RPC = Object.freeze({
  eth: 'https://ethereum-rpc.publicnode.com',
  bsc: 'https://bsc-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  robinhood: 'https://robinhood-rpc.publicnode.com',
});

// EIP-1967 slots. An upgradeable token is the single most actionable finding
// available without an indexer, so these are read for every candidate.
const EIP1967 = Object.freeze({
  implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8d117a0',
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
});

// EIP-170: the largest contract the chain will deploy.
const MAX_CODE_BYTES = 24_576;

const SELECTORS = Object.freeze({
  owner: '8da5cb5b',
  admin: 'f851a440',
  getOwner: '893d20e8',
  transferOwnership: 'f2fde38b',
  renounceOwnership: '715018a6',
  blacklist: 'f9f92be4',
});

// Capability triage. Bytes are searched for, which is why these are heuristics:
// a selector's 4 bytes can live inside PUSH operands or the Solidity metadata
// blob. Presence proves the code was compiled against it; absence proves
// nothing at all.
const BYTECODE_MARKERS = Object.freeze([
  { flag: 'ownerSelector', hex: SELECTORS.owner, meaning: 'compiled against owner()' },
  { flag: 'transferOwnershipSelector', hex: SELECTORS.transferOwnership, meaning: 'compiled against transferOwnership(address)' },
  { flag: 'renounceOwnershipSelector', hex: SELECTORS.renounceOwnership, meaning: 'compiled against renounceOwnership()' },
  { flag: 'blacklistSelector', hex: SELECTORS.blacklist, meaning: 'compiled against a blacklist-style getter' },
]);

const hex = value => String(value ?? '0x').toLowerCase().replace(/^0x/, '');
const isZeroWord = raw => hex(raw) === '' || BigInt(`0x${hex(raw) || '0'}`) === 0n;

export function rpcUrlFor(chain) {
  return PUBLICNODE_RPC[chain] ?? null;
}

export function isEvmChain(chain) {
  return CHAIN_META[chain]?.kind === 'evm';
}

// One JSON-RPC call. JSON-RPC errors arrive as HTTP 200 with an `error` member,
// so status alone is not success — treating it as success is how a probe ends up
// reporting "0 bytes of code" for a token it simply failed to reach.
export async function rpcCall(url, method, params, { fetchImpl = globalThis.fetch, timeoutMs = 12_000 } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    const text = await response.text();
    const latencyMs = Date.now() - started;
    if (response.status !== 200) {
      return { ok: false, error: `http_${response.status}`, latencyMs };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: 'non_json', latencyMs };
    }
    if (parsed?.error) {
      return { ok: false, error: `rpc_${parsed.error.code}`, message: String(parsed.error.message ?? '').slice(0, 120), latencyMs };
    }
    return { ok: true, result: parsed.result, latencyMs };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'timeout' : 'network', message: String(error?.message ?? '').slice(0, 120), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// Bytecode facts, all deterministic reads.
export async function readBytecodeFacts(url, address, options = {}) {
  const code = await rpcCall(url, 'eth_getCode', [address, 'latest'], options);
  if (!code.ok) return { ok: false, error: code.error, message: code.message };
  const body = hex(code.result);
  const sizeBytes = body.length / 2;
  const markers = {};
  for (const marker of BYTECODE_MARKERS) markers[marker.flag] = body.includes(marker.hex);
  return {
    ok: true,
    isContract: sizeBytes > 0,
    sizeBytes,
    overEip170: sizeBytes > MAX_CODE_BYTES,
    markers,
    latencyMs: code.latencyMs,
  };
}

export async function readProxyFacts(url, address, options = {}) {
  const reads = await Promise.all(
    Object.entries(EIP1967).map(async ([slot, key]) => {
      const result = await rpcCall(url, 'eth_getStorageAt', [address, key, 'latest'], options);
      return [slot, result.ok ? { set: !isZeroWord(result.result), address: isZeroWord(result.result) ? null : `0x${hex(result.result).slice(-40)}` } : { set: null }];
    }),
  );
  const slots = Object.fromEntries(reads);
  const admin = slots.admin?.address ?? null;
  const implementation = slots.implementation?.address ?? null;
  const beacon = slots.beacon?.address ?? null;
  return {
    slots,
    upgradeable: Boolean(admin || implementation || beacon),
    admin,
    implementation,
    beacon,
    readable: Object.values(slots).every(slot => slot.set !== null),
  };
}

// The owner surface, told apart from a bytecode marker: this actually EXECUTES
// the getters, so a hit is a real owner address rather than a bytes match.
export async function readOwnerFacts(url, address, options = {}) {
  const ownerCall = await rpcCall(url, 'eth_call', [{ to: address, data: `0x${SELECTORS.owner}` }, 'latest'], options);
  if (!ownerCall.ok) {
    return { hasOwnerGetter: false, owner: null, ownerIsContract: null, error: ownerCall.error };
  }
  const owner = `0x${hex(ownerCall.result).slice(-40)}`;
  if (owner === `0x${'0'.repeat(40)}`) {
    // A zero owner is meaningfully different from no owner: the token exposes
    // the getter but has renounced or never assigned control.
    return { hasOwnerGetter: true, owner, ownerIsEoa: null, ownerIsContract: null, renounced: true };
  }
  const code = await rpcCall(url, 'eth_getCode', [owner, 'latest'], options);
  return {
    hasOwnerGetter: true,
    owner,
    renounced: false,
    ownerIsContract: code.ok ? hex(code.result).length > 0 : null,
    error: code.ok ? null : code.error,
  };
}

// Turns the raw facts into the risk fields scoring.mjs already knows about.
export function assessStructural({ bytecode, proxy, owner }) {
  const notes = [];
  const ownerPrivileges = [];
  let fieldsPresent = 0;

  if (bytecode?.ok) {
    fieldsPresent += 1;
    if (!bytecode.isContract) notes.push('no_runtime_code: 不是合约，可能是EOI或部署失败');
    if (bytecode.overEip170) notes.push(`code_over_eip170: 字节码${bytecode.sizeBytes}字节，超过${MAX_CODE_BYTES}`);
  } else {
    notes.push(`bytecode_unavailable: ${bytecode?.error ?? 'unknown'}`);
  }

  if (proxy?.readable) {
    fieldsPresent += 1;
    if (proxy.upgradeable) {
      ownerPrivileges.push('upgradeable_proxy');
      notes.push(`upgradeable: 实现可被替换，逻辑可在买入后换成貔貅盘（admin=${proxy.admin ?? '-'} impl=${proxy.implementation ?? '-'}）`);
    }
  } else if (proxy) {
    notes.push(`proxy_slots_unavailable: ${proxy.slots?.admin?.set === null ? 'eth_getStorageAt failed' : 'unknown'}`);
  }

  if (owner?.hasOwnerGetter) {
    fieldsPresent += 1;
    if (owner.renounced) {
      notes.push('owner_renounced: owner() 返回零地址');
    } else {
      ownerPrivileges.push('owner_controlled');
      if (owner.ownerIsContract === true) notes.push(`owner_is_contract: ${owner.owner} 本身是合约（多签或代理）`);
      else if (owner.ownerIsContract === false) notes.push(`owner_is_eoa: ${owner.owner} 为EOA，单点可改参数`);
    }
  } else if (owner?.error === 'rpc_3') {
    // A revert on owner() is the common case for immutable/factory deployments.
    // It is an absent capability, not a failed measurement.
    notes.push('no_owner_getter: owner() 未实现（常见于不可变/工厂部署）');
  } else if (owner) {
    notes.push(`owner_unavailable: ${owner.error}`);
  }

  // Honeypot/tax are structurally unknowable here. Stated as a note on every
  // single result so no downstream consumer can mistake null for false.
  notes.push('honeypot_tax_unavailable: 无 storageDiff/debug_traceCall，自由RPC无法模拟卖出');

  const adverse = ownerPrivileges.length > 0 || bytecode?.overEip170 === true;
  return {
    status: fieldsPresent === 0 ? RISK_STATUS.UNKNOWN : adverse ? RISK_STATUS.ADVERSE : RISK_STATUS.CLEAN,
    isHoneypot: null,
    buyTax: null,
    sellTax: null,
    lpLocked: null,
    rugRatio: null,
    bundlerRate: null,
    insiderRate: null,
    washTrading: null,
    ownerPrivileges: ownerPrivileges.length ? ownerPrivileges : null,
    fieldsPresent,
    source: 'publicnode_rpc',
    notes,
  };
}

// Per-chain budget accounting happens in the caller (the rotation), which owns
// the shared bucket. PublicNode's limit is per host, not per chain, so all four
// endpoints must share one bucket or the real ceiling is multiplied by four.
export class RpcRiskAnalyzer {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 12_000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  supports(chain) {
    return isEvmChain(chain);
  }

  async analyze(chain, address, { budget = null } = {}) {
    const url = rpcUrlFor(chain);
    if (!url) {
      throw new Error(`no public RPC for chain: ${chain}`);
    }
    const options = { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs };
    const optionsFor = async () => {
      if (!budget) return options;
      try {
        await budget.take(chain);
      } catch (error) {
        if (error?.code === 'ROW_CAP') return null;
        throw error;
      }
      return options;
    };

    // Three reads per token, issued together: a risk check that costs three
    // sequential round-trips cannot keep up with five chains in one rotation.
    let bytecode = null;
    let proxy = null;
    let owner = null;
    if (await optionsFor()) bytecode = await readBytecodeFacts(url, address, options);
    if (await optionsFor()) proxy = await readProxyFacts(url, address, options);
    if (await optionsFor()) owner = await readOwnerFacts(url, address, options);

    return {
      ...assessStructural({ bytecode, proxy, owner }),
      chain,
      address,
      evidence: {
        codeBytes: bytecode?.ok ? bytecode.sizeBytes : null,
        upgradeable: proxy?.upgradeable ?? null,
        owner: owner?.owner ?? null,
      },
    };
  }
}