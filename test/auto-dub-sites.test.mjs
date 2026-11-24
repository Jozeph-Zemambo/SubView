import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/shared/auto-dub-sites.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const sites = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('a site is its hostname without www, and only for web pages', () => {
  assert.equal(sites.siteKey('https://www.example.tv/watch/x?ep=1'), 'example.tv');
  assert.equal(sites.siteKey('https://video.example/watch'), 'video.example');
  assert.equal(sites.siteKey('chrome://extensions'), null);
  assert.equal(sites.siteKey(undefined), null);
});

test('stored settings are cleaned up rather than trusted', () => {
  const settings = sites.normalizeSiteSettings({ volume: 7, offsetMs: 'x', muteOriginal: false, failedServers: { beta: 5, bad: 'no' } });
  assert.equal(settings.volume, 1);
  assert.equal(settings.offsetMs, 0);
  assert.equal(settings.muteOriginal, false);
  assert.deepEqual(settings.failedServers, { beta: 5 });
});

test('a site saved before sites could be turned off stays on; only an explicit false is off', () => {
  assert.equal(sites.normalizeSiteSettings({ volume: 0.5, autoReload: true }).enabled, true);
  assert.equal(sites.normalizeSiteSettings({}).enabled, true);
  assert.equal(sites.normalizeSiteSettings({ enabled: false, volume: 0.5, lenientFrame: true }).enabled, false);
  const off = sites.normalizeSiteSettings({ enabled: false, volume: 0.5, lenientFrame: true, dubServer: 'alpha' });
  assert.equal(off.volume, 0.5, 'an off site keeps its settings');
  assert.equal(off.lenientFrame, true);
  assert.equal(off.dubServer, 'alpha');
  assert.equal(sites.DEFAULT_SITE_SETTINGS.enabled, true);
});

test('server memory: a working server is remembered and cleared from failures; a failed remembered one is forgotten', () => {
  let s = sites.normalizeSiteSettings({});
  s = sites.rememberFailedServer(s, 'alpha · embed', 1000);
  assert.deepEqual(sites.recentlyFailed(s, 2000), ['alpha']);
  s = sites.rememberWorkingServer(s, 'alpha · embed · s-sub');
  assert.equal(s.dubServer, 'alpha');
  assert.deepEqual(s.failedServers, {});
  s = sites.rememberFailedServer(s, 'alpha', 3000);
  assert.equal(s.dubServer, null);
  assert.deepEqual(sites.recentlyFailed(s, 3000 + sites.FAILED_SERVER_TTL_MS), [], 'failures expire after a day');
});
