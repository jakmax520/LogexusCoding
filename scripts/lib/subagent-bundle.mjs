/**
 * Purity-friendly helpers for the optional subagent bundle.
 *
 * The optional package set is owned by `lib/package-rules.mjs`; deriving the
 * required roots from it keeps the bundler and the core pruning in sync.
 */
import { OPTIONAL_SUBAGENT_PATTERNS } from './package-rules.mjs';

/**
 * Exact package names (patterns without a wildcard) that must be bundled.
 * @type {ReadonlyArray<string>}
 */
export const REQUIRED_SUBAGENT_ROOTS = Object.freeze(
  OPTIONAL_SUBAGENT_PATTERNS.filter((pattern) => !pattern.endsWith('*')),
);

/**
 * Host-native package suffixes used by both vendor SDKs.
 * @type {Readonly<Record<string, string>>}
 */
export const NATIVE_PLATFORM_SUFFIXES = Object.freeze({
  'macos-x64': 'darwin-x64',
  'macos-arm64': 'darwin-arm64',
  'windows-x64': 'win32-x64',
  'linux-x64': 'linux-x64',
});

/**
 * @param {string} root Package name, e.g. `@openai/codex`.
 * @param {string} platform Release platform, e.g. `macos-x64`.
 * @returns {string | undefined} Host-native package name, e.g. `@openai/codex-darwin-x64`.
 */
export function nativePackageName(root, platform) {
  const suffix = NATIVE_PLATFORM_SUFFIXES[platform];
  if (suffix === undefined) return undefined;
  return `${root}-${suffix}`;
}

/**
 * A bundle without the host-native package starts but cannot spawn the agent.
 * @param {Iterable<string>} packageKeys Names present in the resolved closure.
 * @param {Iterable<string>} roots Required wrapper package names.
 * @param {string} platform Release platform.
 * @returns {string[]} Missing native package names; empty means complete.
 */
export function missingNativePackages(packageKeys, roots, platform) {
  const present = new Set(packageKeys);
  const missing = [];
  for (const root of roots) {
    const native = nativePackageName(root, platform);
    if (native === undefined) {
      missing.push(`${root} (no native label for ${platform})`);
    } else if (!present.has(native)) {
      missing.push(native);
    }
  }
  return missing;
}
