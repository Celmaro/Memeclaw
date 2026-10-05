// Live check of the structural risk analyzer against real fresh tokens.
//
// Proves the analyzer does not merely satisfy its own stubs: it runs end-to-end
// on all four EVM chains, against tokens GeckoTerminal is listing RIGHT NOW, and
// reports the timing that decides whether a per-token cost is affordable inside
// one rotation.
//
// Run: node scripts/ingest-risk-smoke.mjs

import { RpcRiskAnalyzer, PUBLICNODE_RPC, rpcUrlFor } from '../src/ingest/adapters/rpc-risk.mjs';

const GT = { eth: 'eth', bsc: 'bsc', base: 'base', robinhood: 'robinhood' };
const PER_CHAIN_TOKENS = 3;

async function freshTokens(chain, count) {
  const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/${GT[chain]}/new_pools?page=2`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GT http ${response.status}`);
  const payload = await response.json();
  return (payload?.data ?? []).slice(0, count)
    .map(row => ({
      token: row.relationships?.base_token?.data?.id?.split('_')[1] ?? null,
      fdv: Number(row.attributes?.fdv_usd ?? 0),
      name: row.attributes?.name ?? '?',
      created: row.attributes?.pool_created_at ?? null,
    }))
    .filter(item => item.token);
}

const analyzer = new RpcRiskAnalyzer();
const summary = {};

for (const chain of ['eth', 'bsc', 'base', 'robinhood']) {
  if (!analyzer.supports(chain)) continue;
  console.log(`\n============ ${chain} (${rpcUrlFor(chain)}) ============`);

  let tokens;
  try {
    tokens = await freshTokens(chain, PER_CHAIN_TOKENS);
  } catch (error) {
    console.log(`  GT failed: ${error.message}`);
    continue;
  }
  if (!tokens.length) { console.log('  no fresh pools this cycle'); continue; }

  const rows = [];
  for (const item of tokens) {
    const started = Date.now();
    const risk = await analyzer.analyze(chain, item.token);
    const ms = Date.now() - started;
    rows.push({ ...risk, ms, fdv: item.fdv, name: item.name });
    const ageSec = item.created ? Math.round(Date.now() / 1000 - Date.parse(item.created) / 1000) : null;
    console.log(`  ${item.name.padEnd(22).slice(0, 22)} ${risk.status.toUpperCase().padEnd(7)} ${String(ms).padStart(5)}ms  fdv=$${item.fdv} age=${ageSec}s`);
    console.log(`      code=${risk.evidence.codeBytes}B upgradeable=${risk.evidence.upgradeable} owner=${risk.evidence.owner ?? '-'}`);
    for (const note of risk.notes) console.log(`      . ${note}`);
    // The invariant, checked against the live response rather than a fixture.
    if (risk.isHoneypot !== null || risk.buyTax !== null || risk.sellTax !== null) {
      console.log('      *** INVARIANT VIOLATED: honeypot/tax claimed on live data ***');
      process.exitCode = 1;
    }
  }

  const ok = rows.filter(row => row.status !== 'unknown');
  summary[chain] = {
    tokens: rows.length,
    resolved: ok.length,
    meanMs: Math.round(rows.reduce((sum, row) => sum + row.ms, 0) / Math.max(1, rows.length)),
    adverse: rows.filter(row => row.status === 'adverse').length,
  };
  console.log(`  summary: ${summary[chain].resolved}/${rows.length} resolved, adverse=${summary[chain].adverse}, mean ${summary[chain].meanMs}ms/token`);
}

console.log('\n============ rotation cost estimate ============');
const perRotation = Object.values(summary).reduce((sum, row) => sum + row.meanMs * 5, 0);
for (const [chain, row] of Object.entries(summary)) {
  console.log(`  ${chain.padEnd(10)} ${row.meanMs}ms/token x5 = ${row.meanMs * 5}ms`);
}
console.log(`  4 chains x 5 tokens, calls issued concurrently inside analyze(): ${Math.round(perRotation / 1000)}s of wall clock`);
console.log(`  live RPC calls per token: 4 (getCode, 3 storage slots, owner(), owner code)`);
console.log(`  => ${Object.values(summary).reduce((sum, row) => sum + 5, 0) * 5} calls per rotation across 4 chains`);