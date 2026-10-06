// P4 emission wiring — the captain's seam between the member-built hint lane
// and the live coordinator. Exactly two jobs: register the env-gated emitters
// at construction, and run the promotion pass after every coordinator
// discovery. Everything else (registry semantics, oracle tri-state, emitter
// internals) stays in hints.mjs / adapters/emission.mjs where its 37 tests
// already cover it.
//
// WHY THE LANE IS TWO-STAGED (emission.mjs:8, :437-458): a raw emitter must
// never publish rows — its discover() queues hints and returns []. The only
// path from hint to record is promoteChecked() running the eth_getCode /
// getAccountInfo existence oracle: exists===true promotes, exists===false
// drops, transport failure keeps the hint and silences the SOURCE (fail-open,
// never starves the funnel).
//
// ADMISSION PATH: a promoted record carries source 'logs'/'profiles';
// row-contract maps BOTH to marketProvider 'EMISSION' — exactly the tag
// toCoordinatorEmitter() registers in the coordinator's providers set. So
// allowedDiscoveryRow admits emission rows ONLY when this gate registered the
// emitters, and `ingestSource` keeps the true origin for provenance.
//
// ENV (both required — the RADAR_INGEST_EMITTERS lane gate must be open first):
//   MEMECLAW_EMISSION=logs,profiles   (or `all`; absent/unknown => nothing)
//   MEMECLAW_HINT_PATH=<file>         (optional file-backed queue; else memory)

import { HintRegistry, HINT_DISPOSITION, promoteChecked, existenceOracle } from './hints.mjs';
import { createLogsEmitter, createProfilesEmitter, toCoordinatorEmitter } from './adapters/emission.mjs';

/** `all` or a comma list; absent/unknown tokens enable nothing (never a guess). */
export function parseEmissionWant(value) {
  const want = String(value ?? '').trim();
  if (want === '') return { logs: false, profiles: false };
  const has = name => want === 'all' || new RegExp(`(^|,)${name}(,|$)`).test(want);
  return { logs: has('logs'), profiles: has('profiles') };
}

/**
 * Decorate an ingest coordinator with the emission lane. Returns a
 * prototype-delegating wrapper (Object.create) so providers / beginRotation /
 * snapshot / emitters all stay the coordinator's own — the scanner interface
 * does not change by one member.
 *
 * @param {object} discovery  the coordinator from createIngestDiscovery()
 * @param {{want?:string, hintPath?:string, registry?:object, oracle?:Function, promoteLimit?:number}} [options]
 * @returns {object} decorated discovery (same discover/providers contract)
 */
export function attachEmission(discovery, {
  want = process.env.MEMECLAW_EMISSION,
  hintPath = process.env.MEMECLAW_HINT_PATH,
  registry = null,
  oracle = existenceOracle,
  promoteLimit = 20,
} = {}) {
  if (!discovery || !Array.isArray(discovery.emitters)) {
    throw new TypeError('attachEmission requires an ingest coordinator with .emitters');
  }
  const flags = parseEmissionWant(want);
  const reg = registry ?? new HintRegistry({ path: String(hintPath ?? '').trim() || null });
  // Registration order is construction order; both shims share the tag
  // 'EMISSION' and the providers getter dedupes it (coordinator.mjs:40-42).
  if (flags.logs) discovery.emitters.push(toCoordinatorEmitter(createLogsEmitter(), reg));
  if (flags.profiles) discovery.emitters.push(toCoordinatorEmitter(createProfilesEmitter(), reg));
  const enabled = flags.logs || flags.profiles;

  const decorated = Object.create(discovery);
  decorated.discover = async (chain, opts = {}) => {
    const result = await discovery.discover(chain, opts);
    if (!enabled) return result;
    let promoted;
    try {
      // capturedAtSec/clock default to the REGISTRY's clock (hints.mjs:459) —
      // a second time base here would expire hints against the wrong epoch.
      promoted = await promoteChecked(reg, oracle, { limit: promoteLimit });
    } catch (error) {
      return {
        ...result,
        findings: [...(result?.findings ?? []),
          { level: 'warn', chain, source: 'emission', reason: `promotion pass failed: ${String(error?.message ?? error)}` }],
      };
    }
    const records = Array.isArray(result?.records) ? result.records : [];
    const dispositions = promoted?.dispositions ?? [];
    const freshRecords = promoted?.records ?? [];
    if (freshRecords.length === 0 && dispositions.length === 0) return result;
    // Keep the measured record on collision: if GeckoTerminal already carried
    // this address this rotation, the promotion adds existence evidence, not a
    // second row.
    const seen = new Set(records.map(row => `${row.chain}:${String(row.address ?? '').toLowerCase()}`));
    const fresh = freshRecords.filter(row => !seen.has(`${row.chain}:${String(row.address ?? '').toLowerCase()}`));
    // PROMOTED and ABSENT are normal oracle outcomes (level info is dropped by
    // the scanner's event writer); skips and transport trouble become events so
    // "robinhood hints never promote" is visible instead of quiet.
    const findings = dispositions
      .filter(entry => entry.disposition !== HINT_DISPOSITION.PROMOTED && entry.disposition !== HINT_DISPOSITION.ABSENT)
      .map(entry => ({ level: 'warn', chain, source: entry.source ?? 'emission',
        reason: `hint ${entry.disposition}${entry.reason ? `: ${entry.reason}` : ''}` }));
    return {
      ...result,
      records: [...records, ...fresh],
      findings: [...(result?.findings ?? []), ...findings],
    };
  };
  decorated.emission = { enabled: flags, registry: reg };
  return decorated;
}
