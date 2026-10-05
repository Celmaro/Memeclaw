import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isTrustedLocalRequest } from '../src/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settings = { port: 3791, scanIntervalMs: 120_000, publicDir: path.join(ROOT, 'public') };

// config.mjs reads process.env at import time, so each variation is loaded
// from its own cache-busted module instance.
let configCounter = 0;
async function loadConfig(env) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const url = `${pathToFileURL(path.join(ROOT, 'src', 'config.mjs')).href}?case=${configCounter++}`;
  try {
    return (await import(url)).config;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function request(overrides = {}) {
  return {
    ...overrides,
    socket: overrides.socket || { remoteAddress: '203.0.113.7' },
    headers: {
      host: 'radar.example.com',
      origin: 'http://radar.example.com',
      'sec-fetch-site': 'same-origin',
      ...overrides.headers
    }
  };
}

test('desktop defaults stay loopback-only with no trusted hosts', async () => {
  const config = await loadConfig({ RADAR_BIND: undefined, RADAR_TRUSTED_HOSTS: undefined,
    RADAR_STATE_DIR: undefined, RADAR_PORT: undefined, PORT: undefined });
  assert.equal(config.bindAddress, '127.0.0.1');
  assert.deepEqual([...config.trustedHosts], []);
  assert.equal(config.stateDir, path.join(ROOT, 'state'));
  assert.equal(config.port, 3791);
});

test('bind address accepts only a known interface and rejects arbitrary input', async () => {
  assert.equal((await loadConfig({ RADAR_BIND: '0.0.0.0' })).bindAddress, '0.0.0.0');
  assert.equal((await loadConfig({ RADAR_BIND: '::' })).bindAddress, '::');
  assert.equal((await loadConfig({ RADAR_BIND: 'LOCALHOST' })).bindAddress, 'localhost');
  // Anything outside the allowlist falls back to loopback rather than
  // widening the listening surface to an unexpected address.
  assert.equal((await loadConfig({ RADAR_BIND: '192.168.1.50' })).bindAddress, '127.0.0.1');
  assert.equal((await loadConfig({ RADAR_BIND: '0.0.0.0.evil.example' })).bindAddress, '127.0.0.1');
  assert.equal((await loadConfig({ RADAR_BIND: '' })).bindAddress, '127.0.0.1');
});

test('platform PORT is honoured when RADAR_PORT is absent', async () => {
  assert.equal((await loadConfig({ RADAR_PORT: undefined, PORT: '8080' })).port, 8080);
  // RADAR_PORT keeps precedence so an explicit choice is never overridden.
  assert.equal((await loadConfig({ RADAR_PORT: '4000', PORT: '8080' })).port, 4000);
  // The port bound is still range-checked for both sources.
  assert.equal((await loadConfig({ RADAR_PORT: undefined, PORT: '80' })).port, 3791);
});

test('state directory relocates onto an absolute volume path', async () => {
  const config = await loadConfig({ RADAR_STATE_DIR: '/data/radar' });
  assert.equal(config.stateDir, path.resolve('/data/radar'));
});

test('trusted hosts are parsed, lowercased and de-duplicated by the caller', async () => {
  const config = await loadConfig({ RADAR_TRUSTED_HOSTS: 'Radar.Example.com, radar.example.com ,, *.zeabur.app' });
  assert.deepEqual([...config.trustedHosts], ['radar.example.com', 'radar.example.com', '*.zeabur.app']);
});

test('a proxied request is accepted by trusted Host even from a remote address', () => {
  const cloud = { ...settings, trustedHosts: ['radar.example.com'] };
  assert.equal(isTrustedLocalRequest(request(), cloud), true);
  // A different Host on the same proxy is still rejected.
  assert.equal(isTrustedLocalRequest(request({ headers: { host: 'evil.example.com', origin: 'http://evil.example.com' } }), cloud), false);
  // Loopback defaults keep working alongside the cloud allowlist.
  assert.equal(isTrustedLocalRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3791', origin: 'http://127.0.0.1:3791', 'sec-fetch-site': 'same-origin' }
  }, cloud), true);
});

test('trusted Host does not relax Origin or Sec-Fetch-Site rules', () => {
  const cloud = { ...settings, trustedHosts: ['radar.example.com'] };
  assert.equal(isTrustedLocalRequest(request({ headers: { origin: 'http://evil.example.com' } }), cloud), false);
  assert.equal(isTrustedLocalRequest(request({ headers: { 'sec-fetch-site': 'cross-site' } }), cloud), false);
  // A TLS-terminating proxy makes the browser send an https Origin for the very
  // Host the operator trusted; scheme must not veto that, but the Host match
  // still decides. A foreign https Origin is still rejected.
  assert.equal(isTrustedLocalRequest(request({ headers: { origin: 'https://radar.example.com' } }), cloud), true);
  assert.equal(isTrustedLocalRequest(request({ headers: { origin: 'https://evil.example.com' } }), cloud), false);
  // A non-HTTP scheme is not an Origin at all.
  assert.equal(isTrustedLocalRequest(request({ headers: { origin: 'null' } }), cloud), false);
  assert.equal(isTrustedLocalRequest(request({ headers: { origin: 'ftp://radar.example.com' } }), cloud), false);
  // A missing Origin passes this gate exactly as it does on the desktop; the
  // requirement that /api/update-check and /api/update-install carry an
  // explicit Origin is enforced by those route handlers, not here, and the
  // patch does not touch it.
  assert.equal(isTrustedLocalRequest({ ...request(), method: 'POST', url: '/api/update-install',
    headers: { ...request().headers, origin: undefined } }, cloud), true);
});

test('without trusted hosts a remote proxy request is rejected', () => {
  assert.equal(isTrustedLocalRequest(request(), settings), false);
});

test('a loopback Host cannot be used by a remote peer to bypass the gate', () => {
  const cloud = { ...settings, trustedHosts: ['radar.example.com'] };
  // Host is client-controlled, so a remote socket must never satisfy the
  // desktop route through the loopback names alone. This mirrors the upstream
  // server.test.mjs expectation that a foreign remote address is rejected.
  assert.equal(isTrustedLocalRequest(request({ headers: { host: '127.0.0.1:3791',
    origin: 'http://127.0.0.1:3791' } }), cloud), false);
  assert.equal(isTrustedLocalRequest(request({ headers: { host: 'localhost:3791',
    origin: 'http://localhost:3791' } }), cloud), false);
});

test('a loopback peer may use a trusted Host, as a local proxy test does', () => {
  const cloud = { ...settings, trustedHosts: ['radar.example.com'] };
  // The desktop route still needs a loopback Host, but a loopback peer talking
  // to a trusted cloud Host is legitimate (local proxy, tunnel, curl -H).
  assert.equal(isTrustedLocalRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'radar.example.com', origin: 'http://radar.example.com', 'sec-fetch-site': 'same-origin' }
  }, cloud), true);
});

test('a trusted Host is not trusted from an unlisted remote peer substitution', () => {
  const cloud = { ...settings, trustedHosts: ['radar.example.com'] };
  // Suffix/prefix tricks against the allowlist must not match.
  for (const host of ['radar.example.com.evil.example', 'evilradar.example.com',
    'radar.example.com:9999', 'RADAR.EXAMPLE.COM:443']) {
    assert.equal(isTrustedLocalRequest(request({ headers: { host, origin: `http://${host}` } }), cloud), false, host);
  }
});
