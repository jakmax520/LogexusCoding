export const EXCLUDED_PATTERNS = [
  'typescript', 'rolldown', '@rolldown/binding-*', 'oxlint', 'oxlint-tsgolint',
  'vitest', '@vitest/coverage-v8', 'tsdown', 'tsx', 'mermaid',
  '@mermaid-js/mermaid-mindmap', 'vite-tsconfig-paths', 'publint', 'knip', 'jscpd',
];
export const OPTIONAL_SUBAGENT_PATTERNS = [
  '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk-*',
  '@openai/codex', '@openai/codex-*',
];
function matches(name, patterns) {
  return patterns.some((p) => p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p);
}
export function shouldExclude(name) { return matches(name, EXCLUDED_PATTERNS); }
export function isOptionalSubagent(name) { return matches(name, OPTIONAL_SUBAGENT_PATTERNS); }
