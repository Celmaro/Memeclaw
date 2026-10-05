import { IngestHttp } from '../src/ingest/http.mjs';
import { createBudget } from '../src/ingest/budget.mjs';
import { GeckoTerminalAdapter } from '../src/ingest/adapters/geckoterminal.mjs';
import { PumpFunAdapter } from '../src/ingest/adapters/pumpfun.mjs';
import { mergeRecords } from '../src/ingest/record.mjs';

// Live smoke: proves the two Increment-1 adapters parse real provider payloads
// into records, without touching the bot or its test runner.
const out = [];

const geckoBudget = createBudget('geckoterminal', { spacingMs: 0, cooldownFloorMs: 1 });
const gecko = new GeckoTerminalAdapter({ http: new IngestHttp({ budget: geckoBudget }), budget: geckoBudget });
for (const chain of ['robinhood', 'base', 'bsc']) {
  const records = await gecko.fetchNewPools(chain, { out });
  const sample = records[0];
  console.log(JSON.stringify({
    chain,
    count: records.length,
    first: sample && {
      address: sample.address,
      fdv: sample.size.fdv,
      marketCap: sample.size.marketCap,
      fdvOnly: sample.sizeIsFdvOnly,
      liquidity: sample.liquidityUsd,
      ageSec: sample.ageSec === null ? null : Math.round(sample.ageSec),
      unresolved: sample.unresolved,
    },
  }));
}
console.log('gecko findings:', JSON.stringify(out.filter(entry => entry.level !== 'info'), null, 1));

const ages = [];
{
  const b = createBudget('geckoterminal', { spacingMs: 0, cooldownFloorMs: 1 });
  const a = new GeckoTerminalAdapter({ http: new IngestHttp({ budget: b }), budget: b, startPage: 1 });
  const recs = await a.fetchNewPools('base', { out: [] });
  for (const r of recs) if (r.ageSec !== null) ages.push(Math.round(r.ageSec));
  ages.sort((x, y) => x - y);
  console.log('page1 ages base:', ages.slice(0, 6), '...', ages.slice(-3), 'count', ages.length);
}

const pumpBudget = createBudget('pumpfun', { spacingMs: 0, cooldownFloorMs: 1 });
const pump = new PumpFunAdapter({ http: new IngestHttp({ budget: pumpBudget }), budget: pumpBudget });
const tokens = await pump.fetchNewTokens({ out });
console.log('pumpfun:', JSON.stringify(tokens.slice(0, 2).map(t => ({
  address: t.address, symbol: t.symbol, mcap: t.size.marketCap, ageSec: t.ageSec === null ? null : Math.round(t.ageSec),
  risk: t.risk?.status, unresolved: t.unresolved,
}))));

const merged = mergeRecords([...await gecko.fetchNewPools('base', { out: [] })]);
console.log('merge dedupe:', merged.length, 'records,', new Set(merged.map(r => r.address)).size, 'unique addresses');
console.log('budget snapshot:', JSON.stringify(geckoBudget.snapshot()));