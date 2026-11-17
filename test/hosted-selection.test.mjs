import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/shared/hosted-selection.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { chooseDubVideo, providerFamily, nextProvider } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const video = (id, durationMs, readyState = 4) => ({ id, durationMs, readyState, index: 0, label: id, source: 'blob:x', currentTimeMs: 0, paused: true, ended: false, playbackRate: 1, width: 0, height: 0 });
const candidate = (id, durationMs, loadedAt, frameKey = 'f', readyState) => ({ frameKey, loadedAt, video: video(id, durationMs, readyState) });

test('only videos loaded after Dub was selected count, so a late Sub load is never taken', () => {
  const sub = candidate('sub', 1_440_000, 100);
  const dub = candidate('dub', 1_450_000, 300);
  assert.equal(chooseDubVideo([sub], { since: 200, primaryDurationMs: 1_440_000 }), null);
  assert.equal(chooseDubVideo([sub, dub], { since: 200, primaryDurationMs: 1_440_000 }).video.id, 'dub');
});

test('ads, previews and unloaded players are not episodes', () => {
  const ad = candidate('ad', 30_000, 500);
  const empty = candidate('empty', null, 500);
  const notReady = candidate('loading', 1_440_000, 500, 'f', 0);
  assert.equal(chooseDubVideo([ad, empty, notReady], { since: 0, primaryDurationMs: null }), null);
});

test('the video closest to the Sub length wins; without it, the longest', () => {
  const recap = candidate('recap', 300_000, 500, 'a');
  const episode = candidate('episode', 1_470_000, 500, 'b');
  const movie = candidate('movie', 6_000_000, 500, 'c');
  assert.equal(chooseDubVideo([recap, episode, movie], { since: 0, primaryDurationMs: 1_440_000 }).video.id, 'episode');
  assert.equal(chooseDubVideo([recap, episode, movie], { since: 0, primaryDurationMs: null }).video.id, 'movie');
});

test('server families match across Sub and Dub labels', () => {
  assert.equal(providerFamily('alpha · embed · s-sub'), 'alpha');
  assert.equal(providerFamily('alpha · embed'), 'alpha');
  assert.equal(providerFamily('sigma · dl · h-sub'), 'sigma');
  assert.equal(providerFamily('Server 2 (HD)'), 'server');
  assert.equal(providerFamily(null), '');
});

test('the next server prefers the Sub family, then page order, never repeating', () => {
  const options = [
    { label: 'beta', selected: true }, { label: 'gamma · dl', selected: false },
    { label: 'theta', selected: false }, { label: 'alpha · embed', selected: false },
  ];
  assert.equal(nextProvider(options, new Set(['beta']), 'alpha'), 'alpha · embed');
  assert.equal(nextProvider(options, new Set(['beta', 'alpha · embed']), 'alpha'), 'gamma · dl');
  assert.equal(nextProvider(options, new Set(['beta', 'alpha · embed', 'gamma · dl', 'theta']), 'alpha'), null);
  assert.equal(nextProvider(options, new Set(['beta']), ''), 'gamma · dl');
});

test('a long ad is not an episode when the Sub length is known', () => {
  const ad = candidate('ad', 90_000, 500, 'a');
  assert.equal(chooseDubVideo([ad], { since: 0, primaryDurationMs: 1_440_000 }), null);
  const episode = candidate('episode', 1_500_000, 500, 'b');
  assert.equal(chooseDubVideo([ad, episode], { since: 0, primaryDurationMs: 1_440_000 }).video.id, 'episode');
});

test('recently failed servers are tried last, never first', () => {
  const options = [{ label: 'beta', selected: true }, { label: 'delta · s-sub', selected: false }, { label: 'gamma · dl', selected: false }];
  assert.equal(nextProvider(options, new Set(['beta']), 'delta', ['delta']), 'gamma · dl');
  assert.equal(nextProvider(options, new Set(['beta', 'gamma · dl']), 'delta', ['delta']), 'delta · s-sub', 'still tried when nothing else is left');
});
