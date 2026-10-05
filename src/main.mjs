#!/usr/bin/env node
import { config, ROOT } from './config.mjs';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AveClient } from './ave.mjs';
import { createAveSettings } from './ave-settings.mjs';
import { RadarState } from './state.mjs';
import { Scanner } from './scanner.mjs';
import { DexBatchMarketOverlay, SecondaryValidator } from './secondary.mjs';
import { createServer, toPublicStatus } from './server.mjs';
import { RadarControls } from './local-store.mjs';
import { LiveDiscovery } from './live-discovery.mjs';
import { configureWindowsSystemProxy } from './windows-proxy.mjs';

// Windows portable supervisor bridge: keep the packaged EXE launcher intact.
const once = process.argv.includes('--once');
if (process.platform === 'win32' && !once && process.env.RADAR_SUPERVISED !== '1'
  && resolve(process.execPath).toLowerCase() === resolve(ROOT, 'runtime', 'node.exe').toLowerCase()) {
  try {
    const { superviseRadar } = await import('../scripts/supervise.mjs');
    await superviseRadar();
    process.exit(0);
  } catch (error) {
    console.error('守护启动未完成：' + error.message);
    process.exit(1);
  }
}

// Browsers use the Windows system proxy automatically, while Node normally
// only sees proxy environment variables. Mirror the effective Windows proxy
// before AVE reads begin so the portable build follows the same
// network route as the user's browser.
const proxy = configureWindowsSystemProxy();
if (process.platform === 'win32') {
  console.log(proxy.proxy ? '已接入 Windows 系统网络代理。' : '未检测到 Windows 系统代理，将使用直连网络。');
}

const state = new RadarState(config.stateDir);
let scanner;
// Production discovery deliberately performs one hot-list read per turn. The
// current AVE head response already carries the card fields; pagination and
// automatic per-token completion must not amplify a shared-key rate limit.
// That posture is the default in config.mjs; an operator who has headroom can
// widen it per environment without touching this file.
const sharedRequestIntervalMs = 5 * 60_000;
const market = new AveClient({ directory: config.stateDir, apiKeyProvider: () => ave.getKey(),
  enrichLimit: config.enrichLimit, maxTrendingPages: config.maxTrendingPages,
  // AveClient rejects rotateTrendingPages unless it is pinned to a single page
  // (ave.mjs:499), so rotation is exactly the one-page default, not a constant.
  rotateTrendingPages: config.maxTrendingPages === 1,
  minimumGapMs: sharedRequestIntervalMs });
const ave = createAveSettings({ directory: config.stateDir,
  verifyData: (key, options) => market.verifyApiKey(key, options),
  onChange: () => { market.resetCredentials(); scanner?.requestCycle(); }
});
// Keep old history and credentials on disk, but never reuse a previous
// provider's pass or an unlabelled baseline as current AVE evidence.
if (state.value.scanProvider !== 'AVE') {
  for (const scope of [state.value, ...Object.values(state.value.chainStates || {})]) {
    for (const row of scope.outcomes || []) row.baselineProvider ||= 'LEGACY_UNKNOWN';
    for (const row of scope.candidates || []) {
      row.marketProvider ||= 'LEGACY_UNKNOWN';
      if (row.status === 'X_REVIEW') {
        row.status = 'WAIT_RECHECK'; row.staleAt = 0;
        row.deep = { ...row.deep, chainPass: false };
        row.decisionReason = '已切换 AVE，等待新来源核验';
      }
    }
    scope.sourceHealth = {}; scope.retryAt = 0;
  }
  state.value.scanProvider = 'AVE'; state.save();
}
const controls = new RadarControls(config.stateDir, config.supportedChains, state.value.activeChain || config.chain);
scanner = new Scanner({ provider: market, secondary: new SecondaryValidator(), state, controls, sharedRequestIntervalMs });
const liveDiscovery = new LiveDiscovery({ provider: market, cacheOnly: true, marketOverlay: new DexBatchMarketOverlay() });
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

if (once) {
  await scanner.cycle();
  console.log(JSON.stringify(toPublicStatus(state.value), null, 2));
  process.exit(state.value.status === 'ERROR' ? 1 : 0);
}

const server = createServer({
  ave,
  state,
  controls,
  liveDiscovery,
  enqueueReview: (chain, row) => scanner.enqueueReview(chain, row),
  settings: { ...config, version },
  supportedChains: config.supportedChains,
  switchChain: chain => scanner.switchChain(chain),
  getAveConnection: () => ave.snapshot(),
  getSchedulerStatus: chain => scanner.scheduleSnapshot(chain),
  getMarketStatus: () => market.snapshot()
});
server.requestTimeout = 10_000;
server.headersTimeout = 12_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

await new Promise((resolve, reject) => {
  server.once('error', reject);
  // Defaults to 127.0.0.1. A container must listen on 0.0.0.0 to be reachable
  // through its platform proxy, which is what RADAR_BIND opts into.
  server.listen(config.port, config.bindAddress, resolve);
});
const displayHost = config.bindAddress === '0.0.0.0' || config.bindAddress === '::' ? '[::]' : config.bindAddress;
console.log(`Meme雷达：http://${displayHost}:${config.port}`);
console.log('只读扫描器：交易执行永久关闭');
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true; scanner.stop(); liveDiscovery.stop();
  market.resetCredentials({ disabled: true });
  server.close(() => process.exit(0));
  server.closeIdleConnections();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown());
await scanner.start();
