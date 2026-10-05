// Multi-emitter discovery fan-out, running OFF the AVE shared clock.
//
// Why this shape (all of it measured, not stylistic):
//   * Per-host budgets, never per-chain: every measured provider limit is
//     per-host-per-key (budget.mjs SOURCE_BUDGETS). Bucketing per chain would
//     multiply an apparent limit by five.
//   * Fail-open per emitter — discovery errors, throttles and timeouts
//     contribute nothing and surface as one finding; they can never fail the
//     cycle. Silence is reported as a finding, never dressed up as
//     "no launches today".
//   * Observations are recorded per (source × token) BEFORE the merge, so two
//     emitters returning the same address never erase provenance. mergeRecords
//     keeps conflicts instead of picking a silent winner.
//   * The raced promise gets a no-op catch: a request abandoned at the timeout
//     must not raise an unhandled rejection after discover() already resolved.
//
// Cadence reality: the scanner advances ONE chain per cycle and cycles are
// minutes apart, so GeckoTerminal's measured 14 s spacing never binds inside a
// cycle; the coordinator timeout is a safety net over spacing + fetch, not a
// throughput knob.

import { createBudget } from './budget.mjs';
import { IngestHttp } from './http.mjs';
import { GeckoTerminalAdapter } from './adapters/geckoterminal.mjs';
import { mergeRecords } from './record.mjs';

export class DiscoveryCoordinator {
  constructor({ emitters = [], timeoutMs = 30_000, clock = () => Date.now() } = {}) {
    if (!Array.isArray(emitters) || emitters.length === 0) {
      throw new Error('DiscoveryCoordinator requires at least one emitter');
    }
    this.emitters = emitters;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
    this.lastRun = null;
  }

  // The registered introducer tags. The scanner widens its provider filter by
  // exactly this set — nothing an emitter returns can smuggle a provider in.
  get providers() {
    return [...new Set(this.emitters.map(emitter => emitter.provider))];
  }

  beginRotation(rotationId) {
    for (const emitter of this.emitters) emitter.budget?.beginRotation(rotationId);
  }

  async #raceTimeout(promise, label) {
    let timer = null;
    promise.catch(() => {}); // abandoned branch must not become an unhandled rejection
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${this.timeoutMs}ms`), { code: 'TIMEOUT' })), this.timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Returns { records, observations, findings }. Observations exist even when
  // the merge later drops a duplicate; findings carry every non-data outcome
  // (error / throttle / timeout / misconfiguration) for the cycle's events.
  async discover(chain, { rotationId = null } = {}) {
    if (rotationId !== null) this.beginRotation(rotationId);
    const observations = [];
    const findings = [];
    const batches = [];
    for (const emitter of this.emitters) {
      if (typeof emitter.enabled === 'function' && !emitter.enabled(chain)) continue;
      let records = [];
      try {
        records = await this.#raceTimeout(
          Promise.resolve().then(() => emitter.discover(chain, { out: findings })),
          emitter.id
        );
      } catch (error) {
        findings.push({
          level: error?.throttled ? 'warn' : 'error',
          chain,
          source: emitter.id,
          throttled: error?.throttled === true,
          reason: `${emitter.id} discover failed: ${error.message}`,
        });
        continue;
      }
      const usable = (Array.isArray(records) ? records : []).filter(record => record?.chain === chain && record?.address);
      for (const record of usable) {
        observations.push({
          source: record.source,
          provider: emitter.provider,
          chain: record.chain,
          address: record.address,
          capturedAtSec: record.capturedAtSec,
        });
      }
      batches.push(usable);
    }
    const merged = mergeRecords(batches.flat()) ?? [];
    this.lastRun = {
      chain,
      at: this.clock(),
      providers: this.providers,
      records: merged.length,
      observations: observations.length,
      findings: findings.length,
    };
    return { records: merged, observations, findings };
  }

  snapshot() {
    return this.lastRun;
  }
}

// Wires the emitters the ledger has live-probed for all five chains keyless.
// DexScreener's launch feed is deliberately absent until P2: token-profiles
// rows carry an address but no size fields, so as a DISCOVERY source they
// would screen out at '流动性数据未知'; its real slot is the enrichment batch.
export function createIngestDiscovery({ fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const gtBudget = createBudget('geckoterminal');
  const gtHttp = new IngestHttp({ budget: gtBudget, timeoutMs: 15_000, fetchImpl });
  const gecko = new GeckoTerminalAdapter({ http: gtHttp, budget: gtBudget });
  return new DiscoveryCoordinator({
    timeoutMs,
    emitters: [{
      id: 'gt',
      provider: 'GECKOTERMINAL',
      budget: gtBudget,
      discover: (chain, { out = [] } = {}) => gecko.fetchNewPools(chain, { out }),
    }],
  });
}
