import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseToken, checkNodeVersion } from '../contract-test.mjs';

test('parses dsh web launch token', () => {
  const line = 'dsh web: http://127.0.0.1:3080/?token=AbC123xyz_-456789';
  assert.equal(parseToken(line), 'AbC123xyz_-456789');
  assert.equal(parseToken('no token here'), null);
});

test('enforces upstream node range', () => {
  assert.equal(checkNodeVersion('v22.19.0'), true);
  assert.equal(checkNodeVersion('v22.18.9'), false);
  assert.equal(checkNodeVersion('v23.4.0'), false);
  assert.equal(checkNodeVersion('v24.1.0'), true);
});

test('rejects short or malformed tokens', () => {
  assert.equal(parseToken('dsh web: ?token=short'), null);
  assert.equal(parseToken('dsh web: ?token=123456789012345'), null);
  assert.equal(parseToken('token=1234567890123456&next=1'), '1234567890123456');
  assert.equal(parseToken('token=AbC123xyz_-456789 (LAN: x)'), 'AbC123xyz_-456789');
});

test('accepts newer majors and rejects malformed versions', () => {
  assert.equal(checkNodeVersion('v25.0.0'), true);
  assert.equal(checkNodeVersion('22.19.0'), true);
  assert.equal(checkNodeVersion('node'), false);
  assert.equal(checkNodeVersion(''), false);
});

const TOKEN = 'AbCdEfGhIjKlMnOp';
const STUB_CLI = [
  "import { createServer } from 'node:http'",
  "import { spawn } from 'node:child_process'",
  "import { existsSync, writeFileSync } from 'node:fs'",
  `const token = '${TOKEN}'`,
  "const session = 'dsh_session=stub'",
  "const stubborn = process.env.CONTRACT_STUB_STUBBORN === '1'",
  'const childCode = stubborn ? "process.on(\'SIGTERM\', () => {}); require(\'node:fs\').writeFileSync(\'grandchild.ready\', \'1\'); setInterval(() => {}, 1000)" : "require(\'node:fs\').writeFileSync(\'grandchild.ready\', \'1\'); setInterval(() => {}, 1000)"',
  "const grandchild = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore' })",
  "writeFileSync('grandchild.pid', String(grandchild.pid))",
  "const server = createServer((req, res) => {",
  "  const url = new URL(req.url ?? '/', 'http://127.0.0.1')",
  "  const authed = String(req.headers.cookie ?? '').includes(session)",
  "  if (url.pathname !== '/') { res.writeHead(404); res.end(); return }",
  "  if (url.searchParams.get('token') === token) {",
  "    res.writeHead(303, { location: '/', 'set-cookie': session + '; Path=/; HttpOnly' })",
  "    res.end(); return",
  "  }",
  "  if (authed) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return }",
  "  res.writeHead(401, { 'content-type': 'text/plain' }); res.end('unauthorized')",
  '})',
  "const start = () => {",
  "  if (!existsSync('grandchild.ready')) { setTimeout(start, 10); return }",
  "  server.listen(3080, '127.0.0.1', () => {",
  "    console.log('dsh web: http://127.0.0.1:3080/?token=' + token)",
  "  })",
  '}',
  'start()',
].join('\n');

function fakeRuntime(root) {
  const dir = join(root, 'runtime');
  mkdirSync(join(dir, 'apps', 'cli', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'apps', 'cli', 'lib', 'bin.js'), `${STUB_CLI}\n`);
  return dir;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function waitUntilDead(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function portFree(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close((error) => (error === undefined ? resolve(true) : reject(error)));
    });
  });
}

test('boots, authenticates, and cleans up the whole process tree', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const scratch = mkdtempSync(join(tmpdir(), 'contract-selftest-'));
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    const runtimeDir = fakeRuntime(scratch);
    const exitCode = await main([`--dir=${runtimeDir}`, '--timeout=30']);
    assert.equal(exitCode, 0);
    assert.equal(await portFree(3080), true);

    const pidFile = join(runtimeDir, 'grandchild.pid');
    assert.equal(existsSync(pidFile), true);
    const grandchildPid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(await waitUntilDead(grandchildPid), true, 'grandchild process must not be orphaned');

    const leftovers = readdirSync(scratch).filter((entry) => entry !== 'runtime');
    assert.deepEqual(leftovers, [], 'logs must be removed on success');
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('escalates to SIGKILL when a grandchild ignores SIGTERM', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const scratch = mkdtempSync(join(tmpdir(), 'contract-selftest-'));
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  process.env.CONTRACT_STUB_STUBBORN = '1';
  try {
    const runtimeDir = fakeRuntime(scratch);
    const exitCode = await main([`--dir=${runtimeDir}`, '--timeout=30']);
    assert.equal(exitCode, 0);
    assert.equal(await portFree(3080), true);

    const grandchildPid = Number(readFileSync(join(runtimeDir, 'grandchild.pid'), 'utf8'));
    assert.equal(
      await waitUntilDead(grandchildPid),
      true,
      'a SIGTERM-ignoring grandchild must be SIGKILLed with its process group',
    );
  } finally {
    delete process.env.CONTRACT_STUB_STUBBORN;
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('exits 3 when the extracted runtime has no CLI entry', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const scratch = mkdtempSync(join(tmpdir(), 'contract-selftest-'));
  try {
    const emptyRuntime = join(scratch, 'empty-runtime');
    mkdirSync(emptyRuntime, { recursive: true });
    assert.equal(await main([`--dir=${emptyRuntime}`, '--timeout=5']), 3);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('exits 1 when the zip path does not exist', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  assert.equal(await main(['--zip=/nonexistent/contract-test.zip']), 1);
});

test('exits 3 when port 3080 is already occupied', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const scratch = mkdtempSync(join(tmpdir(), 'contract-selftest-'));
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  const blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(3080, '127.0.0.1', resolve);
  });
  try {
    const runtimeDir = fakeRuntime(scratch);
    const exitCode = await main([`--dir=${runtimeDir}`, '--timeout=5']);
    assert.equal(exitCode, 3);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(scratch, { recursive: true, force: true });
  }
});

