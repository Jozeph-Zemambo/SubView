import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/shared/update.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { RELEASES_PAGE, isNewer, noticeFor, parseVersion } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('reads release tags and manifest versions, and nothing else', () => {
  assert.deepEqual(parseVersion('v0.2.0'), [0, 2, 0]);
  assert.deepEqual(parseVersion('1.10'), [1, 10]);
  assert.equal(parseVersion('v1.0.0-beta'), null);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(12), null);
});

test('compares versions by number, not as text', () => {
  assert.equal(isNewer('v0.1.1', '0.1.0'), true);
  assert.equal(isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(isNewer('v1.0', '0.9.9'), true);
  assert.equal(isNewer('v0.1.0', '0.1.0'), false);
  assert.equal(isNewer('v0.1', '0.1.0'), false);
  assert.equal(isNewer('v0.0.9', '0.1.0'), false);
  assert.equal(isNewer('nonsense', '0.1.0'), false);
  assert.equal(isNewer('v9.9.9', 'nonsense'), false);
});

test('offers only a newer release, and only links to this project', () => {
  const url = `${RELEASES_PAGE}/tag/v0.2.0`;
  assert.deepEqual(noticeFor({ version: 'v0.2.0', url }, '0.1.0'), { version: '0.2.0', url });
  assert.equal(noticeFor({ version: 'v0.1.0', url }, '0.1.0'), null);
  assert.equal(noticeFor({ version: null, url }, '0.1.0'), null);
  assert.equal(noticeFor(null, '0.1.0'), null);
  assert.deepEqual(noticeFor({ version: 'v0.2.0', url: 'https://evil.test/x' }, '0.1.0'), { version: '0.2.0', url: RELEASES_PAGE });
  assert.deepEqual(noticeFor({ version: 'v0.2.0', url: `${RELEASES_PAGE}.evil.test/x` }, '0.1.0'), { version: '0.2.0', url: RELEASES_PAGE });
});
