// Chain id maps for ingest sources.
//
// Robinhood is present here on the same evidence that put it in
// src/secondary.mjs:4-14: GoPlus lists {"name":"Robinhood","id":"4663"} in
// /api/v1/supported_chains and DexScreener returns chainId "robinhood" for
// /token-pairs/v1/robinhood/<address>, both verified against real addresses.
//
// GeckoTerminal's /networks endpoint OMITS robinhood while the
// /networks/robinhood/<network>/new_pools route serves it (200, 28,993 B, pool
// ids shaped robinhood_0x...). That list is not a capability manifest, so the
// slug is configured explicitly instead of being read from the list endpoint.

export const GECKO_NETWORKS = Object.freeze({
  sol: 'solana',
  eth: 'eth',
  base: 'base',
  bsc: 'bsc',
  robinhood: 'robinhood',
});

// Measured, not assumed: robinhood base/quote denominate in a token rather than
// a native asset, so GT nests them under quote_token.<denom>. Where the denom is
// the chain's own gas asset the native fields are used instead.
export const CHAIN_META = Object.freeze({
  sol: { kind: 'solana', evmChainId: null, symbol: 'SOL', wrapped: null },
  eth: { kind: 'evm', evmChainId: 1, symbol: 'ETH', wrapped: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
  base: { kind: 'evm', evmChainId: 8453, symbol: 'ETH', wrapped: '0xc420aa781d04c0e7d4d0de13c52d4b4dc0e1a1e7' },
  bsc: { kind: 'evm', evmChainId: 56, symbol: 'BNB', wrapped: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
  robinhood: { kind: 'evm', evmChainId: 4663, symbol: 'RBH', gated: true },
});

export const SUPPORTED_INGEST_CHAINS = Object.freeze(Object.keys(GECKO_NETWORKS));

// Guard against a provider answering a solana request with a base pool. GT
// prefixes every id with the network slug, so a cross-network leak is cheap to
// detect and would otherwise silently attribute a token to the wrong chain.
export function geckoIdChain(id) {
  const match = /^([a-z0-9]+)_/.exec(String(id ?? ''));
  return match ? match[1] : null;
}

export function stripGeckoPrefix(id) {
  const value = String(id ?? '');
  const index = value.indexOf('_');
  return index === -1 ? value : value.slice(index + 1);
}