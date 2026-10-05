// What a FREE public RPC can and cannot prove about a fresh token.
//
// Measured 2026-10-05 against PublicNode, four EVM chains, tokens minutes old
// from GeckoTerminal new_pools page 2. Every "YES" here is an executed call,
// not a reading of provider documentation.

// CAN, verified by execution
export const CAN = {
  chainId: 'eth_chainId answers on all four: eth 0x1, bsc 0x38, base 0x2105, robinhood 0x1237.',
  code: 'eth_getCode returns runtime bytecode for every token tested (4768-20288 hex chars).',
  storage: 'eth_getStorageAt reads EIP-1967 admin slot; returned zero on all non-proxy tokens.',
  staticCall: 'eth_call serves totalSupply/balanceOf/owner() normally.',
  stateDiff: 'eth_call WITH a stateDiff native-balance override is HONOURED on base and bsc: WETH.deposit() failed -32003 OutOfFunds, then succeeded with a fabricated balance.',
  multicall: 'Multicall3 is deployed at 0xcA11bde05977b3631167028862be2a173976ca11 on all four chains and aggregate() executes (96 bytes returned).',
};

// CANNOT, verified by failure
export const CANNOT = {
  trace: 'debug_traceCall does not exist anywhere: -32601 on eth, bsc, base, robinhood.',
  storageOverride: 'eth_call with a token storageDiff is rejected: -32602 Invalid params on base and bsc. On eth the shape was accepted once and rejected after; inconclusive and therefore unusable.',
  sellSim: 'Consequently a SELL cannot be simulated. A token balance is contract storage, so without storageDiff no fabricated seller exists. This kills free-RPC honeypot detection.',
};

// Two data-shape corrections that invalidate earlier readings
export const SHAPE = {
  poolIsNotEvm: 'The GT new_pools `attributes.address` and `id` are 64-hex pool ids, NOT 20-byte EVM addresses (bsc token id == pool id). Calling owner() on it returns "Invalid params / odd hex length". Only the base_token id suffix is a contract address.',
  createdIsIso: 'pool_created_at is an ISO string, not a number; Number() on it yields NaN ages.',
  relationshipsBare: 'relationships.base_token.data carries only {id,type} — no decimals, no symbol. Those live on a separate /tokens/{addresses} call.',
};

// What this leaves the analyzer, honestly
export const VERDICT = {
  deliverable: [
    'not-a-contract: empty bytecode is definitive, not a token.',
    'upgradeable: EIP-1967 implementation/admin slots are deterministic storage reads. This is a real rug vector — logic can be swapped to a honeypot after you buy.',
    'owner-surface: whether a standard owner() getter exists, and whether that owner is an EOA or a contract.',
    'size: deployed bytecode size against the EIP-170 24576-byte limit.',
  ],
  heuristicOnly: [
    'opcode/selector presence in bytecode is NECESSARY but not SUFFICIENT for a capability: 4-byte selectors and 0xff/0xf4 opcodes can appear inside PUSH data and the metadata blob. Usable as a triage flag with an explicit note, never as a verdict.',
  ],
  notDeliverable: [
    'honeypot / sell restriction: needs a simulated sell, which needs storageDiff.',
    'buy/sell tax: needs a router-accurate buy simulation; stateDiff permits a fake native balance but not the pool-side token accounting.',
    'holder concentration, bundler rate, insider rate, rug ratio: need an indexer, not an RPC.',
  ],
  consequence: 'GoPlus stays the honeypot/tax source and must fail CLOSED to unknown. The custom analyzer supplies STRUCTURAL risk only. Any plan that promised a free-RPC honeypot oracle was wrong.',
};

export const TOKENS_PROBED = {
  note: 'every probed token reported totalSupply 1e27 and no owner() selector in bytecode, with empty-name symbol() reads; these are factory-style minimal deployments, not standard Ownable tokens. Dev-share analysis via owner() therefore does not generalise.',
};