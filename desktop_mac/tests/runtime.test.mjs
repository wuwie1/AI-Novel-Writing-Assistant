import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { selectServerNode } from '../infrastructure/processes/launchers/server-node.mjs';
import { appendLogChunk } from '../infrastructure/processes/logging.mjs';
import { createLaunchdPlist, launchAgent, stopAgent } from '../infrastructure/processes/launchd.mjs';
import { createStageTimer, timeLifecycleAdapters } from '../application/lifecycle/timings.mjs';

test('runtime selection validates the native SQLite ABI without opening a persistent database', () => {
  const seen = [];
  const selected = selectServerNode('/repo', { run: (executable, args, options) => {
    seen.push(executable);
    assert.equal(options.cwd, '/repo/server');
    assert.ok(args[1].includes('new D(":memory:")'));
    assert.ok(!args[1].includes('app.js'));
    return { status: executable.includes('node@22') ? 0 : 1 };
  } });
  assert.ok(selected.includes('node@22'));
  assert.ok(seen.length > 1);
  assert.throws(() => selectServerNode('/repo', { explicit: '/chosen/node', run: () => ({ status: 1 }) }), { exitCode: 2 });
});

test('helper output remains private and bounded while the process is running', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mac-logs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'output.log');
  await appendLogChunk(file, Buffer.from('abcdefghijklmnopqrstuvwxyz'), { maxBytes: 4, retain: 3 });
  assert.equal((await readdir(directory)).length, 3);
  for (const name of await readdir(directory)) {
    const info = await stat(path.join(directory, name));
    assert.ok(info.size <= 4);
    assert.equal(info.mode & 0o077, 0);
  }
  assert.equal(await readFile(file, 'utf8'), 'yz');
});

test('stage durations persist for cache hits, cancelled closes and failed rollback dependencies', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mac-stage-timings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const measure = createStageTimer('restart_app', dir);
  const adapters = timeLifecycleAdapters({
    requestNativeClose: async () => ({ ok: false }),
    ensureConnection: async () => { throw Error('unlogged private details'); },
    async restorePrevious() { return this.ensureConnection({ mode: 'local' }); },
  }, measure);
  await measure('前端界面', () => 'hit', () => '命中缓存');
  assert.equal((await adapters.requestNativeClose()).ok, false);
  await assert.rejects(adapters.restorePrevious(), { stage: '连接本机服务' });
  const log = await readFile(path.join(dir, 'lifecycle.log'), 'utf8');
  for (const stage of ['前端界面 命中缓存', '等待窗口确认退出 未获退出确认', '连接本机服务 失败', '恢复上次成功的窗口 失败']) {
    assert.match(log, new RegExp(stage + ' \\d+ms'));
  }
  assert.ok(!log.includes('private details'));
});

test('launchd escapes repository and log paths with XML characters', () => {
  const xml = createLaunchdPlist({ label: 'test', executable: '/usr/bin/node', args: [], repoRealPath: '/books/A&B', logPath: '/books/A&B/log', errorPath: '/books/<error>', pathValue: '/bin' });
  assert.ok(xml.includes('/books/A&amp;B'));
  assert.ok(xml.includes('/books/&lt;error&gt;'));
  assert.ok(!xml.includes('/books/A&B'));
});

test('replacement waits for confirmed removal, including an agent unloading outside the CLI', async () => {
  const label = 'app.test.mac-proxy';
  const missing = Object.assign(new Error('missing'), { code: 113, stderr: `Could not find service "${label}" in domain for user gui` });
  let registered = true;
  const calls = [];
  const options = {
    exec: async (_, [command]) => {
      calls.push(command);
      if (command === 'print' && !registered) throw missing;
      if (command === 'bootstrap') assert.equal(registered, false);
      return { stdout: 'state = SIGTERMed' };
    },
    wait: async () => { registered = false; },
  };
  await stopAgent(label, options);
  assert.deepEqual(calls, ['bootout', 'print', 'print']);
  calls.length = 0;
  registered = true;
  await launchAgent(label, 'proxy.plist', options);
  assert.deepEqual(calls, ['print', 'print', 'bootstrap']);
  await assert.rejects(launchAgent(label, 'proxy.plist', {
    exec: async () => { throw Object.assign(Error('permission denied'), { code: 1 }); },
  }), /permission denied/);
  await assert.rejects(launchAgent(label, 'proxy.plist', {
    exec: async (_, [command]) => { assert.equal(command, 'print'); }, wait: async () => {}, timeoutMs: 0,
  }), { stage: 'launchd-unload' });
});

test('launchd ownership waits past xpcproxy and verifies exact argv before recording a process', async () => {
  const { waitForAgentIdentity } = await import('../infrastructure/processes/launchd.mjs');
  const expected = ['/node','/repo/supervisor.mjs','mac-proxy'];
  let attempt = 0;
  const result = await waitForAgentIdentity('app.test', expected, {
    print: async () => ({stdout:'pid = 42\n'}),
    readArgv: async () => ++attempt === 1 ? ['xpcproxy','app.test'] : expected,
    inspect: async () => ({pid:42,startTime:'same-start',command:expected.join(' ')}),
    wait: async () => {},
  });
  assert.equal(attempt,2);
  assert.equal(result.command,expected.join(' '));
  await assert.rejects(waitForAgentIdentity('app.test',expected,{
    print: async () => ({stdout:'pid = 42\n'}), readArgv: async () => ['/unrelated-process'],
    inspect: async () => {throw Error('must not accept an unrelated command');}, timeoutMs:5,
    wait: async () => new Promise((resolve)=>setTimeout(resolve,5)),
  }),{exitCode:5});
});
