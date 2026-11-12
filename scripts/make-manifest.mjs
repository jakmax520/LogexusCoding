#!/usr/bin/env node
/**
 * Generate `manifest.json` from release artifacts.
 *
 * Usage:
 *   node scripts/make-manifest.mjs --version=<version> --platform=<platform> \
 *     [--core=<path>] [--subagents=<path>] [--out=<path>] [--base-url=<url>]
 *   node scripts/make-manifest.mjs --version=<version> --artifacts=<dir> \
 *     [--out=<path>] [--base-url=<url>]
 *
 * The single-platform form defaults `--core` to `dist/core-<platform>.zip` and
 * includes `dist/subagents-<platform>.zip` when it exists. The `--artifacts`
 * form is used by the release job and requires every supported platform core package.
 */
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { buildManifest, validateManifest } from './lib/manifest.mjs';

const SUPPORTED_PLATFORMS = ['macos-x64', 'windows-x64', 'linux-x64'];
const DEFAULT_REPO = 'jakmax520/LogexusCoding';
const HASH_CHUNK_SIZE = 1024 * 1024;

class ManifestError extends Error {}

function log(message) {
  console.log(`[make-manifest] ${message}`);
}

function fail(message) {
  throw new ManifestError(message);
}

function usage() {
  console.error(
    'Usage: node scripts/make-manifest.mjs --version=<version> [options]\n'
    + '  --platform=<platform>   Single-platform mode (supported: '
    + `${SUPPORTED_PLATFORMS.join(', ')})\n`
    + '  --core=<path>           Core zip (default: dist/core-<platform>.zip)\n'
    + '  --subagents=<path>      Optional subagents zip\n'
    + '  --artifacts=<dir>       Multi-platform mode; scans core-/subagents- zips\n'
    + '  --base-url=<url>        Release download URL prefix\n'
    + '  --out=<path>            Output path (default: manifest.json)\n',
  );
}

/**
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
  const options = { help: false };
  const allowed = new Set(['version', 'platform', 'core', 'subagents', 'artifacts', 'base-url', 'out']);
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) fail(`unknown argument: ${arg}`);
    const separator = arg.indexOf('=');
    if (separator === -1) fail(`argument must use --name=value form: ${arg}`);
    const name = arg.slice(2, separator);
    const value = arg.slice(separator + 1);
    if (!allowed.has(name)) fail(`unknown option: --${name}`);
    if (value === '') fail(`--${name} requires a value`);
    options[name] = value;
  }
  return options;
}

/**
 * @param {string} path
 * @returns {string} Lowercase SHA-256 of the file contents.
 */
function sha256File(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_SIZE);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * @param {string} path
 * @param {string} baseUrl
 * @returns {{ url: string, sha256: string, size: number }}
 */
function artifactRef(path, baseUrl) {
  const absolute = resolve(process.cwd(), path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    fail(`artifact not found: ${path}`);
  }
  const size = statSync(absolute).size;
  if (size === 0) fail(`artifact is empty: ${path}`);
  return {
    url: `${baseUrl}/${basename(absolute)}`,
    sha256: sha256File(absolute),
    size,
  };
}

/**
 * @param {string} version
 * @returns {{ version: string, tag: string }}
 */
function normalizeVersion(version) {
  if (version.startsWith('v')) return { version: version.slice(1), tag: version };
  return { version, tag: `v${version}` };
}

/**
 * @param {string} directory
 * @returns {{ cores: Map<string, string>, subagents: Map<string, string> }}
 */
function scanArtifacts(directory) {
  const root = resolve(process.cwd(), directory);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    fail(`artifacts directory not found: ${directory}`);
  }
  const cores = new Map();
  const subagents = new Map();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const coreMatch = /^core-(.+)\.zip$/.exec(entry.name);
    const subagentsMatch = /^subagents-(.+)\.zip$/.exec(entry.name);
    const platform = coreMatch?.[1] ?? subagentsMatch?.[1];
    if (platform === undefined) continue;
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      fail(`unsupported platform in artifact name: ${entry.name}`);
    }
    const map = coreMatch === null ? subagents : cores;
    if (map.has(platform)) fail(`duplicate artifact for ${platform}: ${entry.name}`);
    map.set(platform, join(root, entry.name));
  }
  const missing = SUPPORTED_PLATFORMS.filter((platform) => !cores.has(platform));
  if (missing.length > 0) {
    fail(`missing core artifact(s) for: ${missing.join(', ')}`);
  }
  for (const platform of subagents.keys()) {
    if (!cores.has(platform)) fail(`subagents artifact without core artifact: ${platform}`);
  }
  return { cores, subagents };
}

/**
 * @param {Array<{ version: string, platform: string, core: object, subagents: object | null }>} entries
 * @returns {object}
 */
function assembleManifest(entries) {
  let manifest;
  for (const entry of entries) {
    const single = buildManifest(entry);
    if (manifest === undefined) manifest = single;
    else Object.assign(manifest.platforms, single.platforms);
  }
  return manifest;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (options.version === undefined) fail('missing --version=<version>');
  const { version, tag } = normalizeVersion(options.version);
  if (options.artifacts !== undefined) {
    if (options.platform !== undefined || options.core !== undefined || options.subagents !== undefined) {
      fail('--artifacts cannot be combined with --platform/--core/--subagents');
    }
  } else if (options.platform === undefined) {
    fail('missing --platform=<platform> (or use --artifacts=<dir>)');
  }
  if (options.platform !== undefined && !SUPPORTED_PLATFORMS.includes(options.platform)) {
    fail(`unsupported platform: ${options.platform} (supported: ${SUPPORTED_PLATFORMS.join(', ')})`);
  }

  const baseUrl = (options['base-url'] ?? `https://github.com/${DEFAULT_REPO}/releases/download/${tag}`)
    .replace(/\/+$/u, '');
  if (!baseUrl.startsWith('https://')) fail(`--base-url must use https://: ${baseUrl}`);

  let entries;
  if (options.artifacts !== undefined) {
    const { cores, subagents } = scanArtifacts(options.artifacts);
    entries = SUPPORTED_PLATFORMS.map((platform) => ({
      version,
      platform,
      core: artifactRef(cores.get(platform), baseUrl),
      subagents: subagents.has(platform) ? artifactRef(subagents.get(platform), baseUrl) : null,
    }));
  } else {
    const platform = options.platform;
    const corePath = options.core ?? join('dist', `core-${platform}.zip`);
    const defaultSubagents = join('dist', `subagents-${platform}.zip`);
    const subagentsPath = options.subagents
      ?? (existsSync(resolve(process.cwd(), defaultSubagents)) ? defaultSubagents : undefined);
    entries = [{
      version,
      platform,
      core: artifactRef(corePath, baseUrl),
      subagents: subagentsPath === undefined ? null : artifactRef(subagentsPath, baseUrl),
    }];
  }

  const manifest = assembleManifest(entries);
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    for (const error of errors) console.error(`[make-manifest] INVALID: ${error}`);
    process.exit(1);
  }

  const out = resolve(process.cwd(), options.out ?? 'manifest.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`wrote ${out} (version=${version}, platforms=${Object.keys(manifest.platforms).join(', ')})`);
}

try {
  main();
} catch (error) {
  if (error instanceof ManifestError) {
    console.error(`[make-manifest] ERROR: ${error.message}`);
    usage();
    process.exit(1);
  }
  console.error(`[make-manifest] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
