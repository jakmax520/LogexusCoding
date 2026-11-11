import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldExclude, isOptionalSubagent } from '../lib/package-rules.mjs';

test('excludes build-time packages', () => {
  assert.equal(shouldExclude('typescript'), true);
  assert.equal(shouldExclude('@rolldown/binding-darwin-x64'), true);
  assert.equal(shouldExclude('mermaid'), true);
});

test('keeps runtime packages', () => {
  assert.equal(shouldExclude('node-pty'), false);
  assert.equal(shouldExclude('sharp'), false);
  assert.equal(shouldExclude('@deepseek-ai/dsh-core'), false);
});

test('classifies optional subagents', () => {
  assert.equal(isOptionalSubagent('@anthropic-ai/claude-agent-sdk'), true);
  assert.equal(isOptionalSubagent('@openai/codex'), true);
  assert.equal(isOptionalSubagent('@anthropic-ai/claude-agent-sdk-darwin-x64'), true);
  assert.equal(isOptionalSubagent('node-pty'), false);
});
