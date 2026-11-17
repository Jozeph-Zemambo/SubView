import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/shared/dub-url.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { dubUrlFor, languageFromUrl } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('swaps a language query parameter or path segment', () => {
  assert.equal(dubUrlFor('https://a.test/watch/some-show?ep=1&lang=sub'), 'https://a.test/watch/some-show?ep=1&lang=dub');
  assert.equal(dubUrlFor('https://b.test/watch?id=21&ep=1&type=sub&provider=abc'), 'https://b.test/watch?id=21&ep=1&type=dub&provider=abc');
  assert.equal(dubUrlFor('https://x.test/stream/mal/21/1/sub'), 'https://x.test/stream/mal/21/1/dub');
  assert.equal(dubUrlFor('https://x.test/watch?audio=SUB'), 'https://x.test/watch?audio=DUB');
  assert.equal(dubUrlFor('https://x.test/watch?version=subbed'), 'https://x.test/watch?version=dubbed');
});

test('reads the language only when exactly one part of the address names it', () => {
  assert.equal(languageFromUrl('https://x.test/watch?lang=dub'), 'dub');
  assert.equal(languageFromUrl('https://x.test/watch?lang=sub&audio=dub'), null);
  assert.equal(languageFromUrl('https://x.test/subway/submarine?type=subscription'), null);
  assert.equal(languageFromUrl('https://x.test/ep-1-675ebf'), null);
  assert.equal(languageFromUrl('https://x.test/watch?campaign=dub'), null);
  assert.equal(dubUrlFor('https://x.test/watch?lang=sub&lang=auto'), null);
  assert.equal(dubUrlFor('https://x.test/watch?lang=dub'), null);
  assert.equal(dubUrlFor('chrome://extensions/?lang=sub'), null);
});
