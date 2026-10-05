// HTTP client for ingest adapters.
//
// Every adapter fetches through here so that throttling logic never lands
// inside an adapter, and so that one place can apply the failures this host
// actually hits: curl.exe and PowerShell cannot establish TLS to these APIs
// from here (certificate/handshake error), which is why every probe in the
// research was made with `node -e "fetch(...)"`. This module uses global fetch
// for the same reason.

import { detectThrottle } from './budget.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;

// GeckoTerminal ships `x-rack-cache: stale` on responses it is willing to serve
// but that are behind the live pack. Accepting one silently is how a launch feed
// reports last cycle's pools as new ones, so staleness is surfaced, not eaten.
function rackCacheState(headers) {
  const raw = headers?.get?.('x-rack-cache') ?? null;
  if (raw === null) return null;
  return raw === 'stale' ? 'stale' : 'fresh';
}

export class HttpError extends Error {
  constructor(message, { status = null, body = null, url = null, throttled = false, detail = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.throttled = throttled;
    this.detail = detail;
  }
}

export class IngestHttp {
  constructor({ budget = null, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
    this.budget = budget;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async #raw(url, { method = 'GET', headers = {}, body = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, { method, headers, body, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // One request, fully budgeted. `chain` is a fairness label only: it feeds the
  // per-rotation row cap and never keys the bucket, because every measured
  // provider limit is per-host-per-key rather than per-chain.
  async request(url, { chain = null, method = 'GET', headers = {}, body = null, accept = 'application/json', expect = 'json' } = {}) {
    if (this.budget) {
      try {
        await this.budget.take(chain);
      } catch (error) {
        if (error?.code === 'ROW_CAP') {
          throw new HttpError(`row cap reached for ${chain}`, { url, detail: 'row_cap' });
        }
        throw error;
      }
    }
    const startedAt = Date.now();
    const response = await this.#raw(url, { method, headers: { accept, ...headers }, body });
    const text = await response.text();
    const latencyMs = Date.now() - startedAt;
    const rackCache = rackCacheState(response.headers);

    let parsed = null;
    if (text) {
      try {
        parsed = expect === 'json' ? JSON.parse(text) : text;
      } catch {
        parsed = null;
      }
    }

    // DexPaprika's credit pool only decrements on a cache miss. Reading this
    // before deciding whether the call was worth spending is the single
    // highest-leverage budget lever available: a HIT is free.
    const cacheHeader = response.headers?.get?.('cf-cache-status') ?? null;
    const cacheHit = cacheHeader === 'HIT';
    const credits = cacheHit ? 0 : (Number(response.headers?.get?.('x-credits-remaining')) || 0) > 0 ? 10 : 0;

    const detection = this.budget
      ? this.budget.report({ status: response.status, body: parsed, headers: response.headers, chain, cacheHit, credits })
      : detectThrottle(response.status, parsed, response.headers);

    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status} from ${new URL(url).host}`, {
        status: response.status, body: parsed ?? text.slice(0, 400), url,
        throttled: detection.throttled, detail: detection.detail,
      });
    }

    return {
      ok: true,
      status: response.status,
      data: parsed,
      raw: text,
      latencyMs,
      bytes: text.length,
      rackCache,
      cacheHit,
      throttled: detection.throttled,
      headers: response.headers,
    };
  }

  async json(url, options = {}) {
    const result = await this.request(url, { ...options, expect: 'json' });
    if (result.data === null) {
      throw new HttpError(`non-JSON response from ${new URL(url).host}`, {
        status: result.status, body: result.raw.slice(0, 200), url,
      });
    }
    return result;
  }
}

// DexPaprika and GoPlus both answer some routes with an object whose payload
// lives under a per-address key. Reading result.is_honeypot instead of
// result[addr.toLowerCase()].is_honeypot returns undefined on every field and
// ships security silently disabled, which is exactly what happened on bsc.
//
// When an address was asked for and is absent from the map, this returns null
// rather than falling back to whatever single entry the map happens to hold.
// A wrong-address fallback would attach one token's risk report to a different
// token: security data for the wrong contract is worse than no security data,
// and unlike a missing field it looks authoritative. Fail closed.
export function unwrapAddressMap(payload, address) {
  if (payload === null || typeof payload !== 'object') return null;
  if (typeof payload.result !== 'object' || payload.result === null) return null;
  if (address) {
    const key = address.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(payload.result, key) ? payload.result[key] : null;
  }
  const keys = Object.keys(payload.result);
  if (keys.length === 1 && typeof payload.result[keys[0]] === 'object') return payload.result[keys[0]];
  return payload.result;
}