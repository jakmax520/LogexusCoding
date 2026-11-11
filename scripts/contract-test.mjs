#!/usr/bin/env node
/**
 * Boot contract test for the pruned, self-contained AI Coding runtime package.
 *
 * The package must boot from an arbitrary directory with:
 *
 *     node apps/cli/lib/bin.js web --no-open
 *
 * print the `dsh web: http://127.0.0.1:3080/?token=<token>` readiness line,
 * serve HTTP 200 for the authenticated root URL, and shut down without leaving
 * an orphan listener behind.
 *
 * Usage:
 *   node scripts/contract-test.mjs --dir=<extracted-dir>
 *   node scripts/contract-test.mjs --zip=<core-*.zip> [--timeout=<seconds>]
 *
 * Exit codes:
 *   0  runtime booted, token observed, HTTP 200 served, clean shutdown
 *   2  Node missing or outside the upstream range (^22.19.0 || >=24.0.0)
 *   3  occupied port, boot timeout, crash, HTTP failure, or leaked listener
 *   1  usage / I/O error
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXIT_READY = 0
export const EXIT_USAGE = 1
export const EXIT_NODE = 2
export const EXIT_FAILURE = 3

export const CONTRACT_PORT = 3080
export const DEFAULT_TIMEOUT_SECONDS = 300
const MIN_TOKEN_LENGTH = 16
const TOKEN_PATTERN = /token=([A-Za-z0-9_-]+)/u
const LOG_TAIL_LINES = 40
const OUTPUT_BUFFER_LIMIT = 100_000
const SHUTDOWN_GRACE_MS = 10_000
const PORT_RELEASE_TIMEOUT_MS = 5_000
const HEALTH_TIMEOUT_MS = 15_000

/**
 * Extract the launch token from one output line.
 * @param {string} line - stdout (or assembled) text possibly containing `token=`.
 * @returns {string | null} Token when it is at least 16 `[A-Za-z0-9_-]` chars.
 */
export function parseToken(line) {
  if (typeof line !== 'string') return null
  const match = TOKEN_PATTERN.exec(line)
  if (match === null) return null
  return match[1].length >= MIN_TOKEN_LENGTH ? match[1] : null
}

/**
 * Check a Node version against the upstream `^22.19.0 || >=24.0.0` range.
 * @param {string} version - e.g. `v22.19.0`, `22.19.0` or `v24.1.0`.
 * @returns {boolean} Whether the version satisfies the range.
 */
export function checkNodeVersion(version) {
  if (typeof version !== 'string') return false
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(version)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major === 22) return minor >= 19
  return major >= 24
}

function log(message) {
  console.log(`[contract-test] ${message}`)
}

function logError(message) {
  console.error(`[contract-test] ${message}`)
}

function usage() {
  console.error(
    'Usage: node scripts/contract-test.mjs --dir=<extracted-dir>\n'
    + '       node scripts/contract-test.mjs --zip=<core-*.zip> [--timeout=<seconds>]',
  )
}

/**
 * @param {string[]} argv
 * @returns {{ dir?: string, zip?: string, timeoutSeconds: number, help: boolean }}
 */
export function parseArgs(argv) {
  const options = { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--dir=')) options.dir = arg.slice('--dir='.length)
    else if (arg.startsWith('--zip=')) options.zip = arg.slice('--zip='.length)
    else if (arg.startsWith('--timeout=')) {
      const seconds = Number(arg.slice('--timeout='.length))
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`invalid --timeout: ${arg}`)
      options.timeoutSeconds = seconds
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/**
 * Reserve the port once to prove it is free, then release it for the child.
 * @param {number} port
 * @returns {Promise<boolean>} True when nobody was listening.
 */
function isPortFree(port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolvePromise(false)
      else reject(error)
    })
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close((error) => {
        if (error === undefined) resolvePromise(true)
        else reject(error)
      })
    })
  })
}

/**
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} True once the port is no longer listening.
 */
async function waitForPortRelease(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await isPortFree(port)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
}

/**
 * Extract a zip archive into `destination` using the platform's system tool.
 * @param {string} zipPath
 * @param {string} destination
 */
function extractZip(zipPath, destination) {
  if (process.platform === 'win32') {
    execFileSync('tar', ['-xf', zipPath, '-C', destination], { stdio: 'ignore' })
  } else {
    execFileSync('unzip', ['-q', zipPath, '-d', destination], { stdio: 'ignore' })
  }
}

/**
 * Spawn the packaged CLI in its own process group so the whole tree can be
 * signalled at once (the CLI may start worker children).
 * @param {string} runtimeDir
 * @param {string} stdoutPath
 * @param {string} stderrPath
 */
function startRuntime(runtimeDir, stdoutPath, stderrPath) {
  const stdoutFd = openSync(stdoutPath, 'a')
  const stderrFd = openSync(stderrPath, 'a')
  const child = spawn(
    process.execPath,
    ['apps/cli/lib/bin.js', 'web', '--no-open'],
    {
      cwd: runtimeDir,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    },
  )
  child.stdout.on('data', (chunk) => {
    writeSync(stdoutFd, chunk)
  })
  child.stderr.on('data', (chunk) => {
    writeSync(stderrFd, chunk)
  })
  return {
    child,
    closeFiles() {
      closeSync(stdoutFd)
      closeSync(stderrFd)
    },
  }
}

/**
 * Wait for the readiness line on stdout, failing fast when the child exits.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @param {() => string} output
 * @returns {Promise<{ token: string, line: string, elapsedMs: number }>}
 */
function waitForToken(child, timeoutMs, output) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now()
    let settled = false
    let timer
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      if (error === undefined) resolvePromise(value)
      else reject(error)
    }
    const check = () => {
      const text = output()
      const match = /dsh web: (http:\/\/\S+)/u.exec(text)
      const token = match === null ? null : parseToken(match[1])
      if (token !== null) {
        finish(undefined, { token, line: match[1], elapsedMs: Date.now() - startedAt })
      }
    }
    const onExit = (code, signal) => {
      finish(new Error(
        `runtime exited before printing the readiness token (code=${String(code)}, signal=${String(signal)})`,
      ))
    }
    timer = setTimeout(() => {
      finish(new Error(`timed out after ${String(timeoutMs)}ms waiting for the readiness token`))
    }, timeoutMs)
    child.on('exit', onExit)
    child.once('error', (error) => {
      finish(new Error(`failed to spawn the runtime: ${error.message}`))
    })
    child.stdout.on('data', check)
    check()
  })
}

/**
 * Fetch the authenticated root URL. The web app answers 401 for `/` without a
 * session by design, so follow the browser flow: exchange the token for the
 * session cookie (303) and then request `/` with that cookie.
 * @param {number} port
 * @param {string} token
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, status: number, detail: string }>}
 */
async function checkHealth(port, token, timeoutMs) {
  const origin = `http://127.0.0.1:${String(port)}`
  const deadline = Date.now() + timeoutMs
  let lastDetail = 'no response'
  for (;;) {
    try {
      return await checkHealthOnce(origin, token)
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error)
    }
    if (Date.now() >= deadline) {
      return { ok: false, status: 0, detail: `health check timed out: ${lastDetail}` }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
}

/**
 * @param {string} origin
 * @param {string} token
 * @returns {Promise<{ ok: boolean, status: number, detail: string }>}
 */
async function checkHealthOnce(origin, token) {
  const signal = AbortSignal.timeout(5_000)
  const root = await fetch(`${origin}/`, { redirect: 'manual', signal })
  await root.text()
  if (root.status === 200) return { ok: true, status: 200, detail: 'root served without a session' }

  const login = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', signal })
  await login.text()
  if (login.status !== 303) {
    return { ok: false, status: login.status, detail: `token exchange returned ${String(login.status)}, expected 303` }
  }
  const setCookie = login.headers.getSetCookie?.() ?? []
  const cookie = setCookie[0]?.split(';')[0] ?? login.headers.get('set-cookie')?.split(';')[0]
  if (cookie === undefined || !cookie.includes('=')) {
    return { ok: false, status: login.status, detail: 'token exchange did not set a session cookie' }
  }
  const authed = await fetch(`${origin}/`, { redirect: 'manual', headers: { cookie }, signal })
  await authed.text()
  if (authed.status !== 200) {
    return { ok: false, status: authed.status, detail: `authenticated GET / returned ${String(authed.status)}, expected 200` }
  }
  return { ok: true, status: 200, detail: 'authenticated GET / served 200' }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} True when the child exited.
 */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolvePromise(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolvePromise(true)
    }
    child.once('exit', onExit)
  })
}

/**
 * Terminate the child and every process in its group/tree.
 * @param {import('node:child_process').ChildProcess} child
 */
async function terminate(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') {
        try {
          child.kill('SIGTERM')
        } catch {
          // The child is already gone.
        }
      }
    }
  }
  if (await waitForExit(child, SHUTDOWN_GRACE_MS)) return
  logError(`runtime did not exit within ${String(SHUTDOWN_GRACE_MS)}ms; sending SIGKILL`)
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // The group is already gone.
    }
  }
  await waitForExit(child, 2_000)
}

/**
 * @param {string} path
 * @returns {string[]} Last {@link LOG_TAIL_LINES} non-empty lines.
 */
function tailLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line !== '').slice(-LOG_TAIL_LINES)
}

/**
 * Print the retained logs to stderr after a failed boot.
 * @param {string} stdoutPath
 * @param {string} stderrPath
 */
function printLogTail(stdoutPath, stderrPath) {
  logError(`last ${String(LOG_TAIL_LINES)} stdout lines:`)
  for (const line of tailLines(stdoutPath)) console.error(line)
  logError(`last ${String(LOG_TAIL_LINES)} stderr lines:`)
  for (const line of tailLines(stderrPath)) console.error(line)
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    usage()
    return EXIT_USAGE
  }
  if (options.help) {
    usage()
    return EXIT_READY
  }
  if ((options.dir === undefined) === (options.zip === undefined)) {
    logError('exactly one of --dir=<extracted-dir> or --zip=<core-*.zip> is required')
    usage()
    return EXIT_USAGE
  }
  if (!checkNodeVersion(process.version)) {
    logError(`unsupported Node ${process.version}; the runtime requires ^22.19.0 || >=24.0.0`)
    return EXIT_NODE
  }

  let runtimeDir
  let extractionDir
  if (options.zip !== undefined) {
    const zipPath = resolve(options.zip)
    if (!existsSync(zipPath)) {
      logError(`zip not found: ${zipPath}`)
      return EXIT_FAILURE
    }
    extractionDir = mkdtempSync(join(tmpdir(), 'logexus-core-extract-'))
    try {
      log(`extracting ${zipPath} -> ${extractionDir}`)
      extractZip(zipPath, extractionDir)
    } catch (error) {
      logError(`failed to extract ${zipPath}: ${error instanceof Error ? error.message : String(error)}`)
      rmSync(extractionDir, { recursive: true, force: true })
      return EXIT_FAILURE
    }
    runtimeDir = extractionDir
  } else {
    runtimeDir = resolve(options.dir)
  }

  const cliEntry = join(runtimeDir, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(cliEntry)) {
    logError(`runtime entry not found: ${cliEntry}`)
    if (extractionDir !== undefined) rmSync(extractionDir, { recursive: true, force: true })
    return EXIT_USAGE
  }

  const logDir = mkdtempSync(join(tmpdir(), 'logexus-contract-'))
  const stdoutPath = join(logDir, 'stdout.log')
  const stderrPath = join(logDir, 'stderr.log')
  const timeoutMs = options.timeoutSeconds * 1_000
  let runtime
  let exitCode = EXIT_FAILURE
  let signalHandlers

  try {
    if (!(await isPortFree(CONTRACT_PORT))) {
      logError(`port ${String(CONTRACT_PORT)} is already in use; refusing to test another process's server`)
    } else {
      log(`port ${String(CONTRACT_PORT)} is free; booting ${cliEntry}`)
      runtime = startRuntime(runtimeDir, stdoutPath, stderrPath)
      const child = runtime.child
      const onSignal = (signal) => {
        logError(`received ${signal}; shutting down the runtime`)
        void terminate(child).finally(() => {
          process.exit(signal === 'SIGINT' ? 130 : 143)
        })
      }
      signalHandlers = onSignal
      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)
      let output = ''
      child.stdout.on('data', (chunk) => {
        output = `${output}${String(chunk)}`.slice(-OUTPUT_BUFFER_LIMIT)
      })
      try {
        const { token, line, elapsedMs } = await waitForToken(child, timeoutMs, () => output)
        log(`token observed after ${String(elapsedMs)}ms: ${line}`)
        const health = await checkHealth(CONTRACT_PORT, token, HEALTH_TIMEOUT_MS)
        if (health.ok) {
          log(`health check passed: ${health.detail}`)
          exitCode = EXIT_READY
        } else {
          logError(`health check failed (status ${String(health.status)}): ${health.detail}`)
        }
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error))
      }
    }
  } finally {
    if (signalHandlers !== undefined) {
      process.off('SIGINT', signalHandlers)
      process.off('SIGTERM', signalHandlers)
    }
    if (runtime !== undefined) {
      await terminate(runtime.child)
      const released = await waitForPortRelease(CONTRACT_PORT, PORT_RELEASE_TIMEOUT_MS)
      runtime.closeFiles()
      if (!released) {
        logError(`port ${String(CONTRACT_PORT)} is still listening after shutdown; the runtime leaked a child`)
        exitCode = EXIT_FAILURE
      }
    }
    if (exitCode === EXIT_READY) {
      rmSync(logDir, { recursive: true, force: true })
      if (extractionDir !== undefined) rmSync(extractionDir, { recursive: true, force: true })
      log('logs and temp extraction cleaned up')
    } else {
      logError(`logs retained at ${logDir}`)
      printLogTail(stdoutPath, stderrPath)
      if (extractionDir !== undefined) rmSync(extractionDir, { recursive: true, force: true })
    }
  }
  return exitCode
}

const isDirectRun = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      logError(error instanceof Error ? (error.stack ?? error.message) : String(error))
      process.exitCode = EXIT_FAILURE
    },
  )
}
