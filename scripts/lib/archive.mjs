/**
 * Cross-platform zip creation and listing.
 *
 * POSIX release runners have Info-ZIP. The GitHub Windows runner does not ship
 * `zip`, so fall back to 7-Zip or the bundled bsdtar (`tar -a -c -f`). Both
 * store relative paths, which is what the extractors expect.
 */
import { execFileSync } from 'node:child_process';

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run a tool, returning `undefined` only when the executable is missing.
 * Real failures propagate so they are not silently masked by a fallback.
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileSyncOptionsWithStringEncoding} options
 * @returns {string | undefined}
 */
function run(command, args, options) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, ...options });
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Zip everything under `sourceDir` (including dotfiles) into `outPath`.
 * @param {string} sourceDir Absolute path to the directory to archive.
 * @param {string} outPath Absolute path to the zip file to create.
 */
export function createZip(sourceDir, outPath) {
  if (process.platform !== 'win32') {
    const result = run('zip', ['-q', '-r', outPath, '.'], { cwd: sourceDir, stdio: 'ignore' });
    if (result === undefined) {
      throw new Error('zip not found on PATH; install the zip utility and retry');
    }
    return;
  }

  const via7z = run('7z', ['a', '-tzip', outPath, '.'], { cwd: sourceDir, stdio: 'ignore' });
  if (via7z !== undefined) return;

  const viaTar = run('tar', ['-a', '-c', '-f', outPath, '.'], { cwd: sourceDir, stdio: 'ignore' });
  if (viaTar !== undefined) return;

  throw new Error(
    'cannot create a zip on Windows: neither 7z nor tar is on PATH. '
    + 'Install 7-Zip or bsdtar (tar.exe) and retry.',
  );
}

/**
 * List archive entries, normalized to POSIX-style relative paths.
 * @param {string} zipPath
 * @returns {string[]}
 */
export function listZipEntries(zipPath) {
  if (process.platform !== 'win32') {
    const output = run('unzip', ['-Z1', zipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (output === undefined) {
      throw new Error('unzip not found on PATH; install unzip and retry');
    }
    return normalizeEntries(output);
  }

  const viaTar = run('tar', ['-tf', zipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (viaTar !== undefined) return normalizeEntries(viaTar);

  const via7z = run('7z', ['l', '-ba', zipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (via7z !== undefined) {
    const names = via7z
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => line.split(/\s+/u).at(-1) ?? '');
    return normalizeEntries(names.join('\n'));
  }

  throw new Error('cannot list a zip on Windows: neither tar nor 7z is on PATH');
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function normalizeEntries(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim().replaceAll('\\', '/'))
    .filter((line) => line !== '' && !line.endsWith('/'))
    .map((line) => (line.startsWith('./') ? line.slice(2) : line));
}
