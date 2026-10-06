// Rate budget for the ingest layer.
//
// This module is deliberately a sibling of ave.mjs rather than an extension of
// it. ave.mjs:71-83 keeps a durable strike table whose floor reaches 8 minutes
// and is shared across every chain on one AVE key. If an ingest adapter shared
// that state, a single GeckoTerminal 429 would push AVE into an 8-minute floor
// and stall the entire 5-chain rotation. So nothing here imports ave.mjs, and
// nothing here writes under the shared provider throttle.
//
// Measured behaviour that shaped these defaults (live probes, 2026-10):
//   GeckoTerminal  ~1 call / 14 s safe; burst of 4 -> 200,200,200,429.
//                  429 body is 272 B, header `retry-after: 0`, recovery 19.1 s.
//   DexPaprika     10 req/min AND 1000 cache-missing calls / rolling 30 d.
//   GoPlus         sliding 2-4 s window, ~7 concurrent. Throttle arrives as
//                  HTTP 200 with body {"code":4029}, no Retry-After header.
//   DexScreener    300 rpm documented; 130/130 rapid requests produced zero
//                  throttles; no quota header exists to read.

const DEFAULT_SLEEP = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// A continuous token bucket. Not a fixed-window counter: every limit probed here
// behaves as a sliding window under burst, so a window counter would admit a
// burst at the boundary that the provider then rejects.
export class TokenBucket {
  constructor({ capacity = 1, refillMs = 1_000 } = {}) {
    this.capacity = Math.max(1, capacity);
    this.refillMs = Math.max(1, refillMs);
    this._tokens = this.capacity;
    this.updatedAt = Date.now();
  }

  // Reads and writes `_tokens` directly. Going through the `tokens` getter
  // inside refill would recurse: the getter calls refill, whose right-hand side
  // reads the getter again, and the stack dies before any request is made.
  #refill(now = Date.now()) {
    if (now <= this.updatedAt) return;
    const elapsed = now - this.updatedAt;
    const gained = (elapsed / this.refillMs) * this.capacity;
    this._tokens = Math.min(this.capacity, this._tokens + gained);
    this.updatedAt = now;
  }

  // Tokens that will be available after waiting `ms`, WITHOUT mutating the
  // bucket. The status snapshot asks this to answer "next slot in 9s", and a
  // mutating version would hand out tokens the bucket has not earned yet.
  availableAfter(ms) {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.updatedAt) + Math.max(0, ms);
    const gained = (elapsed / this.refillMs) * this.capacity;
    return Math.min(this.capacity, this._tokens + gained);
  }

  get tokens() {
    this.#refill();
    return this._tokens;
  }

  set tokens(value) {
    this._tokens = value;
  }

  async take() {
    for (;;) {
      this.#refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return true;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(5, Math.ceil((deficit / this.capacity) * this.refillMs));
      await DEFAULT_SLEEP(waitMs);
    }
  }
}

// Opens after `threshold` consecutive throttles, stays open for `cooldownMs`,
// then admits one probe request through as a half-open trial. A successful probe
// closes it; a second throttle re-opens it for the full cooldown.
export class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 30_000 } = {}) {
    this.threshold = Math.max(1, threshold);
    this.cooldownMs = Math.max(1, cooldownMs);
    this.consecutive = 0;
    this.openedAt = null;
  }

  get open() {
    return this.openedAt !== null;
  }

  remainingMs() {
    if (this.openedAt === null) return 0;
    return Math.max(0, this.openedAt + this.cooldownMs - Date.now());
  }

  record(throttled, { cooldownMs = this.cooldownMs } = {}) {
    if (!throttled) {
      this.consecutive = 0;
      this.openedAt = null;
      return false;
    }
    this.consecutive += 1;
    if (this.openedAt !== null || this.consecutive >= this.threshold) {
      this.openedAt = Date.now();
      this.cooldownMs = Math.max(this.cooldownMs, cooldownMs);
      return true;
    }
    return false;
  }
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find(entry => entry.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

// A provider can report "slow down" three different ways and this bot has met
// all three: a real 429 (GeckoTerminal), an HTTP 200 whose body carries an
// error code (GoPlus `{"code":4029}`), and a 402/403 quota shape (DexPaprika).
// A status-code-only check silently swallows the second and third.
export function detectThrottle(status, body, headers) {
  if (status === 429 || status === 402) return { throttled: true, via: 'http_status', detail: `HTTP ${status}` };
  if (status === 403 && typeof body?.message === 'string' && /rate|quota|limit/i.test(body.message)) {
    return { throttled: true, via: 'http_status', detail: 'HTTP 403 quota' };
  }
  const code = body?.code ?? body?.status?.error_code ?? body?.error?.code;
  if (code === 4029) return { throttled: true, via: 'body_code', detail: 'body code 4029 (HTTP 200)' };
  if (code === 429) return { throttled: true, via: 'body_code', detail: 'body code 429' };
  const message = typeof body?.message === 'string' ? body.message : typeof body?.status?.error_message === 'string' ? body.status.error_message : '';
  if (message && /rate limit|too many requests/i.test(message)) {
    return { throttled: true, via: 'body_message', detail: message.slice(0, 80) };
  }
  if (headerValue(headers, 'retry-after')) return { throttled: false, via: 'header', detail: null };
  return { throttled: false, via: null, detail: null };
}

// Per-source budget. One instance per provider, injected into its adapter.
//
// The bucket identity is host + API-key identity and NEVER the chain. Every
// limit measured here is per-key, not per-chain, so a per-chain bucket would
// multiply the real ceiling by 5. Per-chain fairness is a row cap inside the one
// shared bucket instead, so one noisy chain cannot consume the other four.
export class SourceBudget {
  constructor({
    name,
    host,
    spacingMs = 250,
    capacity = 4,
    refillMs = 1_000,
    cooldownFloorMs = 30_000,
    breakerThreshold = 3,
    perRotationRowCap = null,
    clock = () => Date.now(),
    sleep = DEFAULT_SLEEP,
  } = {}) {
    this.name = name;
    this.host = host;
    this.spacingMs = Math.max(0, spacingMs);
    // Spacing and bucket are separate controls and both are needed. Spacing is a
    // hard minimum gap between requests to one host; the bucket only enforces a
    // count over a window. GeckoTerminal's measured burst tolerance (4 calls ->
    // 200,200,200,429) makes the gap, not the count, the binding constraint.
    this.bucket = new TokenBucket({ capacity, refillMs });
    this.breaker = new CircuitBreaker({ threshold: breakerThreshold, cooldownMs: cooldownFloorMs });
    this.cooldownFloorMs = Math.max(1, cooldownFloorMs);
    this.perRotationRowCap = perRotationRowCap;
    this.clock = clock;
    this.sleep = sleep;
    this.lastRequestAt = 0;
    this.cooldownUntil = 0;
    this.cooldownReason = null;
    this.requests = 0;
    this.throttles = 0;
    this.cacheHits = 0;
    this.creditsSpent = 0;
    this.lastStatus = null;
    this.lastQuota = null;
    this.rotationCounts = new Map();
    this.rotationId = null;
  }

  // Called once per scan rotation. Row caps reset here, buckets do not.
  beginRotation(rotationId) {
    this.rotationId = rotationId;
    this.rotationCounts = new Map();
  }

  #rowAllowed(chain) {
    if (this.perRotationRowCap === null || chain === null) return true;
    const used = this.rotationCounts.get(chain) ?? 0;
    return used < this.perRotationRowCap;
  }

  #countRow(chain) {
    if (chain !== null) this.rotationCounts.set(chain, (this.rotationCounts.get(chain) ?? 0) + 1);
  }

  async take(chain = null) {
    if (!this.#rowAllowed(chain)) {
      const error = new Error(`row cap reached for ${chain}`);
      error.code = 'ROW_CAP';
      error.chain = chain;
      throw error;
    }
    for (;;) {
      const now = this.clock();
      if (this.breaker.open) {
        const waitMs = this.breaker.remainingMs();
        if (waitMs > 0) {
          await this.sleep(Math.max(5, waitMs));
          continue;
        }
        // Cooldown elapsed: fall through as a half-open probe request. Whether
        // it closes the breaker is decided by report(), not here.
      }
      const spacingReady = this.lastRequestAt + this.spacingMs;
      if (now < spacingReady) {
        await this.sleep(spacingReady - now);
        continue;
      }
      // Reserve the slot BEFORE yielding on the bucket. bucket.take() awaits,
      // and a concurrent caller for another chain could pass the spacing check
      // in that window: two chains' requests then double-fire and the host's
      // measured spacing guarantee is silently void. Check-and-reserve must be
      // one synchronous step (JS runs it atomically); the bucket then gates the
      // already-reserved slot, and any bucket wait only pushes the fire later.
      this.lastRequestAt = this.clock();
      await this.bucket.take();
      this.#countRow(chain);
      return true;
    }
  }

  report({ status, body = null, headers = null, chain = null, cacheHit = false, credits = 0, ok = true } = {}) {
    this.requests += 1;
    this.lastStatus = status ?? null;
    if (cacheHit) this.cacheHits += 1;
    if (credits) this.creditsSpent += credits;
    this.lastQuota = this.readQuota(headers);

    const detection = detectThrottle(status, body, headers);
    if (detection.throttled) {
      this.throttles += 1;
      const until = this.clock() + Math.max(this.cooldownFloorMs, this.#retryAfterMs(headers));
      this.cooldownUntil = Math.max(this.cooldownUntil, until);
      this.cooldownReason = `${this.name} cooldown until ${new Date(this.cooldownUntil).toISOString().slice(11, 19)}Z (${detection.detail})`;
      this.breaker.record(true, { cooldownMs: this.cooldownFloorMs });
      return detection;
    }
    this.breaker.record(false);
    this.cooldownReason = null;
    return detection;
  }

  // GeckoTerminal answers 429 with `retry-after: 0`. Honouring that as an
  // instruction is a hot retry loop straight into a measured 19.1 s lockout, so
  // a non-positive value is ignored in favour of the source's own floor.
  #retryAfterMs(headers) {
    const raw = headerValue(headers, 'retry-after');
    if (raw === null || raw === undefined || raw === '') return 0;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return seconds * 1_000;
  }

  readQuota(headers) {
    if (!headers) return null;
    // Order matters. DexPaprika sends both `ratelimit-remaining` (per-minute,
    // resets in seconds) and `x-credits-remaining` (the 30-day cache-miss pool
    // that is the actually scarce resource). Reporting the per-minute number as
    // "remaining" would show "8 of 10 available" while the pool that will
    // actually strand the source sits at 70.
    const pick = (...names) => {
      for (const name of names) {
        const value = headerValue(headers, name);
        if (value !== null && value !== undefined && value !== '') return value;
      }
      return null;
    };
    const quota = {
      limit: pick('x-credits-limit', 'ratelimit-limit'),
      remaining: pick('x-credits-remaining', 'ratelimit-remaining'),
      reset: pick('ratelimit-reset'),
      minuteRemaining: pick('ratelimit-remaining'),
      creditRemaining: pick('x-credits-remaining'),
      cache: pick('cf-cache-status'),
      plan: pick('x-api-plan'),
    };
    return Object.values(quota).some(value => value !== null) ? quota : null;
  }

  snapshot() {
    const now = this.clock();
    return {
      name: this.name,
      host: this.host,
      requests: this.requests,
      throttles: this.throttles,
      cacheHits: this.cacheHits,
      creditsSpent: this.creditsSpent,
      lastStatus: this.lastStatus,
      quota: this.lastQuota,
      cooldownMs: Math.max(0, this.cooldownUntil - now),
      // One boolean the status endpoint and the dashboard can both branch on,
      // instead of every caller re-deriving "down?" from two fields and getting
      // it subtly wrong in a different place each time.
      throttled: this.cooldownUntil > now || this.breaker.open,
      breakerOpen: this.breaker.open,
      consecutiveThrottles: this.breaker.consecutive,
      nextSlotMs: Math.max(0, this.lastRequestAt + this.spacingMs - now),
      reason: this.cooldownReason,
      rowCaps: this.perRotationRowCap === null ? null : Object.fromEntries(this.rotationCounts),
    };
  }
}

// Every provider's measured ceiling in one table, so a new adapter inherits a
// known-safe pace instead of rediscovering it by getting throttled in prod.
export const SOURCE_BUDGETS = Object.freeze({
  geckoterminal: {
    name: 'GeckoTerminal',
    host: 'api.geckoterminal.com',
    spacingMs: 14_000,
    capacity: 3,
    refillMs: 45_000,
    cooldownFloorMs: 60_000,
    breakerThreshold: 3,
    perRotationRowCap: 2,
  },
  dexpaprika: {
    name: 'DexPaprika',
    host: 'api.dexpaprika.com',
    spacingMs: 7_000,
    capacity: 2,
    refillMs: 60_000,
    cooldownFloorMs: 60_000,
    breakerThreshold: 3,
    perRotationRowCap: 1,
  },
  goplus: {
    name: 'GoPlus',
    host: 'api.gopluslabs.io',
    spacingMs: 2_000,
    capacity: 5,
    refillMs: 4_000,
    cooldownFloorMs: 8_000,
    breakerThreshold: 3,
    perRotationRowCap: 12,
  },
  dexscreener: {
    name: 'DexScreener',
    host: 'api.dexscreener.com',
    spacingMs: 250,
    capacity: 20,
    refillMs: 2_000,
    cooldownFloorMs: 30_000,
    breakerThreshold: 3,
    perRotationRowCap: 20,
  },
  pumpfun: {
    name: 'pump.fun',
    host: 'frontend-api-v3.pump.fun',
    spacingMs: 2_000,
    capacity: 3,
    refillMs: 30_000,
    cooldownFloorMs: 30_000,
    breakerThreshold: 3,
    perRotationRowCap: 1,
  },
  publicnode: {
    name: 'PublicNode',
    host: '*.publicnode.com',
    spacingMs: 400,
    capacity: 8,
    refillMs: 4_000,
    cooldownFloorMs: 30_000,
    breakerThreshold: 3,
    perRotationRowCap: 10,
  },
  // Keyed and optional, so the ceiling is set by what we can afford to lose:
  // one holder lookup per rotation on one chain. `row` is the measure that
  // matters here, not the bucket — the bucket protects the host, and a
  // five-chain rotation must not be able to spend a whole key's quota on one
  // noisy chain. Nothing in this table has been probed at this pace; the
  // numbers are conservative, and `budgetStopReason` in the P2 wiring is what
  // tells the operator when this entry becomes the binding constraint.
  // Measured live (2026-10): leaky bucket 5/5 per IP with trenches weight 2 →
  // a 2-call burst, then 429 carrying x-ratelimit-reset (NO Retry-After).
  // Every retry during cooldown extends a temporary IP ban by ~5s up to 5 min,
  // so breakerThreshold is 2 (be strict) and this adapter never retries — one
  // 429 costs a rotation, an escalated ban costs five.
  gmgn: {
    name: 'GMGN',
    host: 'openapi.gmgn.ai',
    spacingMs: 3_000,
    capacity: 2,
    refillMs: 15_000,
    cooldownFloorMs: 90_000,
    breakerThreshold: 2,
    perRotationRowCap: 1,
  },
  helius: {
    name: 'Helius',
    host: 'mainnet.helius-rpc.com',
    spacingMs: 1_000,
    capacity: 2,
    refillMs: 10_000,
    cooldownFloorMs: 60_000,
    breakerThreshold: 3,
    perRotationRowCap: 1,
  },
});

export function createBudget(key, overrides = {}) {
  const spec = SOURCE_BUDGETS[key];
  if (!spec) throw new Error(`unknown source budget: ${key}`);
  return new SourceBudget({ ...spec, ...overrides });
}