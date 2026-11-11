/**
 * Pure manifest helpers for the AI Coding plugin distribution.
 *
 * The manifest is the only remote input the host application trusts, so it may
 * only describe artifact URLs, checksums, sizes and versions. Executable
 * commands, arguments and cwd stay hardcoded in the host (spec §5.1).
 */

export const MANIFEST_ID = 'ai-coding';
export const MIN_APP_VERSION = '1.4.0';
export const MANIFEST_ENTRY = Object.freeze({
  port: 3080,
  tokenPattern: 'token=',
  readyTimeoutSecs: 300,
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const URL_PREFIX = 'https://';

/**
 * Assemble a single-platform manifest.
 * @param {{
 *   version: string,
 *   platform: string,
 *   core: { url: string, sha256: string, size: number },
 *   subagents: { url: string, sha256: string, size: number } | null,
 * }} input
 * @returns {object}
 */
export function buildManifest({ version, platform, core, subagents }) {
  const platformEntry = { core: { ...core } };
  if (subagents !== null && subagents !== undefined) {
    platformEntry.subagents = { ...subagents, optional: true };
  }
  return {
    id: MANIFEST_ID,
    version,
    minAppVersion: MIN_APP_VERSION,
    platforms: { [platform]: platformEntry },
    entry: { ...MANIFEST_ENTRY },
  };
}

/**
 * Validate a manifest against the spec §5.1 contract.
 * @param {unknown} manifest
 * @returns {string[]} Validation errors; an empty array means valid.
 */
export function validateManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest must be an object'];
  }

  const errors = [];
  if (manifest.id !== MANIFEST_ID) errors.push(`id must be "${MANIFEST_ID}"`);
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    errors.push('version must be a non-empty string');
  }
  if (typeof manifest.minAppVersion !== 'string' || manifest.minAppVersion.trim() === '') {
    errors.push('minAppVersion must be a non-empty string');
  }

  const platforms = manifest.platforms;
  if (platforms === null || typeof platforms !== 'object' || Array.isArray(platforms)) {
    errors.push('platforms must be an object');
  } else {
    const names = Object.keys(platforms);
    if (names.length === 0) errors.push('platforms must declare at least one platform');
    for (const name of names) {
      validatePlatform(errors, name, platforms[name]);
    }
  }

  validateEntry(errors, manifest.entry);
  return errors;
}

function validatePlatform(errors, name, platform) {
  const path = `platforms.${name}`;
  if (platform === null || typeof platform !== 'object' || Array.isArray(platform)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateArtifact(errors, `${path}.core`, platform.core);
  if (platform.subagents !== undefined) {
    validateArtifact(errors, `${path}.subagents`, platform.subagents);
    if (platform.subagents?.optional !== true) {
      errors.push(`${path}.subagents.optional must be true`);
    }
  }
}

function validateArtifact(errors, path, artifact) {
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (typeof artifact.url !== 'string' || !artifact.url.startsWith(URL_PREFIX)) {
    errors.push(`${path}.url must start with ${URL_PREFIX}`);
  }
  if (typeof artifact.sha256 !== 'string' || !SHA256_PATTERN.test(artifact.sha256)) {
    errors.push(`${path}.sha256 must be 64 lowercase hex characters`);
  }
  if (!Number.isInteger(artifact.size) || artifact.size <= 0) {
    errors.push(`${path}.size must be a positive integer`);
  }
}

function validateEntry(errors, entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push('entry must be an object');
    return;
  }
  if (entry.port !== MANIFEST_ENTRY.port) {
    errors.push(`entry.port must be ${MANIFEST_ENTRY.port}`);
  }
  if (entry.tokenPattern !== MANIFEST_ENTRY.tokenPattern) {
    errors.push(`entry.tokenPattern must be "${MANIFEST_ENTRY.tokenPattern}"`);
  }
  if (entry.readyTimeoutSecs !== MANIFEST_ENTRY.readyTimeoutSecs) {
    errors.push(`entry.readyTimeoutSecs must be ${MANIFEST_ENTRY.readyTimeoutSecs}`);
  }
}
