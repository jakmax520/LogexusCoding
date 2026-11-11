#!/usr/bin/env node
/**
 * Build the optional subagent overlay bundle.
 *
 * The core runtime prunes `@anthropic-ai/claude-agent-sdk*` and `@openai/codex*`
 * (see lib/package-rules.mjs). This script repackages those packages, the
 * host-matching native binaries and their declared runtime dependencies into
 * `dist/subagents-<platform>.zip`. The archive is an overlay: extracting it in
 * the installed runtime root merges its `node_modules` into the core tree.
 *
 * The dependency tree is read from the workspace install performed by
 * `build-core.mjs`/`pnpm install`; this script never downloads packages.
 * Peer dependencies (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod`)
 * stay in the core package and are intentionally not duplicated here.
 *
 * Usage: node scripts/build-subagents.mjs --platform=<platform> [--out=<path>]
 */
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createZip, listZipEntries } from './lib/archive.mjs';
import { hostPlatform, platformMismatchMessage, SUPPORTED_PLATFORMS } from './lib/platform.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_DIR = join(REPO_ROOT, 'coding-harness');
const REQUIRED_ROOTS = ['@anthropic-ai/claude-agent-sdk', '@openai/codex'];
// The upstream provider packages declare the vendor SDK dependencies.
const PROVIDER_PACKAGES = [
  { name: 'subagent-claude-code', roots: ['@anthropic-ai/claude-agent-sdk'] },
  { name: 'subagent-codex', roots: ['@openai/codex'] },
];

class BundleError extends Error {}

function log(message) {
  console.log(`[build-subagents] ${message}`);
}

function fail(message) {
  throw new BundleError(message);
}

function parseArgs(argv) {
  const options = { platform: undefined, out: undefined };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/build-subagents.mjs --platform=<platform> [--out=<path>]');
      process.exit(0);
    }
    if (arg.startsWith('--platform=')) options.platform = arg.slice('--platform='.length);
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else fail(`unknown argument: ${arg}`);
  }
  if (options.platform === undefined) {
    fail(`missing --platform=<platform> (supported: ${SUPPORTED_PLATFORMS.join(', ')})`);
  }
  if (!SUPPORTED_PLATFORMS.includes(options.platform)) {
    fail(`unsupported platform: ${options.platform} (supported: ${SUPPORTED_PLATFORMS.join(', ')})`);
  }
  options.out = resolve(process.cwd(), options.out ?? join('dist', `subagents-${options.platform}.zip`));
  return options;
}

/** Fail when `--platform` only relabels a host-native dependency tree. */
function assertHostPlatform(platform) {
  const host = hostPlatform();
  if (host !== platform) fail(platformMismatchMessage(platform, host));
}

/**
 * Resolve a package using Node's lookup, returning its real directory.
 * @param {string} fromDir
 * @param {string} name
 * @returns {string | undefined}
 */
function resolvePackageDir(fromDir, name) {
  let directory = fromDir;
  for (;;) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * @param {string} directory
 * @returns {object}
 */
function readPackageManifest(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read ${join(directory, 'package.json')}: ${detail}`);
  }
}

/**
 * Walk declared runtime dependencies from the provider roots.
 *
 * Node module resolution is used, and optional dependencies are included only
 * when installed (pnpm installs the host-matching native package). Destinations
 * are keyed by the dependency specifier so npm aliases such as
 * `@openai/codex-darwin-x64 -> @openai/codex@0.149.1-darwin-x64` keep their
 * expected directory name.
 *
 * @returns {Map<string, { dir: string, version: string }>}
 */
function collectClosure() {
  const packages = new Map();
  const queue = [];
  for (const provider of PROVIDER_PACKAGES) {
    const providerDir = join(SOURCE_DIR, 'packages/subagent', provider.name);
    if (!existsSync(join(providerDir, 'package.json'))) {
      fail(`subagent provider not found: ${providerDir}`);
    }
    for (const root of provider.roots) {
      const dir = resolvePackageDir(providerDir, root);
      if (dir === undefined) {
        fail(
          `missing subagent dependency ${root}; run "corepack pnpm install --frozen-lockfile" `
          + 'in coding-harness/ (or run build-core.mjs first) and retry',
        );
      }
      queue.push({ key: root, dir });
    }
  }

  while (queue.length > 0) {
    const { key, dir } = queue.shift();
    if (packages.has(key)) {
      if (packages.get(key).dir !== dir) {
        fail(`conflicting installs for ${key}: ${packages.get(key).dir} vs ${dir}`);
      }
      continue;
    }
    const manifest = readPackageManifest(dir);
    packages.set(key, { dir, version: manifest.version ?? 'unknown' });

    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      // Workspace packages and peers are shipped by the core runtime.
      if (dependency.startsWith('@deepseek-ai/')) continue;
      const dependencyDir = resolvePackageDir(dir, dependency);
      if (dependencyDir === undefined) {
        fail(`unresolved runtime dependency ${dependency} of ${key}`);
      }
      queue.push({ key: dependency, dir: dependencyDir });
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      if (dependency.startsWith('@deepseek-ai/')) continue;
      const dependencyDir = resolvePackageDir(dir, dependency);
      if (dependencyDir !== undefined) queue.push({ key: dependency, dir: dependencyDir });
    }
  }
  return packages;
}

/**
 * Copy the closure into a hoisted `node_modules` staging tree.
 * @param {Map<string, { dir: string }>} packages
 * @param {string} staging
 */
function stageBundle(packages, staging) {
  for (const [key, { dir }] of packages) {
    const destination = join(staging, 'node_modules', key);
    mkdirSync(dirname(destination), { recursive: true });
    // Flattened dependencies: nested node_modules and bin shims are not needed
    // and may contain links back into the workspace install.
    cpSync(dir, destination, {
      recursive: true,
      dereference: true,
      filter: (source) => basename(source) !== 'node_modules',
    });
  }
}

function filesize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertHostPlatform(options.platform);

  log(`platform=${options.platform} out=${options.out}`);
  log('step 1/4: resolve optional subagent packages');
  const packages = collectClosure();
  for (const root of REQUIRED_ROOTS) {
    if (!packages.has(root)) fail(`required package missing from bundle closure: ${root}`);
  }
  log(`resolved ${packages.size} package(s): ${[...packages.keys()].sort().join(', ')}`);

  const staging = mkdtempSync(join(tmpdir(), 'logexus-subagents-'));
  try {
    log('step 2/4: stage hoisted node_modules tree');
    stageBundle(packages, staging);
    for (const root of REQUIRED_ROOTS) {
      if (!existsSync(join(staging, 'node_modules', root, 'package.json'))) {
        fail(`staged bundle is missing ${root}/package.json`);
      }
    }

    log('step 3/4: create zip');
    mkdirSync(dirname(options.out), { recursive: true });
    rmSync(options.out, { force: true });
    createZip(staging, options.out);

    log('step 4/4: verify zip contents');
    const entries = new Set(listZipEntries(options.out));
    for (const root of REQUIRED_ROOTS) {
      const expected = `node_modules/${root}/package.json`;
      if (!entries.has(expected)) fail(`zip does not contain ${expected}`);
    }

    const size = statSync(options.out).size;
    log(`done: ${options.out} (${filesize(size)}, ${packages.size} package(s))`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  if (error instanceof BundleError) {
    console.error(`[build-subagents] ERROR: ${error.message}`);
    process.exit(1);
  }
  console.error(`[build-subagents] ERROR: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
}
