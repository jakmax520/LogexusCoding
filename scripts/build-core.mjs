#!/usr/bin/env node
/**
 * Build the pruned, self-contained runtime package for the AI Coding engine.
 *
 * Usage: node scripts/build-core.mjs --platform=<platform> [--out=<path>]
 *
 * The source tree is `coding-harness/`. Its build outputs (`apps/cli/lib`,
 * `apps/web/dist`, `packages/<group>/<pkg>/lib`) plus a hoisted production
 * `node_modules` are assembled into a runtime tree and zipped.
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createZip } from './lib/archive.mjs'
import { isOptionalSubagent, shouldExclude } from './lib/package-rules.mjs'
import { hostPlatform, platformMismatchMessage } from './lib/platform.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE_DIR = join(REPO_ROOT, 'coding-harness')
const SUPPORTED_PLATFORMS = new Set(['macos-x64', 'macos-arm64', 'linux-x64', 'windows-x64'])
const WORK_TREE_SKIP = new Set(['node_modules', '.git'])
// Runtime copies never need test trees; upstream also carries a dangling
// symlink under apps/cli/tests that must not be dereferenced.
const LINKED_PACKAGE_SKIP = new Set(['node_modules', 'tests', 'test'])

function linkedPackageFilter(src) {
  return !LINKED_PACKAGE_SKIP.has(basename(src))
}

class BuildError extends Error {}

function log(message) {
  console.log(`[build-core] ${message}`)
}

function fail(message) {
  throw new BuildError(message)
}

function parseArgs(argv) {
  const options = { platform: undefined, out: undefined }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/build-core.mjs --platform=<platform> [--out=<path>]')
      process.exit(0)
    }
    if (arg.startsWith('--platform=')) options.platform = arg.slice('--platform='.length)
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else fail(`unknown argument: ${arg}`)
  }
  if (options.platform === undefined) {
    fail(`missing --platform=<platform> (supported: ${[...SUPPORTED_PLATFORMS].join(', ')})`)
  }
  if (!SUPPORTED_PLATFORMS.has(options.platform)) {
    fail(`unsupported platform: ${options.platform} (supported: ${[...SUPPORTED_PLATFORMS].join(', ')})`)
  }
  // The dependency install and native binaries follow the build host; a
  // mismatched label would ship a package that cannot run on the target.
  const host = hostPlatform()
  if (host !== options.platform) fail(platformMismatchMessage(options.platform, host))
  options.out = resolve(process.cwd(), options.out ?? join('dist', `core-${options.platform}.zip`))
  return options
}

/**
 * corepack is a `.cmd` shim on Windows, which execFile cannot launch directly;
 * the shell resolves it there. POSIX keeps direct execution so arguments with
 * shell-special characters are not reinterpreted.
 */
function corepack(args, options) {
  return execFileSync('corepack', args, {
    shell: process.platform === 'win32',
    ...options,
  })
}

function checkPrerequisites() {
  const missing = []
  try {
    execFileSync('node', ['--version'], { stdio: 'ignore' })
  } catch {
    missing.push('node')
  }
  try {
    corepack(['pnpm', '--version'], { stdio: 'ignore' })
  } catch {
    missing.push('pnpm (via corepack)')
  }
  if (missing.length > 0) {
    fail(`missing required tool(s): ${missing.join(', ')}. Install Node.js (with corepack) and retry.`)
  }
}

function pnpm(args, cwd, env = {}) {
  log(`pnpm ${args.join(' ')} (cwd=${cwd})`)
  corepack(['pnpm', ...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
}

function copyTree(from, to) {
  cpSync(from, to, { recursive: true, dereference: true })
}

function copyWorkTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !WORK_TREE_SKIP.has(basename(src)),
  })
}

/** Replace every symlink under `root` with a real copy of its target. */
function dereferenceSymlinks(root) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) {
      const target = resolve(dirname(path), readlinkSync(path))
      const targetStats = statSync(target)
      unlinkSync(path)
      if (targetStats.isDirectory()) {
        // A linked workspace package only needs its published files from the
        // hoisted tree; a nested node_modules would duplicate the whole install.
        cpSync(target, path, {
          recursive: true,
          dereference: true,
          filter: linkedPackageFilter,
        })
      } else {
        cpSync(target, path)
      }
      continue
    }
    if (stats.isDirectory()) dereferenceSymlinks(path)
  }
}

function shouldPrune(name) {
  return shouldExclude(name) || isOptionalSubagent(name)
}

function workspaceProjects(workTree) {
  const output = corepack(['pnpm', '-r', 'list', '--depth', '-1', '--json'], {
    cwd: workTree,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return JSON.parse(output)
}

function workspaceLinkTarget(linkPath, workTreeRealPath) {
  let target
  try {
    target = realpathSync(linkPath)
  } catch {
    return undefined
  }
  // Use the platform separator: Windows realpaths use `\`, so a hardcoded `/`
  // would reject every workspace link there.
  const prefix = workTreeRealPath.endsWith(sep) ? workTreeRealPath : `${workTreeRealPath}${sep}`
  return target.startsWith(prefix) ? target : undefined
}

/** Record workspace-package links found directly under one `node_modules`. */
function scanWorkspaceLinks(nodeModules, workTree, found) {
  if (!existsSync(nodeModules)) return
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue
    const path = join(nodeModules, entry)
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) {
      const target = workspaceLinkTarget(path, workTree)
      if (target !== undefined && existsSync(join(target, 'package.json'))) found.set(entry, target)
    } else if (entry.startsWith('@') && stats.isDirectory()) {
      for (const sub of readdirSync(path)) {
        const subPath = join(path, sub)
        if (!lstatSync(subPath).isSymbolicLink()) continue
        const target = workspaceLinkTarget(subPath, workTree)
        if (target !== undefined && existsSync(join(target, 'package.json'))) {
          found.set(`${entry}/${sub}`, target)
        }
      }
    }
  }
}

/**
 * Hoisted production installs keep workspace packages as links inside each
 * project's node_modules. Materialize them at the top level so the runtime
 * resolves `@deepseek-ai/*` without the source tree.
 */
function hoistWorkspacePackages(workTree, nodeModules) {
  const found = new Map()
  const projects = workspaceProjects(workTree)
  // Compare against the real path: pnpm resolves the temporary work tree to
  // /private/var/... on macOS while mkdtemp returns /var/....
  const workTreeRealPath = realpathSync(workTree)

  // A production install only links workspace packages that are regular
  // dependencies of some project. The harness also loads packages that are
  // referenced only as peer/devDependencies, so materialize every
  // @deepseek-ai/* workspace package up front.
  for (const project of projects) {
    if (realpathSync(project.path) === workTreeRealPath) continue
    const manifestPath = join(project.path, 'package.json')
    if (!existsSync(manifestPath)) continue
    const name = JSON.parse(readFileSync(manifestPath, 'utf8')).name
    if (typeof name === 'string' && name.startsWith('@deepseek-ai/')) found.set(name, project.path)
  }

  // Keep any remaining linked workspace packages (for example non-@deepseek-ai
  // workspace names) that the dependency graph linked into a project tree.
  for (const project of projects) {
    scanWorkspaceLinks(join(project.path, 'node_modules'), workTreeRealPath, found)
  }
  scanWorkspaceLinks(nodeModules, workTreeRealPath, found)

  for (const [name, target] of found) {
    const destination = join(nodeModules, name)
    if (existsSync(destination)) continue
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(target, destination, {
      recursive: true,
      dereference: true,
      filter: linkedPackageFilter,
    })
  }
  log(`hoisted ${found.size} workspace package(s) into node_modules`)
}

/** `.pnpm` directory names look like `name@version` or `@scope+name@version`. */
function pnpmStoreEntryName(entry) {
  return entry.replaceAll('+', '/').replace(/@[^/@]+$/, '')
}

function pruneExcluded(nodeModules) {
  const removed = []
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      for (const sub of readdirSync(join(nodeModules, entry))) {
        const name = `${entry}/${sub}`
        if (shouldPrune(name)) {
          rmSync(join(nodeModules, entry, sub), { recursive: true, force: true })
          removed.push(name)
        }
      }
    } else if (shouldPrune(entry)) {
      rmSync(join(nodeModules, entry), { recursive: true, force: true })
      removed.push(entry)
    }
  }

  const pnpmStore = join(nodeModules, '.pnpm')
  if (existsSync(pnpmStore)) {
    for (const entry of readdirSync(pnpmStore)) {
      if (shouldPrune(pnpmStoreEntryName(entry))) {
        rmSync(join(pnpmStore, entry), { recursive: true, force: true })
        removed.push(`.pnpm/${entry}`)
      }
    }
  }
  log(removed.length > 0 ? `pruned: ${removed.join(', ')}` : 'pruned: nothing to remove')
}

/** Every built `packages/<group>/<name>/lib` directory under one packages root. */
function packageLibDirs(packagesRoot) {
  const dirs = []
  for (const group of readdirSync(packagesRoot)) {
    const groupDir = join(packagesRoot, group)
    if (!statSync(groupDir).isDirectory()) continue
    for (const name of readdirSync(groupDir)) {
      const libDir = join(groupDir, name, 'lib')
      if (existsSync(libDir) && statSync(libDir).isDirectory()) dirs.push(libDir)
    }
  }
  return dirs
}

/** Import forms that can pull a package into the running process. */
const WORKSPACE_IMPORT_PATTERNS = [
  /\bfrom\s*['"](@deepseek-ai\/[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](@deepseek-ai\/[^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"](@deepseek-ai\/[^'"]+)['"]\s*\)/g,
  /\brequire\.resolve\s*\(\s*['"](@deepseek-ai\/[^'"]+)['"]\s*\)/g,
  /\bimport\s+['"](@deepseek-ai\/[^'"]+)['"]/g,
]

const MODULE_FILE_PATTERN = /\.(?:c|m)?js$/u

function moduleFilesUnder(root) {
  const files = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    const stats = lstatSync(path)
    if (stats.isDirectory()) files.push(...moduleFilesUnder(path))
    else if (stats.isFile() && MODULE_FILE_PATTERN.test(entry)) files.push(path)
  }
  return files
}

/** Every materialized `node_modules/@deepseek-ai/<name>/lib` directory. */
function scopedPackageLibDirs(nodeModules) {
  const scopeDir = join(nodeModules, '@deepseek-ai')
  if (!existsSync(scopeDir)) return []
  const dirs = []
  for (const name of readdirSync(scopeDir)) {
    const libDir = join(scopeDir, name, 'lib')
    if (existsSync(libDir) && statSync(libDir).isDirectory()) dirs.push(libDir)
  }
  return dirs
}

/**
 * Assert that every `@deepseek-ai/*` package imported by runtime code exists
 * in the packaged node_modules. Peer-only and lazily loaded packages are easy
 * to miss; fail the build instead of shipping an unbootable tree.
 */
function assertWorkspaceImportsResolve(runtime) {
  const nodeModules = join(runtime, 'node_modules')
  const roots = [
    join(runtime, 'apps/cli/lib'),
    ...packageLibDirs(join(runtime, 'packages')),
    ...scopedPackageLibDirs(nodeModules),
  ]
  const referenced = new Set()
  const unresolved = new Set()
  for (const root of roots) {
    for (const file of moduleFilesUnder(root)) {
      const source = readFileSync(file, 'utf8')
      for (const pattern of WORKSPACE_IMPORT_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
          const [scope, name] = match[1].split('/')
          const packageName = `${scope}/${name}`
          referenced.add(packageName)
          if (!existsSync(join(nodeModules, packageName, 'package.json'))) unresolved.add(packageName)
        }
      }
    }
  }
  if (unresolved.size > 0) {
    fail(`unresolved @deepseek-ai imports in runtime tree: ${[...unresolved].sort().join(', ')}`)
  }
  log(`static import scan: ${referenced.size} workspace package(s) referenced, all resolved`)
}

function assembleRuntime(workTree, runtime) {
  mkdirSync(runtime, { recursive: true })

  copyTree(join(workTree, 'apps/cli/lib'), join(runtime, 'apps/cli/lib'))
  cpSync(join(workTree, 'apps/cli/package.json'), join(runtime, 'apps/cli/package.json'))
  copyTree(join(workTree, 'apps/web/dist'), join(runtime, 'apps/web/dist'))

  const packagesRoot = join(workTree, 'packages')
  for (const libDir of packageLibDirs(packagesRoot)) {
    copyTree(libDir, join(runtime, 'packages', relative(packagesRoot, libDir)))
  }

  copyTree(join(workTree, 'node_modules'), join(runtime, 'node_modules'))
  for (const entry of readdirSync(workTree)) {
    if (/^cordis.*\.yml$/.test(entry)) {
      cpSync(join(workTree, entry), join(runtime, entry))
    }
  }
  for (const dir of ['native', 'vendor']) {
    const source = join(workTree, dir)
    if (!existsSync(source)) continue
    // Dev-only nested node_modules (with platform links and devDependency
    // symlinks) are not part of the runtime; root node_modules covers deps.
    cpSync(source, join(runtime, dir), {
      recursive: true,
      dereference: true,
      filter: (src) => basename(src) !== 'node_modules',
    })
  }
  cpSync(join(workTree, 'package.json'), join(runtime, 'package.json'))
}

function verifySelfContained(root) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) fail(`runtime tree contains a symlink: ${path}`)
    if (stats.isDirectory()) verifySelfContained(path)
  }
}

function directorySize(root) {
  let total = 0
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    const stats = lstatSync(path)
    total += stats.isDirectory() ? directorySize(path) : stats.size
  }
  return total
}

function filesize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  checkPrerequisites()

  if (!existsSync(join(SOURCE_DIR, 'package.json'))) {
    fail(`harness source not found: ${SOURCE_DIR}`)
  }

  log(`platform=${options.platform} out=${options.out}`)
  log('step 1/8: install full dependencies')
  // CI=true stops the harness postinstall from writing dev-only git hooks into
  // the enclosing repository; it does not skip dependency install scripts.
  pnpm(['install', '--frozen-lockfile'], SOURCE_DIR, { CI: 'true' })

  log('step 2/8: build host libraries')
  pnpm(['run', 'build:lib:host'], SOURCE_DIR)

  log('step 3/8: build client libraries')
  pnpm(['run', 'build:lib:client'], SOURCE_DIR)

  log('step 4/8: build web frontend')
  pnpm(['--filter', '@deepseek-ai/dsh-web-frontend', 'run', 'build'], SOURCE_DIR)

  const tempRoot = mkdtempSync(join(tmpdir(), 'logexus-core-'))
  try {
    const workTree = join(tempRoot, 'harness')
    const runtime = join(tempRoot, 'runtime')

    log(`step 5/8: production install in temporary work tree (${workTree})`)
    copyWorkTree(SOURCE_DIR, workTree)
    // The root postinstall installs dev-only git hooks; it cannot run against
    // a production-only node_modules. Drop it from the throwaway copy only.
    const manifestPath = join(workTree, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.scripts) delete manifest.scripts.postinstall
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    pnpm(['install', '--prod', '--node-linker=hoisted', '--frozen-lockfile'], workTree, { CI: 'true' })

    log('step 6/8: dereference links and prune excluded packages')
    const nodeModules = join(workTree, 'node_modules')
    hoistWorkspacePackages(workTree, nodeModules)
    dereferenceSymlinks(nodeModules)
    pruneExcluded(nodeModules)

    log('step 7/8: assemble runtime tree')
    assembleRuntime(workTree, runtime)
    verifySelfContained(runtime)
    assertWorkspaceImportsResolve(runtime)

    log('step 8/8: zip runtime')
    mkdirSync(dirname(options.out), { recursive: true })
    rmSync(options.out, { force: true })
    try {
      createZip(runtime, options.out)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }

    log(`done: ${options.out} (${filesize(statSync(options.out).size)})`)
    log(`uncompressed runtime: ${filesize(directorySize(runtime))}`)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  if (error instanceof BuildError) {
    console.error(`[build-core] ERROR: ${error.message}`)
    process.exit(1)
  }
  throw error
}
