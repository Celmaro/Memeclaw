// P3 signal layer — evidence, never gates.
//
// Ported from the memeland semantics named in
// docs/ARCHITECTURE-FULL-PIPELINE.md §4.5. Every function here is a
// deterministic pure function: same inputs ⇒ same outputs, no clock reads
// except an explicitly injected `now`, no I/O, no network.
//
// Three rules govern the whole module:
//
//  1. Missing input DEGRADES toward neutral; it never becomes a confident
//     read. `degraded:true` means "the number below is an absence of
//     information", not "the market is fine".
//  2. botRisk FAILS OPEN. An unknown signal contributes 0, so absent data can
//     never manufacture risk; risk may only be raised by data we actually
//     measured.
//  3. No function in this file gates anything. The scanner may surface these
//     under `candidate.deep.signal` for human review, but a signal may not
//     enter `deep.failed`, `deep.unknownFields` or `deep.blockingUnknownFields`,
//     which are the only fields classifyDeepResult() reads.
//
// The quorum gate that memeland applies on top of these same numbers is
// deliberately NOT ported: Memeclaw's failure mode is empty output, and an
// 80% consensus floor would amplify it (§7).

/** 15-minute window, 3 distinct wallets, no wallet above 50% of the window. */
export const CONVERGENCE_DEFAULTS = Object.freeze({
  windowMs: 15 * 60_000,
  minWallets: 3,
  maxWalletShare: 0.5,
  breadthWallets: 8,
  volumeUsd: 50_000,
  weightBreadth: 0.6,
  weightVolume: 0.4,
  maxScore: 90,
  neutralScore: 50,
  minConvergenceScore: 60
});

/** Net flow is worth at most ±20 points off neutral; smart money at most ±10. */
export const WALLET_DEFAULTS = Object.freeze({
  neutralScore: 50,
  netFlowWeight: 20,
  smartMoneyWeight: 10,
  minSmartMoneySamples: 5
});

/**
 * Bot risk is the sum of five named, independently bounded signals, so every
 * point on the 0-100 scale can be attributed to a specific observation.
 */
export const BOT_SIGNAL_WEIGHTS = Object.freeze({
  bundle: 30,
  sniper: 25,
  gradualBundle: 20,
  washTrading: 25,
  concentration: 20
});

export const BOT_RISK_SEVERITIES = Object.freeze(['none', 'low', 'medium', 'high', 'critical']);

/** Per-key publish cooldown; a rotation must not re-alert the same lead. */
export const PUBLISH_DEDUP_DEFAULTS = Object.freeze({
  cooldownMs: 15 * 60_000
});

// Default in-process store. The captain binds `dedupEntries` in RadarState to
// survive restarts; until then this is per-process, which is exactly what
// memeland's ChatNotifier does and one restart better than.
const MEMORY_DEDUP = new Map();

const num = value => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

const eventWallet = event => event?.wallet ?? event?.walletAddress ?? event?.from ?? event?.trader ?? null;

const eventUsd = event => num(event?.usd ?? event?.usdValue ?? event?.volumeUsd ?? event?.amountUsd ?? null);

const eventAt = event => num(event?.at ?? event?.timestamp ?? event?.blockTime ?? null);

/**
 * flowConvergenceScore — verbatim memeland flow-convergence semantics.
 *
 * A window where one wallet supplies more than half the USD is CONCENTRATION,
 * not convergence: it is scored exactly neutral (50) and marked
 * `converged:false`, so a single well-funded wallet can never read as broad
 * participation.
 *
 * @param {Array<{wallet?:string,usd?:number,at?:number}>} buys  window buy events
 * @param {object} [config]   overrides for CONVERGENCE_DEFAULTS
 * @param {number} [now]      epoch ms; injected so the result is deterministic
 * @returns {{score:number, reasons:string[], distinctWallets:number, windowTotalUsd:number, converged:boolean}}
 */
export function flowConvergenceScore(buys, config = {}, now = Date.now()) {
  const cfg = { ...CONVERGENCE_DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  const events = Array.isArray(buys) ? buys : [];
  const from = num(now) - cfg.windowMs;
  const reasons = [];

  let windowTotalUsd = 0;
  let undated = 0;
  let priceless = 0;
  const walletTotals = new Map();

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const at = eventAt(event);
    // An event with no timestamp cannot be proven to sit inside the 15-minute
    // window. It is kept (dropping data silently understates the flow) and
    // reported, so the caller sees that the window bound is unverified.
    if (at === null) undated += 1;
    else if (at < from) continue;

    const usd = eventUsd(event);
    if (usd === null || usd < 0) {
      priceless += 1;
      continue;
    }
    windowTotalUsd += usd;

    const wallet = eventWallet(event);
    if (wallet === null || String(wallet).trim() === '') continue;
    const key = String(wallet);
    walletTotals.set(key, (walletTotals.get(key) || 0) + usd);
  }

  const distinctWallets = walletTotals.size;
  const trackedUsd = [...walletTotals.values()].reduce((sum, value) => sum + value, 0);
  const topShare = trackedUsd > 0 ? Math.max(...walletTotals.values()) / trackedUsd : 0;

  if (undated > 0) reasons.push(`${undated} 笔买入缺少时间戳，无法确认是否落在 15 分钟窗口内`);
  if (priceless > 0) reasons.push(`${priceless} 笔买入缺少 USD 金额，未计入窗口总额`);

  if (windowTotalUsd <= 0) {
    reasons.push(`窗口内没有可用买入事件，按中性 ${cfg.neutralScore} 处理，不作为汇聚证据`);
    return { score: cfg.neutralScore, reasons, distinctWallets, windowTotalUsd: 0, converged: false };
  }

  const breadthOk = distinctWallets >= cfg.minWallets;
  const concentrated = topShare > cfg.maxWalletShare;
  if (concentrated) {
    reasons.push(
      `单一钱包占窗口买入额 ${(topShare * 100).toFixed(1)}%（上限 ${(cfg.maxWalletShare * 100).toFixed(0)}%），` +
      '是集中而非汇聚，记中性分'
    );
  }
  if (!breadthOk) {
    reasons.push(`窗口内仅 ${distinctWallets} 个独立钱包，低于 ${cfg.minWallets} 钱包的汇聚门槛`);
  }

  if (concentrated) {
    // Concentration is scored, not averaged: a whale's window is not evidence
    // of a broad base of buyers, so the breadth/volume blend is not run.
    return { score: cfg.neutralScore, reasons, distinctWallets, windowTotalUsd, converged: false };
  }

  const breadth = Math.min(1, distinctWallets / Math.max(1, cfg.breadthWallets));
  const volume = Math.min(1, windowTotalUsd / Math.max(1, cfg.volumeUsd));
  const score = Math.round(cfg.maxScore * (cfg.weightBreadth * breadth + cfg.weightVolume * volume));
  const converged = breadthOk && score >= cfg.minConvergenceScore;

  reasons.push(
    `宽度 ${breadth.toFixed(2)}（${distinctWallets}/${cfg.breadthWallets} 钱包）× ${cfg.weightBreadth} + ` +
    `金额 ${volume.toFixed(2)}（$${Math.round(windowTotalUsd).toLocaleString('en-US')}/${cfg.volumeUsd}）× ${cfg.weightVolume}`
  );
  if (!converged && breadthOk) {
    reasons.push(`综合分 ${score} 低于汇聚门槛 ${cfg.minConvergenceScore}`);
  }
  return { score, reasons, distinctWallets, windowTotalUsd: Math.round(windowTotalUsd), converged };
}

/**
 * walletScore — smart-money read built from local truth (cohort win rate) and
 * the USD variant of buy/sell balance.
 *
 * Counting buys is how "800×$20 buys" reads as 80% BUY by count while the token
 * is a net seller by USD (§4.5, USD-vs-count). This scores the USD variant when
 * a source provides it and falls back to counts otherwise, recording which was
 * used.
 *
 * Every contribution is pulled to 0 when its input is absent, so the result
 * degrades toward neutral 50 instead of asserting a confident read.
 *
 * @param {object} input  optional buy/sell flow + cohort facts
 * @returns {{score:number, reasons:string[], degraded:boolean}}
 */
export function walletScore(input = {}) {
  const cfg = { ...WALLET_DEFAULTS, ...(input && typeof input === 'object' && !Array.isArray(input) ? input.config : null) };
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const reasons = [];
  let degraded = false;
  let score = cfg.neutralScore;

  // Real row vocabularies: memeland camelCase, DexScreener txns.m5, and the
  // AVE normalized trending row (`buy_volume_5m`/`buys_5m`, ave.mjs:345-347)
  // that this radar actually feeds in. The window label follows the key that
  // won so a 5-minute read is never reported as an hour of flow.
  const buysUsdHit = firstPresent(source, ['buyUsd1h', 'buy_usd_1h', 'buy_volume_1h', 'buy_volume_5m', 'buy_volume_u_5m']);
  const sellsUsdHit = firstPresent(source, ['sellUsd1h', 'sell_usd_1h', 'sell_volume_1h', 'sell_volume_5m', 'sell_volume_u_5m']);
  const buysUsd = num(buysUsdHit?.value);
  const sellsUsd = num(sellsUsdHit?.value);
  const buysCountHit = firstPresent(source, ['buyCount5m', 'buys5m', 'buys_5m', 'token_buy_tx_count_5m']);
  const sellsCountHit = firstPresent(source, ['sellCount5m', 'sells5m', 'sells_5m', 'token_sell_tx_count_5m']);
  const buysCount = num(buysCountHit?.value ?? source.txns?.m5?.buys ?? null);
  const sellsCount = num(sellsCountHit?.value ?? source.txns?.m5?.sells ?? null);

  let netFlow = 0;
  if (buysUsd !== null && sellsUsd !== null && buysUsd + sellsUsd > 0) {
    netFlow = clamp(((buysUsd - sellsUsd) / (buysUsd + sellsUsd)) * cfg.netFlowWeight, -cfg.netFlowWeight, cfg.netFlowWeight);
    score += netFlow;
    const usdWindow = /5m/.test(buysUsdHit?.key ?? '') ? '5 分钟' : '1 小时';
    reasons.push(`${usdWindow}净流入按 USD 计 ${netFlow >= 0 ? '+' : ''}${netFlow.toFixed(1)}（上限 ±${cfg.netFlowWeight}）`);
  } else if (buysCount !== null && sellsCount !== null && buysCount + sellsCount > 0) {
    netFlow = clamp(((buysCount - sellsCount) / (buysCount + sellsCount)) * cfg.netFlowWeight, -cfg.netFlowWeight, cfg.netFlowWeight);
    score += netFlow;
    reasons.push(`净流入仅有笔数可用，按笔数计 ${netFlow >= 0 ? '+' : ''}${netFlow.toFixed(1)}（未折算 USD）`);
  } else {
    degraded = true;
    reasons.push('缺少买卖两侧的净流入数据，净流入贡献记 0');
  }

  const winRate = num(source.walletWinRate ?? source.winRate ?? source.cohort?.winRate ?? null);
  const samples = num(source.walletSamples ?? source.samples ?? source.cohort?.samples ?? null);
  if (winRate !== null && samples !== null && samples >= cfg.minSmartMoneySamples) {
    const contribution = clamp(
      (winRate - 0.5) * 2 * cfg.smartMoneyWeight,
      -cfg.smartMoneyWeight,
      cfg.smartMoneyWeight
    );
    score += contribution;
    reasons.push(`共买钱包胜率 ${(winRate * 100).toFixed(0)}%（样本 ${samples}）贡献 ${contribution >= 0 ? '+' : ''}${contribution.toFixed(1)}`);
  } else {
    degraded = true;
    reasons.push(
      samples === null
        ? '缺少钱包群组胜率样本，聪明钱贡献记 0'
        : `钱包群组样本 ${samples} 不足 ${cfg.minSmartMoneySamples}，胜率 ${winRate === null ? '未知' : `${(winRate * 100).toFixed(0)}%`} 未采信`
    );
  }

  return { score: clamp(Math.round(score), 0, 100), reasons, degraded };
}

/**
 * Normalize one bot signal. Returns null (unknown) rather than a guessed 0, so
 * the caller can distinguish "measured clean" from "never measured".
 */
function botSignalValue(raw) {
  const value = num(typeof raw === 'object' && raw !== null ? raw.rate ?? raw.value : raw);
  if (value === null) return null;
  // GoPlus-family fields arrive as 0-1 ratios on some endpoints and as 0-100
  // percentages on others. A negative or >100 rate is malformed data, not a
  // clean measurement, so it is reported unknown rather than laundered to 0.
  if (value < 0 || value > 100) return null;
  return value > 1 ? value / 100 : value;
}

/**
 * botRisk — 0-100 bot likelihood, failing OPEN.
 *
 * Every point is attributable: `reasons` names the signal and its bounded
 * contribution. Unknown signals contribute 0 and set `degraded`, so missing
 * data can only ever lower the score — it can never manufacture risk, and it
 * can never read as "verified safe" either, which is why `degraded` is part of
 * the return shape and must be shown alongside the score.
 *
 * @param {{bundle?:number,sniper?:number,gradualBundle?:number,washTrading?:number,concentration?:number}} signals
 * @returns {{score:number, severity:string, reasons:{signal:string,contribution:number}[], degraded:boolean}}
 */
export function botRisk(signals = {}) {
  const source = signals && typeof signals === 'object' && !Array.isArray(signals) ? signals : {};
  const reasons = [];
  let degraded = false;
  let score = 0;

  for (const [signal, weight] of Object.entries(BOT_SIGNAL_WEIGHTS)) {
    if (!(signal in source)) {
      degraded = true;
      reasons.push({ signal, contribution: 0 });
      continue;
    }
    const value = botSignalValue(source[signal]);
    if (value === null) {
      degraded = true;
      reasons.push({ signal, contribution: 0 });
      continue;
    }
    const contribution = Math.round(clamp(value, 0, 1) * weight);
    score += contribution;
    reasons.push({ signal, contribution });
  }

  const total = clamp(Math.round(score), 0, 100);
  const band = total < 20 ? 0 : total < 40 ? 1 : total < 60 ? 2 : total < 80 ? 3 : 4;
  return { score: total, severity: BOT_RISK_SEVERITIES[band], reasons, degraded };
}

const BOT_SIGNAL_ALIASES = Object.freeze({
  bundle: ['bundle', 'bundlerRate', 'bundler_rate'],
  sniper: ['sniper', 'sniperHold', 'sniper_hold', 'sniperHoldRate'],
  gradualBundle: ['gradualBundle', 'gradual_bundle', 'gradualBundlerRate'],
  washTrading: ['washTrading', 'wash', 'wash_trading', 'washRate'],
  concentration: ['concentration', 'top10Rate', 'top10_rate', 'concentrationRate']
});

const CONVERGENCE_EVENT_KEYS = ['convergenceEvents', 'poolTxs', 'pool_txs', 'buys', 'buyEvents'];
const NET_FLOW_KEYS = ['buyUsd1h', 'sellUsd1h', 'buyCount5m', 'sellCount5m', 'txns'];

function firstPresent(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null) return { key, value };
  }
  return null;
}

/**
 * signalEvidenceBundle — the object the captain drops under `candidate.deep.signal`.
 *
 * A part is present only when its input actually exists. Missing parts are
 * ABSENT from the bundle rather than filled with a neutral placeholder number,
 * because a fabricated 50 would be indistinguishable from a real reading in
 * the UI and would let a later consumer treat absence as evidence. `degraded`
 * is the single flag that says "some of this is missing".
 *
 * @param {object} row      discovery row (or any object carrying flow fields)
 * @param {object} [extras] { convergenceEvents, botSignals, wallet, now }
 * @returns {{convergence?:object, wallet?:object, bot?:object, degraded:boolean, capturedAt:number}}
 */
export function signalEvidenceBundle(row = {}, extras = {}) {
  const source = row && typeof row === 'object' ? row : {};
  const add = extras && typeof extras === 'object' && !Array.isArray(extras) ? extras : {};
  const now = num(add.now) ?? num(add.capturedAt) ?? Date.now();
  const bundle = { degraded: false, capturedAt: now };

  const events = firstPresent(add, CONVERGENCE_EVENT_KEYS) || firstPresent(source, CONVERGENCE_EVENT_KEYS);
  if (events && Array.isArray(events.value) && events.value.length > 0) {
    bundle.convergence = flowConvergenceScore(events.value, add.convergenceConfig ?? {}, now);
  } else {
    bundle.degraded = true;
  }

  const wallet = add.wallet && typeof add.wallet === 'object' ? add.wallet : source;
  if (firstPresent(wallet, NET_FLOW_KEYS) || firstPresent(wallet, ['walletWinRate', 'winRate', 'walletSamples', 'samples', 'cohort'])) {
    bundle.wallet = walletScore(wallet);
    if (bundle.wallet.degraded) bundle.degraded = true;
  } else {
    bundle.degraded = true;
  }

  const botSource = add.botSignals && typeof add.botSignals === 'object' ? add.botSignals : source;
  const known = Object.keys(BOT_SIGNAL_WEIGHTS).filter(signal =>
    BOT_SIGNAL_ALIASES[signal].some(alias => botSignalValue(typeof botSource?.[alias] === 'object' && botSource[alias] !== null
      ? botSource[alias].rate ?? botSource[alias].value
      : botSource?.[alias]) !== null)
  );
  if (known.length > 0) {
    const mapped = {};
    for (const signal of known) {
      const hit = BOT_SIGNAL_ALIASES[signal].find(alias => botSource?.[alias] !== undefined && botSource?.[alias] !== null);
      mapped[signal] = botSource[hit];
    }
    bundle.bot = botRisk(mapped);
    if (bundle.bot.degraded) bundle.degraded = true;
  } else {
    bundle.degraded = true;
  }

  return bundle;
}

function readStore(store, key) {
  if (store instanceof Map) return store.get(key);
  if (store && typeof store.get === 'function') return store.get(key);
  return store?.[key];
}

function writeStore(store, key, at) {
  if (store instanceof Map) return void store.set(key, at);
  if (store && typeof store.set === 'function') return void store.set(key, at);
  store[key] = at;
  return undefined;
}

/**
 * publishDedup — per-token, per-alert-type cooldown.
 *
 * The store is injected so the captain can bind the durable `dedupEntries`
 * key→timestamp map in RadarState and survive restarts; with no store the
 * default is in-process, matching memeland's ChatNotifier.
 *
 * `force:true` (or `cooldownMs:0`) is the explicit send-anyway path: it sends
 * AND refreshes the stamp, so a forced publish still starts a fresh cooldown
 * instead of leaving the key permanently expired.
 *
 * @param {{key:string, now?:number, store?:Map|object, cooldownMs?:number, force?:boolean}} options
 * @returns {{send:boolean, remainingMs:number}}
 */
export function publishDedup({ key, now, store = MEMORY_DEDUP, cooldownMs, force = false } = {}) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new TypeError('publishDedup requires a non-empty key');
  }
  const at = num(now) ?? Date.now();
  const cooldown = num(cooldownMs) ?? PUBLISH_DEDUP_DEFAULTS.cooldownMs;
  const lastSentAt = num(readStore(store, key));
  // A stamp in the future means the clock moved backwards. Clamping it to `at`
  // keeps the send blocked for a full cooldown instead of admitting a
  // negative remaining window — dedup over-sends at worst.
  const last = lastSentAt === null ? null : Math.min(lastSentAt, at);

  if (!force && last !== null && cooldown > 0) {
    const remainingMs = last + cooldown - at;
    if (remainingMs > 0) return { send: false, remainingMs };
  }

  writeStore(store, key, at);
  return { send: true, remainingMs: 0 };
}