/**
 * Host platform detection for release builds.
 *
 * The runtime packages are host-native: pnpm installs platform-specific
 * optional dependencies and binaries for the machine that runs the build. The
 * `--platform` flag only labels an artifact, so it must match the host unless a
 * real cross-build pipeline exists (it does not).
 */

export const SUPPORTED_PLATFORMS = Object.freeze([
  'macos-x64',
  'macos-arm64',
  'windows-x64',
  'linux-x64',
]);

/**
 * @returns {string | undefined} The supported platform of this host, or
 * `undefined` when the host OS/arch is not a supported release target.
 */
export function hostPlatform() {
  if (process.platform === 'darwin') {
    if (process.arch === 'x64') return 'macos-x64';
    if (process.arch === 'arm64') return 'macos-arm64';
  } else if (process.platform === 'win32') {
    if (process.arch === 'x64') return 'windows-x64';
  } else if (process.platform === 'linux') {
    if (process.arch === 'x64') return 'linux-x64';
  }
  return undefined;
}

/**
 * Format the error used when `--platform` does not match the build host.
 * @param {string} requested
 * @param {string | undefined} host
 * @returns {string}
 */
export function platformMismatchMessage(requested, host) {
  if (host === undefined) {
    return `unsupported build host ${process.platform}/${process.arch}; `
      + `supported platforms: ${SUPPORTED_PLATFORMS.join(', ')}`;
  }
  return `--platform=${requested} does not match the build host (${host}); `
    + 'these packages are host-native and cross-building is not supported. '
    + 'Run this command on the target platform instead.';
}
