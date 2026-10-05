import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'public', 'index.html'), 'utf8');

function liveRefreshHarness(fetch) {
  const previous = { chain: 'bsc', rows: [{ symbol: 'PREVIOUS' }] };
  const context = { fetch, AbortSignal, document: { hidden: false },
    renderLive() {}, activeChain: data => data.activeChain,
    liveEnabled: true, liveBusy: false, serviceOnline: true, liveRefreshErrorChain: '',
    lastData: { activeChain: 'bsc' }, viewChain: 'bsc', liveData: previous };
  const start = html.indexOf('async function refreshLive()'), end = html.indexOf('function render(data, forceCandidates)', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(html.slice(start, end), context);
  return { context, previous };
}

test('candidate timeout, HTTP and payload failures preserve data and do not mark a healthy local service offline', async () => {
  const failures = [
    async () => { throw new DOMException('timed out', 'TimeoutError'); },
    async () => { throw new TypeError('Failed to fetch'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid json'); } }),
    async () => ({ ok: true, json: async () => ({ chain: 'sol', rows: [] }) }),
    async () => ({ ok: true, json: async () => ({ chain: 'bsc', rows: null }) }),
  ];
  for (const fetch of failures) {
    const { context, previous } = liveRefreshHarness(fetch);
    await context.refreshLive();
    assert.equal(context.liveRefreshErrorChain, 'bsc');
    assert.equal(context.serviceOnline, true);
    assert.equal(context.liveData, previous);
    assert.equal(context.liveBusy, false);
    const recovered = { chain: 'bsc', rows: [{ symbol: 'RECOVERED' }] };
    context.fetch = async () => ({ ok: true, json: async () => recovered });
    await context.refreshLive();
    assert.equal(context.liveRefreshErrorChain, '');
    assert.equal(context.liveData, recovered);
  }
});

test('an old-chain response or timeout cannot overwrite the newly selected chain or its connection state', async () => {
  for (const fail of [false, true]) {
    let settle;
    const { context } = liveRefreshHarness(() => new Promise((resolve, reject) => {
      settle = () => fail ? reject(new Error('old chain timeout'))
        : resolve({ ok: true, json: async () => ({ chain: 'bsc', rows: [] }) });
    }));
    const pending = context.refreshLive();
    context.viewChain = 'sol';
    const selected = { chain: 'sol', rows: [{ symbol: 'SOL' }] };
    context.liveData = selected;
    settle();
    await pending;
    assert.equal(context.liveData, selected);
    assert.equal(context.liveRefreshErrorChain, '');
    assert.equal(context.serviceOnline, true);
    assert.equal(context.liveBusy, false);
  }
});

test('performance and event panels are removed together with their render hooks; scan status and voice remain', () => {
  assert.doesNotMatch(html, /data-i18n="(?:outcomeTitle|eventsTitle)"/);
  assert.doesNotMatch(html, /id="(?:outcome[^\"]*|events|cycle|requestSummary|eventHistory[^\"]*)"/);
  assert.doesNotMatch(html, /\b(?:eventOverview|renderEvents|renderOutcomes)\s*\(/);
  assert.match(html, /id="livePanel"/);
  assert.match(html, /id="voiceEnable"/);
  assert.match(html, /id="providerState"/);
  assert.match(html, /renderTelemetry\(\)/);
  assert.match(html, /renderLive\(\)/);
});

test('AVE opens token chart/trading with the author referral and never substitutes the pool or source URL', () => {
  const start = html.indexOf('const AVE_INVITE_URL =');
  const end = html.indexOf('function candidateRow', start);
  const context = { t: key => key, escapeHtml: value => String(value).replaceAll('&', '&amp;'), safeUrl: () => '', officialXHandle: () => '' };
  vm.runInNewContext(html.slice(start, end) + ';this.links = actionLinks;this.tokenUrl = aveTokenUrl;', context);
  for (const chain of ['bsc', 'eth', 'base', 'robinhood', 'sol']) {
    const address = chain === 'sol' ? 'So11111111111111111111111111111111111111112' : '0x059ecb64e45b6211f1390d5f28cc909203ca7777';
    const links = context.links({ chain, address, pairAddress: 'wrong-pool', gmgnUrl: 'https://gmgn.ai/override' });
    assert.ok(links.includes('https://pro.ave.ai/token/' + address + '-' + (chain === 'sol' ? 'solana' : chain) + '?ref=0001'));
    assert.ok(links.includes('aveTrade')); assert.doesNotMatch(links, /wrong-pool/);
    assert.match(links, /data-action="copy"/); assert.doesNotMatch(links, /gmgn.ai/);
  }
  for (const row of [{ chain:'unknown',address:'0x059ecb64e45b6211f1390d5f28cc909203ca7777' },
    { chain:'arc',address:'0x059ecb64e45b6211f1390d5f28cc909203ca7777' },
    { chain:'stable',address:'0x059ecb64e45b6211f1390d5f28cc909203ca7777' },
    { chain:'bsc',address:'not-a-ca' }, { chain:'bsc',address:'0x059ecb64e45b6211f1390d5f28cc909203ca7777?ref=evil' }]) {
    assert.equal(context.tokenUrl(row.chain,row.address), null);
    assert.match(context.links(row), /https:\/\/share\.ave\.ai\?lang=zh-cn&amp;code=0001/);
    assert.doesNotMatch(context.links(row), /pro\.ave\.ai/);
  }
  assert.match(html, /id="ave-api-key"[^>]*type="password"/);
  assert.doesNotMatch(html, /ave-data-key|ave-trade-key|data-ave-kind/);
  const connector = html.slice(html.indexOf('let aveBusy'), html.indexOf('async function refresh()'));
  assert.doesNotMatch(connector, /localStorage|sessionStorage|window.open|privateKey|signTransaction/);
});

test('AVE failed retest updates the Data badge while retaining the failure notice and saved-key summary', async () => {
  const elements = Object.fromEntries(['ave-api-key', 'ave-config-status', 'ave-data-status', 'aveSummary', 'aveSettings']
    .map(id => [id, { dataset: {}, textContent: '', value: '' }]));
  const context = {
    byId: id => elements[id], t: key => key,
    document: { querySelectorAll: () => [] }, AbortSignal,
    fetch: async () => ({ ok: false, json: async () => ({ error: 'AVE_AUTH',
      ave: { configured: true, data: { configured: true, status: 'error' }, trade: { configured: false, status: 'disabled' } } }) }),
  };
  vm.runInNewContext(html.slice(html.indexOf('let aveBusy'), html.indexOf('async function refresh()'))
    + ';this.change = changeAve;this.render = renderAveConnection;', context);
  context.render({ configured: true, data: { status: 'connected' } });
  assert.equal(elements['ave-data-status'].textContent, 'aveChecked');
  await context.change('configure');
  assert.equal(elements['ave-data-status'].textContent, 'aveFailed');
  assert.equal(elements['aveSummary'].textContent, ' · aveKeySaved');
  assert.match(elements['ave-config-status'].textContent, /AVE_AUTH/);
});

const AVE_UI_AT = Date.UTC(2026, 8, 30, 12);
function aveConnectionHarness(fetch) {
  const elements = Object.fromEntries(['ave-api-key', 'ave-config-status', 'ave-data-status', 'aveSummary',
    'aveSettings', 'languageSelect', 'notice'].map(id => [id, { dataset: {}, textContent: '', value: '',
    getAttribute(name) { return name === 'data-i18n' ? this.dataset.i18n : undefined; }, setAttribute() {} }]));
  const buttons = [{ disabled: false }, { disabled: false }];
  const saved = { configured: true, data: { configured: true, status: 'connected' } };
  const context = { fetch, AbortSignal, currentLocale: 'zh-CN', supportedLocales: ['zh-CN', 'en'],
    Date: class extends Date { static now() { return AVE_UI_AT; } },
    byId: id => elements[id], formatClock: value => 'clock:' + value,
    document: { documentElement: {}, querySelectorAll(selector) {
      if (selector === '.ave-settings button') return buttons;
      if (selector === '[data-i18n]') return Object.values(elements).filter(element => element.dataset.i18n);
      return [];
    } },
    writeStorage() {}, window: { dispatchEvent() {} }, CustomEvent: class {},
    renderChainSwitcher() {}, renderTelemetry() {}, lastData: { aveConnection: saved },
    refresh() {},
  };
  context.t = (key, args) => context.currentLocale + ':' + key + (args ? ':' + JSON.stringify(args) : '');
  context.render = data => context.renderAveConnection(data.aveConnection);
  const connector = html.slice(html.indexOf('let aveBusy'), html.indexOf('async function refresh()'));
  const locales = html.slice(html.indexOf('function applyStaticTranslations()'), html.indexOf('const number = function'));
  vm.runInNewContext(connector + locales + ';this.feedback=()=>aveFeedback;this.isBusy=()=>aveBusy;', context);
  context.renderAveConnection(saved);
  return { context, elements, buttons, saved };
}

test('AVE connection feedback distinguishes budgets, queue wait and real network/upstream failures', async () => {
  const mapped = { AVE_HOURLY_BUDGET: 'aveHourlyPaused', AVE_TOTAL_BUDGET: 'aveTotalPaused',
    AVE_DISCOVERY_RESERVE: 'aveTestReserved', AVE_WAIT: 'aveTestWaiting', AVE_NETWORK: 'aveTestNetwork', AVE_UPSTREAM: 'aveTestUpstream' };
  for (const [code, message] of Object.entries(mapped)) {
    const retryAt = AVE_UI_AT + 7200000;
    const snapshot = { configured: true, data: { configured: true,
      status: ['AVE_NETWORK', 'AVE_UPSTREAM'].includes(code) ? 'error' : 'waiting', code, retryAt } };
    const { context, elements } = aveConnectionHarness(async () => ({ ok: false, json: async () => ({ error: code, retryAt, ave: snapshot }) }));
    elements['ave-api-key'].value = 'synthetic-form-key';
    await context.changeAve('configure');
    assert.match(elements['ave-config-status'].textContent, new RegExp('zh-CN:' + message));
    assert.match(elements['ave-config-status'].textContent, new RegExp('clock:' + retryAt));
    assert.equal(elements['ave-data-status'].textContent, 'zh-CN:' + (snapshot.data.status === 'waiting' ? 'aveDeferred' : 'aveFailed'));
    assert.equal(elements['ave-api-key'].value, '');
    assert.doesNotMatch(elements['ave-config-status'].textContent, /synthetic-form-key/);
  }
});

test('AVE failure notice survives status polling and changes language without reverting to Key saved', async () => {
  const { context, elements, saved } = aveConnectionHarness(async () => ({ ok: false,
    json: async () => ({ error: 'AVE_WAIT', retryAt: AVE_UI_AT + 300000, ave: { configured: true, data: { status: 'waiting' } } }) }));
  await context.changeAve('configure');
  context.renderAveConnection(saved);
  assert.match(elements['ave-config-status'].textContent, /zh-CN:aveTestWaiting/);
  assert.equal(elements['ave-config-status'].dataset.i18n, undefined);
  context.setLocale('en', true);
  assert.match(elements['ave-config-status'].textContent, /en:aveTestWaiting/);
  assert.doesNotMatch(elements['ave-config-status'].textContent, /aveKeySaved|zh-CN:/);
  context.lastData = null;
  context.setLocale('zh-CN', true);
  assert.match(elements['ave-config-status'].textContent, /zh-CN:aveTestWaiting/,
    'feedback must also change language before the first main status snapshot arrives');
});

test('AVE busy notice remains visible during polling and a language switch', async () => {
  let release;
  const { context, elements, buttons, saved } = aveConnectionHarness(() => new Promise(resolve => { release = resolve; }));
  const request = context.changeAve('configure');
  assert.equal(context.isBusy(), true); assert.ok(buttons.every(button => button.disabled));
  context.renderAveConnection(saved);
  assert.equal(elements['ave-config-status'].textContent, 'zh-CN:aveChecking');
  context.setLocale('en', true);
  assert.equal(elements['ave-config-status'].textContent, 'en:aveChecking');
  release({ ok: true, json: async () => ({ ave: saved }) }); await request;
  assert.equal(context.isBusy(), false); assert.ok(buttons.every(button => !button.disabled));
  assert.equal(elements['ave-config-status'].textContent, 'en:aveKeySaved');
});

test('delayed AVE status response cannot replace a newly successful configure result', async () => {
  let release;
  const { context, elements, saved } = aveConnectionHarness(url => url === '/api/ave-status'
    ? new Promise(resolve => { release = resolve; })
    : Promise.resolve({ ok: true, json: async () => ({ ave: saved }) }));
  const oldPoll = context.refreshAve();
  await context.changeAve('configure');
  release({ ok: true, json: async () => ({ ave: { configured: false, data: { configured: false, status: 'untested' } } }) });
  await oldPoll;
  assert.equal(elements['ave-config-status'].textContent, 'zh-CN:aveKeySaved');
  assert.equal(elements['ave-data-status'].textContent, 'zh-CN:aveChecked');
  assert.equal(elements['aveSummary'].textContent, ' · zh-CN:aveKeySaved');
});

test('successful manual retry clears the previous AVE failure and never returns it on later polls', async () => {
  let succeed = false;
  const { context, elements, saved } = aveConnectionHarness(async () => ({ ok: succeed,
    json: async () => succeed ? { ave: saved } : { error: 'AVE_NETWORK', ave: { configured: true, data: { status: 'error' } } } }));
  await context.changeAve('configure');
  assert.match(elements['ave-config-status'].textContent, /aveTestNetwork/);
  succeed = true; await context.changeAve('configure');
  assert.equal(context.feedback(), null);
  context.renderAveConnection(saved);
  assert.equal(elements['ave-config-status'].textContent, 'zh-CN:aveKeySaved');
});

test('AVE feedback ignores invalid retry timestamps and never displays raw unknown error payloads', async () => {
  for (const retryAt of [undefined, Infinity, NaN, -1, AVE_UI_AT, AVE_UI_AT + 0.5,
    String(AVE_UI_AT + 300000), AVE_UI_AT + 367 * 86400000]) {
    const { context, elements } = aveConnectionHarness(async () => ({ ok: false,
      json: async () => ({ error: 'AVE_WAIT', retryAt }) }));
    await context.changeAve('configure');
    assert.match(elements['ave-config-status'].textContent, /aveTestWaiting/);
    assert.doesNotMatch(elements['ave-config-status'].textContent, /aveTestRetryAt|clock:/);
  }
  for (const secret of ['synthetic-private-key-in-upstream-text', 'AVE_SYNTHETIC_SECRET_KEY']) {
    for (const fetch of [async () => ({ ok: false, json: async () => ({ error: secret }) }),
      async () => { throw new Error(secret); }]) {
      const { context, elements } = aveConnectionHarness(fetch);
      await context.changeAve('configure');
      assert.match(elements['ave-config-status'].textContent, /aveTestUnknown/);
      assert.equal(elements['ave-config-status'].textContent.includes(secret), false);
    }
  }
});

test('所有内联脚本均可通过语法解析', () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 2);
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script[1]));
});

test('所有显式像素字号均不小于14像素', () => {
  const sizes = [...html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
  assert.ok(sizes.length > 0);
  assert.ok(sizes.every(size => size >= 14));
});

test('看板明确区分累计、本轮和近30分钟口径', () => {
  assert.match(html, /<h1[^>]*>Meme雷达开源版<\/h1>/);
  assert.match(html, /class="mark">雷达<\/div>/);
  assert.match(html, /扫描轮次[\s\S]*累计/);
  assert.match(html, /发现代币[\s\S]*本轮/);
  assert.match(html, /深度审计[\s\S]*近30分钟/);
  assert.match(html, /链上候选\/待人工看X/);
  assert.doesNotMatch(html, /最终候选/);
});

test('自动筛选替代人工通过，保留历史标记兼容且不下单', () => {
  assert.match(html, /robinhoodRadarManualMarksV1/);
  assert.doesNotMatch(html, /data-action="pass"/);
  assert.doesNotMatch(html, /data-action="ignore"/);
  assert.match(html, /id="advancedPanel"[^>]*>/);
  assert.doesNotMatch(html, /id="advancedPanel"[^>]*\bopen\b/);
  assert.match(html, /value="new" selected/);
  assert.match(html, /class="compact-audits"/);
  assert.match(html, /复制合约/);
  assert.match(html, /官网无/);
  assert.match(html, /访问官网/);
  assert.match(html, /safeUrl\(row\.info && row\.info\.website\)/);
  assert.match(html, /officialXHandle/);
  assert.match(html, /normalizeXHandle/);
  assert.match(html, /reservedXPaths/);
  assert.match(html, /普通钱包代理数量未知/);
  assert.match(html, /noopener noreferrer/);
  assert.match(html, /只扫描、不交易/);
});

test('前端X入口拒绝站内功能页并只生成单层用户名链接', () => {
  const start = html.indexOf('const reservedXPaths = new Set(');
  const end = html.indexOf('function officialXHandle', start);
  assert.ok(start >= 0 && end > start);
  const context = { URL };
  vm.runInNewContext(html.slice(start, end) + '\nthis.normalize = normalizeXHandle;', context);
  assert.equal(context.normalize('https://x.com/search?q=test'), '');
  assert.equal(context.normalize('https://x.com/home'), '');
  assert.equal(context.normalize('x.com/real_handle'), 'real_handle');
  assert.equal(context.normalize('@real_handle'), 'real_handle');
  assert.equal(context.normalize('https://example.com/x.com/fake'), '');
  assert.equal('https://x.com/' + encodeURIComponent(context.normalize('x.com/real_handle')), 'https://x.com/real_handle');
});

test('六语切换持久化并支持阿拉伯语RTL', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'ar']) {
    assert.match(html, new RegExp('<option value="' + locale + '"'));
  }
  assert.match(html, /memeRadarLanguageV1/);
  assert.match(html, /document\.documentElement\.dir = currentLocale === 'ar' \? 'rtl' : 'ltr'/);
  assert.match(html, /html\[dir="rtl"\]/);
  assert.match(html, /data-i18n="appTitle"/);
  assert.match(html, /data-i18n="auditTitle"/);
  assert.match(html, /t\(statusKeys\[data\.status\]/);
  assert.doesNotMatch(html, /GMGN多链候选雷达 · 只扫描、只筛选、永不下单/);
});

test('语言下拉使用地球图标和深色高对比选项', () => {
  assert.match(html, /class="language-icon" aria-hidden="true">🌐<\/span>/);
  assert.match(html, /class="visually-hidden" data-i18n="languageLabel">语言<\/span>/);
  assert.match(html, /\.language-select\s*\{[\s\S]*?color-scheme:\s*dark/);
  assert.match(html, /\.language-select option\s*\{[\s\S]*?background:\s*#0b151a;[\s\S]*?color:\s*#f2faf8/);
  assert.match(html, /\.language-select:focus-visible\s*\{[\s\S]*?outline:\s*1px solid #61cbd4/);
  assert.doesNotMatch(html, /\.language-select\s*\{[\s\S]*?background:\s*transparent/);
});

test('语音播报提供独立的中英文手动切换，最近成功与限频状态分开显示', () => {
  assert.match(html, /id="voiceLanguage"[^>]*>[\s\S]*?<option value="zh">中文<\/option>[\s\S]*?<option value="en">English<\/option>/);
  assert.match(html, /memeRadarLastSuccessAtV2:/);
  assert.match(html, /recentSuccess/);
  assert.doesNotMatch(html, /robinhoodRadarLastSuccessAtV1/);
});

test('翻译词典完整覆盖静态挂点和动态文案键', () => {
  const dictionarySource = html.match(/const messages = (\{[\s\S]*?\n    \});\n\n    let currentLocale/);
  assert.ok(dictionarySource, '应能提取翻译词典');
  const messages = vm.runInNewContext('(' + dictionarySource[1] + ')');
  for (const [key, values] of Object.entries(messages)) {
    assert.ok(Array.isArray(values), key + ' 应为数组');
    assert.equal(values.length, 6, key + ' 应包含六种语言');
    assert.ok(values.every(value => typeof value === 'string' && value.length > 0), key + ' 不应有空翻译');
  }
  const staticKeys = [...html.matchAll(/data-i18n(?:-placeholder|-aria)?="([^"]+)"/g)].map(match => match[1]);
  const dynamicKeys = [...html.matchAll(/\bt\('([^']+)'/g)].map(match => match[1]);
  for (const key of new Set([...staticKeys, ...dynamicKeys])) assert.ok(messages[key], '缺少翻译键：' + key);
});

test('顶部链标签可直接加入或切换扫描，且始终最多五条', async () => {
  for (const chain of ['sol', 'bsc', 'base', 'eth', 'robinhood']) {
    assert.match(html, new RegExp("id: '" + chain + "'"));
  }
  assert.match(html, /renderChainSwitcher\(null\)/);
  const start = html.indexOf('function activeChain('), end = html.indexOf('function providerStatus(', start);
  assert.ok(start >= 0 && end > start);
  function harness(enabled, active = 'bsc', view = '') {
    const elements = { chainSwitcher: { innerHTML: '' }, chainHint: { textContent: '' } };
    const requests = [], storage = [], toasts = [];
    const context = {
      chainCatalog: ['sol', 'bsc', 'base', 'eth', 'robinhood'].map(id => ({ id })),
      chainSwitching: false, selectedChainsDirty: true, viewChain: view,
      lastData: { activeChain: active, supportedChains: ['sol', 'bsc', 'base', 'eth', 'robinhood'], scheduler: { enabledChains: enabled, scanningChain: active } },
      byId: id => elements[id], chainLabel: chain => chain.id, escapeHtml: String, t: key => key,
      MAX_SCAN_CHAINS: 5,
      showToast: value => toasts.push(value), currentLocale: 'en', hasChinese: () => false,
      postLocal: async (url, body) => { requests.push({ url, body }); return { enabledChains: body.chains }; },
      writeStorage: (key, value) => storage.push({ key, value }), refresh: async () => {}
    };
    vm.runInNewContext(html.slice(start, end) + ';this.renderChainSwitcher=renderChainSwitcher;this.switchActiveChain=switchActiveChain;this.ensureVisibleChain=ensureVisibleChain;', context);
    return { context, elements, requests, storage, toasts };
  }

  const adding = harness(['bsc']);
  adding.context.renderChainSwitcher(adding.context.lastData);
  for (const chain of ['sol', 'bsc', 'base', 'eth', 'robinhood']) {
    const button = adding.elements.chainSwitcher.innerHTML.match(new RegExp('<button[^>]*data-chain="' + chain + '"[^>]*>'))?.[0];
    assert.ok(button, chain + ' 应显示');
    assert.doesNotMatch(button, /\sdisabled(?:\s|>)/, chain + ' 应可点击');
    assert.match(button, new RegExp('title="' + (chain === 'bsc' ? 'chainPollingTitle' : 'chainJoinTitle') + '"'));
    assert.match(button, /aria-label=/);
  }
  assert.equal((adding.elements.chainSwitcher.innerHTML.match(/>chainPollingBadge<\/span>/g) || []).length, 1,
    'only enabled chains show a polling badge; selection is not evidence of health');
  adding.context.renderChainSwitcher(null);
  assert.doesNotMatch(adding.elements.chainSwitcher.innerHTML, /chainPollingBadge/);
  assert.match(adding.elements.chainSwitcher.innerHTML, /chainOfflineHint/);
  await adding.context.switchActiveChain('base');
  assert.deepEqual(JSON.parse(JSON.stringify(adding.requests)), [{ url: '/api/scan-chains', body: { chains: ['bsc', 'base'] } }]);
  assert.equal(adding.context.viewChain, 'base');

  // With room under the cap the chain is appended rather than replacing one.
  const replacing = harness(['bsc', 'sol', 'base'], 'bsc');
  await replacing.context.switchActiveChain('eth');
  assert.deepEqual(JSON.parse(JSON.stringify(replacing.requests)), [{ url: '/api/scan-chains', body: { chains: ['bsc', 'sol', 'base', 'eth'] } }]);
  assert.equal(replacing.context.viewChain, 'eth');

  // The fifth chain still fits the cap, so it is appended.
  const full = harness(['bsc', 'sol', 'base', 'eth'], 'bsc');
  await full.context.switchActiveChain('robinhood');
  assert.deepEqual(JSON.parse(JSON.stringify(full.requests)), [{ url: '/api/scan-chains', body: { chains: ['bsc', 'sol', 'base', 'eth', 'robinhood'] } }]);
  assert.equal(full.context.viewChain, 'robinhood');

  const viewing = harness(['bsc', 'sol'], 'bsc');
  await viewing.context.switchActiveChain('sol');
  assert.deepEqual(viewing.requests, []);
  assert.equal(viewing.context.viewChain, 'sol');

  const restored = harness(['bsc', 'robinhood'], 'robinhood', 'eth');
  assert.equal(restored.context.ensureVisibleChain(restored.context.lastData), true);
  assert.equal(restored.context.viewChain, 'robinhood');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.storage)), [{ key: 'memeRadarViewChainV1', value: 'robinhood' }]);
  assert.doesNotMatch(html.slice(start, end), /\/api\/active-chain/);
});

test('AVE 健康状态使用短句，限频仍显示恢复时间', () => {
  const start = html.indexOf('function providerStatus('), end = html.indexOf('function freshnessStatus(', start);
  const now = Date.now();
  const context = { Date, activeChain: data => data.activeChain, formatClock: value => 'clock:' + value,
    t: (key, args) => args ? key + ':' + JSON.stringify(args) : key, number: Number, relativeTime: String };
  vm.runInNewContext(html.slice(start, end) + ';this.providerStatus=providerStatus;', context);
  const healthy = context.providerStatus({ scanProvider: 'AVE', activeChain: 'bsc', status: 'RUNNING',
    aveMarket: { chains: { bsc: { state: 'observed' } } } });
  assert.equal(healthy.detail, 'avePollingHealthy');
  assert.doesNotMatch(healthy.detail, /liveLimits/);
  const limited = context.providerStatus({ scanProvider: 'AVE', activeChain: 'bsc', status: 'RATE_LIMITED',
    aveMarket: { pauseCode: 'AVE_RATE_LIMITED', nextAllowedAt: now + 60_000 } });
  assert.match(limited.detail, /aveRetryAt/);
  assert.match(limited.detail, /clock:/);
});

test('共享免费调度显示选中链的最早尝试，不把全局或空时间当每链倒计时', () => {
  const start = html.indexOf('function schedulePresentation('), end = html.indexOf('function renderScreening(', start);
  const context = { t: (key, args) => key + (args ? ':' + JSON.stringify(args) : ''), formatDuration: String };
  vm.runInNewContext(html.slice(start, end) + ';this.show=schedulePresentation;', context);
  const at = 1_800_000_000_000;
  const data = { nextCycleAt: at + 300000, scheduler: { scope: 'shared-provider', reason: 'shared_cadence',
    nextSharedAttemptAt: at + 300000, selectedNextAttemptAt: at + 900000 } };
  assert.match(context.show(data, at).title, /900000/);
  assert.equal(context.show(data, at).detail, 'attemptEstimate');
  data.scheduler.selectedNextAttemptAt = null;
  assert.equal(context.show(data, at).title, 'waitingSchedule');
  for (const [reason, title] of Object.entries({ disabled: 'scanDisabled', recovery_chain_deferred: 'chainDeferred',
    auth_required: 'scanNeedsAction', manual_reset_required: 'scanNeedsAction', scanning: 'statusScanning', stopped: 'waitingSchedule' })) {
    data.scheduler.reason = reason;
    assert.equal(context.show(data, at).title, title);
  }
  assert.equal(context.show({}, at), null, 'old snapshots keep a separate compatibility path');
});

test('筛选原因默认折叠，缺失统计不伪造零，行情初筛不标成安全审计', () => {
  const start = html.indexOf('function renderScreening('), end = html.indexOf('function renderTelemetry(', start);
  const elements = Object.fromEntries(['screeningDetails', 'screeningCounts', 'screeningChecked'].map(id => [id, {}]));
  const context = { byId: id => elements[id], number: value => Number(value) || 0, formatCount: String, formatClock: String,
    t: (key, args) => key + (args ? ':' + JSON.stringify(args) : '') };
  vm.runInNewContext(html.slice(start, end) + ';this.show=renderScreening;', context);
  context.show({}); assert.equal(elements.screeningDetails.hidden, true);
  context.show({ screening: { countsAvailable: true, received: 100, marketQualified: 2, filtered: 98,
    checkedAt: 1234, reasonCounts: { activity: 20, missing_market: 30, known_risk: 0 } } });
  assert.equal(elements.screeningDetails.hidden, false);
  assert.match(elements.screeningCounts.textContent, /filterMissing 30/);
  assert.match(elements.screeningCounts.textContent, /filterActivity 20/);
  assert.doesNotMatch(elements.screeningCounts.textContent, /filterRisk/);
  assert.match(elements.screeningChecked.textContent, /1234/);
  assert.match(html, /<details id="screeningDetails"[^>]*hidden>/);
  assert.doesNotMatch(html, /<details id="screeningDetails"[^>]*\bopen\b/);
  assert.match(html, /liveEligible: \['初筛 · 未核验'/);
  assert.match(html, /\['AUTH_REQUIRED', 'AVE_AUTH_REQUIRED'\]\.includes\(data\.status\)/);
});

test('候选空池区分过期行情和当前筛选失败，不能把缓存过期误写成风险排除', () => {
  const start = html.indexOf('function liveEmptyMessage('), end = html.indexOf('function renderLive(', start);
  const context = { t: value => value };
  vm.runInNewContext(html.slice(start, end) + ';this.show=liveEmptyMessage;', context);
  const source = { lastSuccessAt: 1234, receivedCount: 100, diagnostics: { outsideRange: 0 } };
  assert.equal(context.show(source, '', true, 'liveReady'), 'liveStale');
  assert.equal(context.show(source, '', false, 'liveReady'), 'liveExcluded');
  assert.equal(context.show(source, 'query', true, 'liveReady'), 'liveFilteredEmpty');
  assert.equal(context.show(null, '', true, 'aveApiNetwork'), 'aveApiNetwork');
});

test('页面不再公开展示严格筛选规则', () => {
  assert.doesNotMatch(html, /严格筛选标准/);
  assert.doesNotMatch(html, /Strict screening rules/);
  assert.doesNotMatch(html, /data-i18n="criterion[1-8]"/);
  assert.doesNotMatch(html, /\bcriteriaTitle\s*:/);
  assert.doesNotMatch(html, /class="criteria"/);
});

test('AVE 单 Key 仅提交给同源接口且不会持久化或回显', () => {
  assert.match(html, /id="ave-api-key"[^>]*type="password"[^>]*autocomplete="off"[^>]*spellcheck="false"[^>]*maxlength="1024"/);
  assert.match(html, /id="ave-key-form"/);
  assert.match(html, /id="ave-config-status"[^>]*aria-live="polite"/);
  const start = html.indexOf('async function changeAve');
  const end = html.indexOf('async function refresh', start);
  assert.ok(start >= 0 && end > start);
  const source = html.slice(start, end);
  assert.match(source, /fetch\('\/api\/ave-' \+ action/);
  assert.match(source, /body: JSON\.stringify\(body\)/);
  assert.match(source, /byId\('ave-api-key'\)\.value = ''/);
  assert.match(source, /if \(!response\.ok\)\s*\{[\s\S]*?throw/);
  assert.match(source, /renderAveConnection\(result\.ave\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|readStorage|writeStorage/);
  assert.doesNotMatch(source, /console\.|innerHTML|textContent\s*=\s*result\./);
});

test('生产页面无 GMGN 配置流程，AVE 行情不请求钱包私钥或交易权限', () => {
  assert.doesNotMatch(html, /id="(?:gmgnKeyInput|gmgnKeyButton|gmgnKeyStatus|gmgnOnboardingButton|gmgnPublicKey)"/);
  assert.doesNotMatch(html, /fetch\(['"]\/api\/gmgn|connectGmgnApi|prepareGmgnOnboarding/);
  assert.doesNotMatch(html, /gmgn-private-key|privateKey\s*=|eth_requestAccounts|signTransaction|sendTransaction/);
  assert.match(html, /https:\/\/cloud\.ave\.ai\//);
  assert.doesNotMatch(html, /仅测试行情，约 5 CU。单 Key，无需钱包。/);
  assert.doesNotMatch(html, /id="ave-trade-status"|ave-data-key|ave-trade-key/);
});

test('看板包含新鲜度、运行进度和动态降级支持', () => {
  assert.match(html, /最近扫描尝试/);
  assert.match(html, /最近成功扫描/);
  assert.match(html, /下轮扫描/);
  assert.match(html, /数据新鲜度/);
  assert.match(html, /scanInProgress/);
  assert.match(html, /WAIT_RECHECK/);
  assert.match(html, /HARD_REJECT/);
  assert.match(html, /筛选后表现验证/);
  assert.match(html, /30分钟结果/);
  assert.match(html, /2小时结果/);
  assert.match(html, /24小时结果/);
  assert.match(html, /未满50个只做观察，不用于调参/);
  assert.match(html, /prefers-reduced-motion/);
});

test('候选表明确展示GoPlus与DexScreener交叉验证', () => {
  assert.match(html, /GoPlus一票否决/);
  assert.match(html, /GoPlus未见致命项/);
  assert.match(html, /Dex复核/);
  assert.match(html, /多源数据冲突/);
});
