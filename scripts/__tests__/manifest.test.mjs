import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, validateManifest } from '../lib/manifest.mjs';

const core = { url: 'https://github.com/x/y/releases/download/v1/core.zip', sha256: 'a'.repeat(64), size: 123 };
const subagents = { url: 'https://github.com/x/y/releases/download/v1/subagents.zip', sha256: 'b'.repeat(64), size: 456 };

test('builds and validates a manifest', () => {
  const m = buildManifest({ version: '1.0.0', platform: 'macos-x64', core, subagents: null });
  assert.deepEqual(validateManifest(m), []);
  assert.equal(m.platforms['macos-x64'].core.sha256, 'a'.repeat(64));
});

test('builds the fixed manifest identity and entry contract', () => {
  const m = buildManifest({ version: '1.0.0', platform: 'macos-x64', core, subagents: null });
  assert.equal(m.id, 'ai-coding');
  assert.equal(m.minAppVersion, '1.4.0');
  assert.deepEqual(m.entry, { port: 3080, tokenPattern: 'token=', readyTimeoutSecs: 300 });
  assert.equal('subagents' in m.platforms['macos-x64'], false);
});

test('includes an optional subagents artifact when supplied', () => {
  const m = buildManifest({ version: '1.0.0', platform: 'macos-x64', core, subagents });
  assert.deepEqual(validateManifest(m), []);
  assert.deepEqual(m.platforms['macos-x64'].subagents, { ...subagents, optional: true });
});

test('rejects non-https artifact urls', () => {
  const bad = { ...core, url: 'http://evil/core.zip' };
  const m = buildManifest({ version: '1.0.0', platform: 'macos-x64', core: bad, subagents: null });
  assert.ok(validateManifest(m).length > 0);
});

test('rejects malformed sha256', () => {
  const bad = { ...core, sha256: 'xyz' };
  const m = buildManifest({ version: '1.0.0', platform: 'macos-x64', core: bad, subagents: null });
  assert.ok(validateManifest(m).length > 0);
});

test('rejects non-positive artifact sizes', () => {
  const zero = buildManifest({ version: '1.0.0', platform: 'macos-x64', core: { ...core, size: 0 }, subagents: null });
  assert.ok(validateManifest(zero).length > 0);
  const negative = buildManifest({ version: '1.0.0', platform: 'macos-x64', core: { ...core, size: -1 }, subagents: null });
  assert.ok(validateManifest(negative).length > 0);
});

test('rejects a wrong manifest id', () => {
  const m = buildManifest({ version: '1.0.0', platform: 'macos-x64', core, subagents: null });
  m.id = 'other-plugin';
  assert.ok(validateManifest(m).some((error) => error.includes('id')));
});

test('rejects an empty version', () => {
  const m = buildManifest({ version: '', platform: 'macos-x64', core, subagents: null });
  assert.ok(validateManifest(m).some((error) => error.includes('version')));
});

test('rejects a platform without a core artifact', () => {
  const m = buildManifest({ version: '1.0.0', platform: 'macos-x64', core, subagents: null });
  delete m.platforms['macos-x64'].core;
  assert.ok(validateManifest(m).some((error) => error.includes('core')));
});

test('rejects a subagents artifact that is not marked optional', () => {
  const m = buildManifest({ version: '1.0.0', platform: 'macos-x64', core, subagents });
  delete m.platforms['macos-x64'].subagents.optional;
  assert.ok(validateManifest(m).some((error) => error.includes('optional')));
});

test('rejects a mutated runtime entry contract', () => {
  const m = buildManifest({ version: '1.0.0', platform: 'macos-x64', core, subagents: null });
  m.entry.port = 8080;
  assert.ok(validateManifest(m).some((error) => error.includes('entry.port')));
  m.entry.port = 3080;
  m.entry.tokenPattern = 'access_token=';
  assert.ok(validateManifest(m).some((error) => error.includes('tokenPattern')));
  m.entry.tokenPattern = 'token=';
  m.entry.readyTimeoutSecs = 30;
  assert.ok(validateManifest(m).some((error) => error.includes('readyTimeoutSecs')));
});

test('rejects non-object input', () => {
  assert.deepEqual(validateManifest(null), ['manifest must be an object']);
  assert.deepEqual(validateManifest([]), ['manifest must be an object']);
});
