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
import { createGmgnEmitter } from './adapters/gmgn.mjs';
import { createDexPaprikaEmitter } from './adapters/dexpaprika.mjs';
import { PumpFunAdapter } from './adapters/pumpfun.mjs';
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

  // All supported chains in ONE rotation. The AVE provider still advances one
  // chain per cycle, but its emitters run on per-host budgets that know
  // nothing about the AVE clock — so discovery coverage (fresh launches,
  // emission windows, hint promotion) no longer waits for a chain's AVE turn.
  //
  // Chains run concurrently: same-host callers serialize inside SourceBudget
  // (spacing is check-and-reserve synchronously — see budget.mjs take()), so
  // parallel chains queue on the host's real spacing instead of multiplying
  // it. beginRotation runs EXACTLY ONCE — row caps are per chain per rotation,
  // and a beginRotation per chain would reset the other chains' counts
  // mid-flight and turn a5-chain fan-out into 5x the measured row budget.
  //
  // The timeout that matters is per emitter.discover call: with all chains
  // sharing one host bucket, the LAST chain's take() waits (chains-1) x
  // spacing (GT: 4 x 14s = 56s), which is why the default coordinator timeout
  // is 120s and not 30s.
  async discoverAll(chains, { rotationId = null } = {}) {
    const list = Array.isArray(chains) ? chains : [];
    if (rotationId !== null) this.beginRotation(rotationId);
    const results = await Promise.all(list.map(chain => this.discover(chain, { rotationId: null })));
    const records = results.flatMap(result => result.records);
    const observations = results.flatMap(result => result.observations);
    const findings = results.flatMap(result => result.findings);
    this.lastRun = {
      chain: list.join(','),
      at: this.clock(),
      providers: this.providers,
      records: records.length,
      observations: observations.length,
      findings: findings.length,
    };
    return { records, observations, findings };
  }
}

// Registers the emitters this deployment enabled (config.ingestEmitters →
// main.mjs passes the recognized names). Each emitter is measured, not
// aspirational: gt new_pools (all five chains, keyless), gmgn trenches
// (all five, keyed), dexpaprika tokens/search (all five, key optional),
// pumpfun (sol only, keyless — enabled() returns false elsewhere).
// Sources without a discovery feed do NOT get an emitter here by design:
// helius/goplus serve enrichment/security through their own lanes, ankr is
// plan-gated, drpc has no feed — an emitter that can never return rows would
// be a registration that lies about capability. That redistribution comes
// later, per the operator's instruction; this seam is discovery-only.
//
// timeoutMs default 120_000: with all chains sharing one per-host bucket, the
// last chain's budget wait is (chains-1) x spacing (GT 4 x 14s = 56s) plus
// fetch — a 30s race would time out rows that are merely queued behind their
// own pacing, discarding them as failures.
export function createIngestDiscovery({ fetchImpl = globalThis.fetch, timeoutMs = 120_000, emitters = ['gt'] } = {}) {
  const want = new Set(Array.isArray(emitters) ? emitters : [emitters]);
  const list = [];

  if (want.has('gt')) {
    const gtBudget = createBudget('geckoterminal');
    const gtHttp = new IngestHttp({ budget: gtBudget, timeoutMs: 15_000, fetchImpl });
    const gecko = new GeckoTerminalAdapter({ http: gtHttp, budget: gtBudget });
    list.push({
      id: 'gt',
      provider: 'GECKOTERMINAL',
      budget: gtBudget,
      discover: (chain, { out = [] } = {}) => gecko.fetchNewPools(chain, { out }),
    });
  }
  if (want.has('gmgn')) list.push(createGmgnEmitter({ fetchImpl }));
  if (want.has('dexpaprika')) list.push(createDexPaprikaEmitter({ fetchImpl }));
  if (want.has('pumpfun')) {
    const pfBudget = createBudget('pumpfun');
    const pfHttp = new IngestHttp({ budget: pfBudget, timeoutMs: 15_000, fetchImpl });
    const pumpfun = new PumpFunAdapter({ http: pfHttp, budget: pfBudget });
    list.push({
      id: 'pumpfun',
      provider: 'PUMPFUN',
      budget: pfBudget,
      // One feed, one chain: the coin list is sol-native mints; an EVM chain
      // would parse them into records normalizeTokenAddress rejects anyway,
      // but skipping before the fetch is one wasted request fewer.
      enabled: chain => chain === 'sol',
      discover: (chain, { out = [] } = {}) => pumpfun.fetchNewTokens({ out }),
    });
  }

  if (list.length === 0) {
    throw new Error('createIngestDiscovery: no known emitters requested (recognized: gt, gmgn, dexpaprika, pumpfun)');
  }
  return new DiscoveryCoordinator({ timeoutMs, emitters: list });
}
