import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_PLATFORM_SUFFIXES,
  REQUIRED_SUBAGENT_ROOTS,
  missingNativePackages,
  nativePackageName,
} from '../lib/subagent-bundle.mjs';

const ROOTS = [...REQUIRED_SUBAGENT_ROOTS];
const COMPLETE = [...ROOTS, '@anthropic-ai/claude-agent-sdk-darwin-x64', '@openai/codex-darwin-x64'];

test('derives the required roots from the optional package patterns', () => {
  assert.deepEqual(ROOTS, ['@anthropic-ai/claude-agent-sdk', '@openai/codex']);
});

test('maps every release platform to its native package suffix', () => {
  assert.deepEqual({ ...NATIVE_PLATFORM_SUFFIXES }, {
    'macos-x64': 'darwin-x64',
    'macos-arm64': 'darwin-arm64',
    'windows-x64': 'win32-x64',
    'linux-x64': 'linux-x64',
  });
  assert.equal(
    nativePackageName('@anthropic-ai/claude-agent-sdk', 'macos-arm64'),
    '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  );
  assert.equal(nativePackageName('@openai/codex', 'windows-x64'), '@openai/codex-win32-x64');
  assert.equal(nativePackageName('@openai/codex', 'freebsd-x64'), undefined);
});

test('accepts a closure with every host-native package', () => {
  assert.deepEqual(missingNativePackages(COMPLETE, ROOTS, 'macos-x64'), []);
  assert.deepEqual(missingNativePackages(new Set(COMPLETE), ROOTS, 'macos-x64'), []);
});

test('names a missing wrapper native package', () => {
  assert.deepEqual(
    missingNativePackages(
      ['@anthropic-ai/claude-agent-sdk', '@openai/codex', '@openai/codex-darwin-x64'],
      ROOTS,
      'macos-x64',
    ),
    ['@anthropic-ai/claude-agent-sdk-darwin-x64'],
  );
});

test('names both native packages when the closure only has wrappers', () => {
  assert.deepEqual(missingNativePackages(ROOTS, ROOTS, 'linux-x64'), [
    '@anthropic-ai/claude-agent-sdk-linux-x64',
    '@openai/codex-linux-x64',
  ]);
});

test('treats an unknown platform as unverifiable', () => {
  const missing = missingNativePackages(COMPLETE, ROOTS, 'freebsd-x64');
  assert.equal(missing.length, ROOTS.length);
  assert.ok(missing.every((entry) => entry.includes('freebsd-x64')));
});
