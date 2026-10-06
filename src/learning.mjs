// Learning / persistence layer (P5).
//
// Append-only JSONL event log + deterministic outcome ratchet. Ported from the
// memeland research summarized in docs/ARCHITECTURE-FULL-PIPELINE.md §4.7:
//   - append-only events + replay, never read-modify-write state;
//   - a corrupt line is SKIPPED (warn), never fatal;
//   - a realized exit must never be re-fed to the learner (double-count guard);
//   - terminal-only outcomes (WIN_GAIN_RATIO 1.5 / LOSS_LOSS_RATIO 0.8).
//
// This module is deliberately standalone: it imports NO scanner and NO state,
// and takes the state directory by injection so the caller wires it. The only
// shared import is the repo's single owner of the atomic write idiom
// (src/local-store.mjs atomicJson, which src/state.mjs also uses).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson } from './local-store.mjs';

/** The three ratcheting weights, in canonical order. */
export const WEIGHT_KEYS = Object.freeze(['smartMoney', 'liquidity', 'defensive']);

/** Per-weight ceiling. A ratchet may never push a weight past its cap. */
export const WEIGHT_CAPS = Object.freeze({ smartMoney: 0.5, liquidity: 0.35, defensive: 0.4 });

/** Neutral starting priors. They sum to 1.0, which is the renormalization target. */
export const BASELINE_WEIGHTS = Object.freeze({ smartMoney: 0.4, liquidity: 0.3, defensive: 0.3 });

/** One terminal win or loss moves its weight by this much. */
export const RATCHET_STEP = 0.01;

/** An applied weight may drift at most ±30% around its own baseline. */
export const BAND = 0.3;

/** Terminal thresholds ported from the memeland post-mortem rule. */
export const OUTCOME_THRESHOLDS = Object.freeze({ winGainRatio: 1.5, lossLossRatio: 0.8 });

export const EVENTS_FILE = 'learning-events.jsonl';
export const WEIGHTS_FILE = 'swarm-learning.json';

const EPSILON = 1e-9;
const BISECTION_ITERATIONS = 200;
const MAX_SCALE_DOUBLINGS = 60;

const WIN_LABELS = new Set(['WIN', 'WON', 'WIN_GAIN', 'TAKE_PROFIT', 'TP']);
const LOSS_LABELS = new Set(['LOSS', 'LOST', 'LOSS_LOSS', 'STOP_LOSS', 'SL']);
const NEUTRAL_LABELS = new Set(['NEUTRAL', 'FLAT', 'TIMEOUT', 'TIMED_OUT', 'TIME_OUT', 'EXPIRED', 'ABANDONED', 'CLOSED_FLAT']);

const warn = message => console.warn(message);

const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value);

const round10 = value => Math.round(num(value) * 1e10) / 1e10;

function resolveBaseline(override) {
  const baseline = {};
  for (const key of WEIGHT_KEYS) {
    const value = num(override?.[key], BASELINE_WEIGHTS[key]);
    baseline[key] = value > 0 ? value : BASELINE_WEIGHTS[key];
  }
  return Object.freeze(baseline);
}

/** Per-weight [low, high] envelope: the ±30% band, further limited by the cap. */
export function weightBounds(baseline = BASELINE_WEIGHTS) {
  const lo = {};
  const hi = {};
  for (const key of WEIGHT_KEYS) {
    const base = num(baseline?.[key], BASELINE_WEIGHTS[key]);
    lo[key] = Math.max(0, base * (1 - BAND));
    hi[key] = Math.min(WEIGHT_CAPS[key], base * (1 + BAND));
  }
  return { lo, hi };
}

const sumOf = weights => WEIGHT_KEYS.reduce((sum, key) => sum + num(weights?.[key]), 0);

/**
 * Project arbitrary weights onto the feasible set: every weight inside its
 * ±30% band and under its cap, and the three summing to exactly 1.
 *
 * This is the Euclidean projection solved by one Lagrange multiplier:
 * w_i = clamp(target_i − λ, lo_i, hi_i), with λ bisected until the sum is
 * exactly 1. A single uniform scale factor was tried first and rejected: it
 * divides the whole vector toward the mean, and a greedy water-filling was
 * rejected too — both let a renormalization step silently cancel a ratchet
 * step, because whichever weight "paid" the residual could swallow the entire
 * increase of another. The uniform shift is order-preserving and cannot
 * preferentially erase one weight's move.
 *
 * A solution always exists because Σlo = 0.7 ≤ 1 ≤ 1.15 ≤ Σhi for the shipped
 * baseline and caps; the search range is widened defensively regardless.
 */
export function projectWeights(input, options = {}) {
  const baseline = resolveBaseline(options.baseline);
  const { lo, hi } = weightBounds(baseline);
  const raw = {};
  for (const key of WEIGHT_KEYS) raw[key] = num(input?.[key], baseline[key]);

  const sumAt = lambda => WEIGHT_KEYS.reduce((sum, key) => sum + clamp(raw[key] - lambda, lo[key], hi[key]), 0);

  let low = -1;
  let high = 1;
  let doublings = 0;
  while (sumAt(low) < 1 && doublings < MAX_SCALE_DOUBLINGS) {
    low *= 2;
    doublings += 1;
  }
  doublings = 0;
  while (sumAt(high) > 1 && doublings < MAX_SCALE_DOUBLINGS) {
    high *= 2;
    doublings += 1;
  }
  for (let i = 0; i < BISECTION_ITERATIONS; i += 1) {
    const mid = (low + high) / 2;
    if (sumAt(mid) > 1) low = mid;
    else high = mid;
  }
  const lambda = (low + high) / 2;

  const out = {};
  for (const key of WEIGHT_KEYS) out[key] = round10(clamp(raw[key] - lambda, lo[key], hi[key]));

  // Absorb the float residual on whichever weight still has slack, so the sum
  // is 1 within EPSILON instead of drifting a few ULPs per call.
  const residual = round10(1 - sumOf(out));
  if (Math.abs(residual) > EPSILON) {
    const target = [...WEIGHT_KEYS].sort((a, b) => (hi[b] - out[b]) - (hi[a] - out[a]))[0];
    out[target] = round10(clamp(out[target] + residual, lo[target], hi[target]));
  }
  return out;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeChain(value) {
  if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id.trim().toLowerCase();
  return 'unknown';
}

function normalizeAddress(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'unknown';
}

/**
 * Decide whether an outcome is terminal, and in which direction.
 * Returns `{label, terminal, source}`; UNKNOWN is never terminal.
 */
export function classifyOutcome(outcome) {
  const raw = firstString(outcome?.result, outcome?.label, outcome?.outcome, outcome?.verdict, outcome?.status);
  const upper = raw.toUpperCase();
  if (WIN_LABELS.has(upper)) return { label: 'WIN', terminal: true, source: 'label' };
  if (LOSS_LABELS.has(upper)) return { label: 'LOSS', terminal: true, source: 'label' };
  if (NEUTRAL_LABELS.has(upper)) return { label: 'NEUTRAL', terminal: false, source: 'label' };

  const gainRatio = num(outcome?.gainRatio);
  if (gainRatio > 0 && gainRatio >= OUTCOME_THRESHOLDS.winGainRatio) return { label: 'WIN', terminal: true, source: 'gain_ratio' };
  const lossRatio = num(outcome?.lossRatio);
  if (lossRatio > 0 && lossRatio <= OUTCOME_THRESHOLDS.lossLossRatio) return { label: 'LOSS', terminal: true, source: 'loss_ratio' };

  if (outcome?.neutral === true || outcome?.terminal === false && outcome?.decided === true) {
    return { label: 'NEUTRAL', terminal: false, source: 'flag' };
  }
  return { label: 'UNKNOWN', terminal: false, source: 'none' };
}

/**
 * Identity of the thing being learned from. A realized exit owns its exitId, so
 * re-polling the same exit — even with a freshly minted eventId — collapses onto
 * the same key and is rejected by the double-count guard.
 */
export function deriveFeedKey(outcome) {
  const exitId = firstString(outcome?.exitId, outcome?.exit_id, outcome?.positionId);
  if (exitId) return `exit:${exitId}`;
  const explicit = firstString(outcome?.feedKey);
  if (explicit) return `event:${explicit}`;
  const classified = classifyOutcome(outcome);
  const window = firstString(outcome?.window, outcome?.terminalWindow, outcome?.term) || 'lifetime';
  return `outcome:${normalizeChain(outcome?.chain)}:${normalizeAddress(outcome?.address)}:${window}:${classified.label}`;
}

/** Deterministic event id: re-feeding the same exit yields the same id. */
export function deriveEventId(outcome) {
  return `ev_${crypto.createHash('sha256').update(deriveFeedKey(outcome)).digest('hex').slice(0, 24)}`;
}

function resolveDir(dirOrStore) {
  if (typeof dirOrStore === 'string' && dirOrStore.trim()) return path.resolve(dirOrStore.trim());
  const candidate = dirOrStore?.dir ?? dirOrStore?.stateDir ?? dirOrStore?.path;
  if (typeof candidate === 'string' && candidate.trim()) return path.resolve(candidate.trim());
  throw new TypeError('learning: a state directory must be injected (string path or { dir })');
}

const eventsPath = dir => path.join(resolveDir(dir), EVENTS_FILE);
const weightsPath = dir => path.join(resolveDir(dir), WEIGHTS_FILE);

function toSet(value) {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map(String));
  if (typeof value === 'object') return new Set(Object.keys(value));
  return new Set();
}

/**
 * Append one event to the JSONL log. Append-only: the file is opened O_APPEND
 * and fsync'd, so a crash can lose at most the last line, never reorder earlier
 * ones. Dedupe happens at replay, not here.
 *
 * @param {string|{dir:string}} dirOrStore injected state directory
 * @param {object} event event payload; `eventId`/`at` are filled when missing
 * @returns {object} the stored event (what was serialized)
 */
export function appendEvent(dirOrStore, event) {
  const dir = resolveDir(dirOrStore);
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('learning: event must be a plain object');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stored = {
    ...event,
    eventId: firstString(event.eventId) || `ev_${crypto.randomBytes(12).toString('hex')}`,
    at: num(event.at, Date.now()),
  };
  const line = `${JSON.stringify(stored)}\n`;
  let fd;
  try {
    fd = fs.openSync(path.join(dir, EVENTS_FILE), 'a', 0o600);
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return stored;
}

/**
 * Fold the log back into state. The log is the source of truth: the weights
 * sidecar is a cache, never an input.
 *
 * @param {string|{dir:string}} dirOrStore injected state directory
 * @param {{baseline?:object, onWarn?:(message:string)=>void}} [options]
 * @returns {{weights:object, outcomes:object, skipped:number, total:number,
 *            events:object[], appliedFeedKeys:Set<string>, appliedEventIds:Set<string>}}
 */
export function replayEvents(dirOrStore, options = {}) {
  const dir = resolveDir(dirOrStore);
  const baseline = resolveBaseline(options.baseline);
  const report = options.onWarn || warn;
  const file = path.join(dir, EVENTS_FILE);

  const empty = {
    weights: projectWeights(baseline, { baseline }),
    outcomes: {},
    skipped: 0,
    total: 0,
    events: [],
    appliedFeedKeys: new Set(),
    appliedEventIds: new Set(),
  };
  if (!fs.existsSync(file)) return empty;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    report(`learning: 无法读取事件日志，已按空状态重放 (${error?.message || error})`);
    return empty;
  }

  const weights = {};
  const outcomes = {};
  const appliedFeedKeys = new Set();
  const appliedEventIds = new Set();
  const events = [];
  let skipped = 0;
  let total = 0;

  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    total += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      skipped += 1;
      report(`learning: 跳过损坏的事件日志行 line=${index + 1}`);
      continue;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      skipped += 1;
      report(`learning: 跳过非对象事件行 line=${index + 1}`);
      continue;
    }

    const eventId = firstString(event.eventId);
    const feedKey = firstString(event.feedKey) || (eventId ? `event:${eventId}` : '');
    events.push(event);

    const outcome = event.outcome && typeof event.outcome === 'object' ? event.outcome : {};
    const classified = classifyOutcome(outcome);
    const applied = event.applied === true && classified.terminal === true;
    outcomes[feedKey || eventId || `line:${index + 1}`] = {
      feedKey: feedKey || eventId || `line:${index + 1}`,
      eventId: eventId || null,
      at: num(event.at, 0),
      result: classified.label,
      applied,
      address: outcome.address ?? null,
      chain: normalizeChain(outcome.chain),
      reason: firstString(event.reason) || (applied ? 'applied' : 'ignored'),
    };

    if (!applied) continue;
    if (feedKey && appliedFeedKeys.has(feedKey)) continue;
    if (feedKey) appliedFeedKeys.add(feedKey);
    if (eventId) appliedEventIds.add(eventId);

    // Project after every step, exactly like the incremental path, so a full
    // replay and a run of feedOutcome calls land on identical weights. Project
    // ONCE per event: projecting per key would feed a partially-updated vector
    // into the next projection and corrupt the fold.
    const before = weights.smartMoney === undefined ? projectWeights(baseline, { baseline }) : weights;
    const ratcheted = {
      smartMoney: clamp(before.smartMoney + (classified.label === 'WIN' ? RATCHET_STEP : 0), 0, WEIGHT_CAPS.smartMoney),
      liquidity: clamp(before.liquidity + (classified.label === 'WIN' ? RATCHET_STEP : 0), 0, WEIGHT_CAPS.liquidity),
      defensive: clamp(before.defensive + (classified.label === 'LOSS' ? RATCHET_STEP : 0), 0, WEIGHT_CAPS.defensive),
    };
    Object.assign(weights, projectWeights(ratcheted, { baseline }));
  }

  return {
    weights: projectWeights(weights, { baseline }),
    outcomes,
    skipped,
    total,
    events,
    appliedFeedKeys,
    appliedEventIds,
  };
}

/**
 * Pure ratchet. No I/O — persistence is the caller's job.
 *
 * WIN  ⇒ smartMoney +0.01, liquidity +0.01
 * LOSS ⇒ defensive   +0.01
 * then caps, then a ±30% band clamp around the baseline, then renormalization
 * to a sum of exactly 1.
 *
 * @param {object} weights current weights
 * @param {object} outcome outcome record
 * @param {{baseline?:object, appliedFeedKeys?:Iterable<string>, alreadyApplied?:boolean}} [options]
 * @returns {{applied:boolean, reason:'applied'|'already_applied'|'neutral_close'|'not_terminal',
 *            weights:object, deltas:object, feedKey:string, eventId:string, label:string}}
 */
export function recalibrate(weights, outcome, options = {}) {
  const baseline = resolveBaseline(options.baseline);
  const feedKey = deriveFeedKey(outcome);
  const eventId = firstString(outcome?.eventId) || deriveEventId(outcome);
  const projected = projectWeights(weights, { baseline });
  const appliedFeedKeys = toSet(options.appliedFeedKeys);
  const classified = classifyOutcome(outcome);

  const drained = outcome?.drained === true || num(outcome?.drainedAt, 0) > 0 || outcome?.applied === true;
  if (appliedFeedKeys.has(feedKey) || toSet(options.alreadyAppliedEventIds).has(eventId) || drained) {
    return { applied: false, reason: 'already_applied', weights: projected, deltas: zeroDeltas(), feedKey, eventId, label: classified.label };
  }
  if (!classified.terminal) {
    const reason = classified.label === 'NEUTRAL' ? 'neutral_close' : 'not_terminal';
    return { applied: false, reason, weights: projected, deltas: zeroDeltas(), feedKey, eventId, label: classified.label };
  }

  const ratcheted = {
    smartMoney: projected.smartMoney + (classified.label === 'WIN' ? RATCHET_STEP : 0),
    liquidity: projected.liquidity + (classified.label === 'WIN' ? RATCHET_STEP : 0),
    defensive: projected.defensive + (classified.label === 'LOSS' ? RATCHET_STEP : 0),
  };
  const next = projectWeights(ratcheted, { baseline });
  return {
    applied: true,
    reason: 'applied',
    weights: next,
    deltas: deltasBetween(projected, next),
    feedKey,
    eventId,
    label: classified.label,
  };
}

function zeroDeltas() {
  return Object.fromEntries(WEIGHT_KEYS.map(key => [key, 0]));
}

function deltasBetween(before, after) {
  return Object.fromEntries(WEIGHT_KEYS.map(key => [key, round10(num(after?.[key]) - num(before?.[key]))]));
}

/**
 * The single entry point. Enforces the double-count guard, appends the event,
 * and refreshes the weights sidecar.
 *
 * @param {string|{dir:string}} dirOrStore injected state directory
 * @param {object} outcome outcome record
 * @param {{baseline?:object, onWarn?:Function, writeSidecar?:boolean}} [options]
 * @returns {{applied:boolean, reason:string, weights:object, deltas:object,
 *            feedKey:string, eventId:string, label:string, event:object|null}}
 */
export function feedOutcome(dirOrStore, outcome, options = {}) {
  const dir = resolveDir(dirOrStore);
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw new TypeError('learning: outcome must be a plain object');
  }
  const baseline = resolveBaseline(options.baseline);
  const replay = replayEvents(dir, { baseline, onWarn: options.onWarn });
  const result = recalibrate(replay.weights, outcome, {
    baseline,
    appliedFeedKeys: replay.appliedFeedKeys,
    alreadyAppliedEventIds: replay.appliedEventIds,
  });

  const classified = classifyOutcome(outcome);
  const event = appendEvent(dir, {
    type: result.applied ? 'OUTCOME_TERMINAL' : classified.label === 'NEUTRAL' ? 'OUTCOME_NEUTRAL' : 'OUTCOME_IGNORED',
    eventId: result.eventId,
    feedKey: result.feedKey,
    applied: result.applied,
    reason: result.reason,
    at: num(outcome.at, Date.now()),
    outcome,
  });

  const weights = result.applied ? result.weights : replay.weights;
  if (result.applied && options.writeSidecar !== false) writeWeights(dir, weights, { baseline });

  return { ...result, weights, event };
}

/**
 * Write the weights sidecar (memeland's `swarm_learning.json` analog) with the
 * repo's atomic temp+fsync+rename idiom.
 *
 * @param {string|{dir:string}} dirOrStore injected state directory
 * @param {object} weights weights to persist
 * @param {{baseline?:object}} [options]
 * @returns {object} the persisted payload
 */
export function writeWeights(dirOrStore, weights, options = {}) {
  const dir = resolveDir(dirOrStore);
  const baseline = resolveBaseline(options.baseline);
  const projected = projectWeights(weights, { baseline });
  const file = weightsPath(dir);
  let events = 0;
  try {
    events = replayEvents(dir, { baseline, onWarn: () => {} }).total;
  } catch {
    events = 0;
  }
  const payload = {
    version: 1,
    updatedAt: Date.now(),
    baseline,
    weights: projected,
    weightsSum: round10(sumOf(projected)),
    events,
  };
  atomicJson(file, payload);
  return payload;
}

/**
 * Read the weights sidecar. A missing or unreadable cache is not fatal — the
 * event log remains authoritative — so this returns null instead of throwing.
 *
 * @param {string|{dir:string}} dirOrStore injected state directory
 * @returns {object|null}
 */
export function readWeights(dirOrStore) {
  const file = weightsPath(dirOrStore);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const baseline = resolveBaseline(parsed.baseline);
    return { ...parsed, baseline, weights: projectWeights(parsed.weights, { baseline }) };
  } catch {
    return null;
  }
}
