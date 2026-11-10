import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLifecycle } from '../application/lifecycle/index.mjs';
import { readState, writeState, acquireLock } from '../infrastructure/processes/lock.mjs';
import { processMatches, signalOwnedProcess, stableHash } from '../infrastructure/processes/identity.mjs';
import { requestOwnedWindowClose } from '../infrastructure/processes/native-socket.mjs';

async function setup(t, overrides = {}) {
  const repoRealPath = await mkdtemp(path.join(os.tmpdir(), 'mac-life-'));
  t.after(() => rm(repoRealPath, { recursive: true, force: true }));
  const calls = [];
  let ready = true;
  let failPrepare = false;
  let cancelClose = false;
  const adapters = {
    ensureRendererDependencies: async () => calls.push('dependencies'),
    nativeStatus: async (current) => current?.runningMode ? ({ rendererReady: ready, repo: repoRealPath, mode: current.runningMode, backendIdentity: current.backendIdentity, pid: current.processes?.app?.pid }) : null, focus: async () => calls.push('focus'),
    requestNativeClose: async () => ({ ok: !cancelClose, cancelled: cancelClose }), waitAppExited: async () => calls.push('waitExit'),
    prepare: async ({ mode }) => { calls.push(`prepare:${mode}`); if (failPrepare) throw Error('build failed'); return { fingerprint: `build-${mode}` }; },
    ensureConnection: async ({ mode }) => { calls.push(`connect:${mode}`); return { backendIdentity: `identity-${mode}`, processes: {} }; },
    startHelpers: async ({ mode }) => { calls.push(`helpers:${mode}`); return { processes: { proxy: { ownership: 'owned', mode } } }; },
    openNative: async ({ mode }) => { calls.push(`open:${mode}`); return { process: { ownership: 'owned', mode } }; },
    waitRendererReady: async () => {}, waitHealthy: async () => {},
    stopOwned: async (role) => calls.push(`stop:${role}`),
    localApiIdle: async () => false,
    report: async (message) => calls.push(message),
    ...overrides,
  };
  const config = { repoRealPath, localApiPort: 3000, devUiPort: 15174, appUiPort: 15175, tunnelPort: 15173 };
  const lifecycle = createLifecycle({ config, adapters, clock: () => '2026-11-06T00:00:00Z' });
  return { lifecycle, repoRealPath, calls, adapters, setReady: (value) => { ready = value; }, setFailPrepare: (value) => { failPrepare = value; }, setCancelClose: (value) => { cancelClose = value; } };
}

test('repeated start focuses the owned native window and does not duplicate helpers', async (t) => {
  const { lifecycle, calls } = await setup(t);
  assert.equal((await lifecycle.startLocal()).status, 'started');
  assert.equal((await lifecycle.startLocal()).status, 'focused');
  assert.equal(calls.filter((item) => item === 'prepare:local').length, 1);
  assert.ok(calls.includes('focus'));
});

test('an unready legacy window can refuse stop, restart and mode switch without reporting user cancellation or stopping helpers', async t => {
  const {lifecycle, calls, adapters, repoRealPath} = await setup(t);
  await lifecycle.startRemote();
  const original = await lifecycle.getState();
  const status = {ok: true, repo: repoRealPath, mode: 'remote', backendIdentity: original.backendIdentity, rendererReady: false};
  const send = async (_socket, command) => command === 'status' ? status : {ok: false, cancelled: true};
  adapters.requestNativeClose = state => requestOwnedWindowClose(repoRealPath, state, send);
  for (const run of [lifecycle.stop, lifecycle.restart, lifecycle.startLocal]) {
    calls.length = 0;
    await assert.rejects(run(), error => {
      assert.equal(error.exitCode, 5);
      assert.equal(error.cancelled, false);
      assert.match(error.userHint, /⌘Q/);
      return true;
    });
    assert.equal(calls.includes('waitExit'), false);
    assert.equal(calls.some(call => call.startsWith('stop:')), false);
    assert.deepEqual((await lifecycle.getState()).processes, original.processes);
  }
  status.rendererReady = true;
  await assert.rejects(lifecycle.stop(), {exitCode: 3, cancelled: true});
});

test('the close protocol verifies the window before quitting and preserves busy, timeout and pending reasons', async t => {
  const {lifecycle, adapters, calls, repoRealPath} = await setup(t);
  await lifecycle.startLocal();
  const original = await lifecycle.getState();
  const status = {ok: true, rendererReady: true, rendererState: 'ready', repo: repoRealPath, mode: 'local', backendIdentity: original.backendIdentity};
  let requests = 0;
  let reason;
  const send = async (_socket, command) => {
    if (command === 'status') return status;
    requests++;
    if (reason === 'timeout') throw Object.assign(new Error('socket timed out'), {code: 'ETIMEDOUT'});
    return reason ? {ok: false, cancelled: false, error: reason} : {ok: true};
  };
  adapters.requestNativeClose = state => requestOwnedWindowClose(repoRealPath, state, send);
  status.repo = '/different';
  await assert.rejects(lifecycle.stop(), {exitCode: 4});
  assert.equal(requests, 0);
  status.repo = repoRealPath;
  for (const [reply, hint] of [['document_busy', /保存或生成/], ['close_pending', /已有的确认/], ['timeout', /保存状态/]]) {
    reason = reply;
    await assert.rejects(lifecycle.stop(), error => {
      assert.equal(error.cancelled, false);
      assert.match(error.userHint, hint);
      return true;
    });
  }
  assert.equal(calls.includes('waitExit'), false);
  status.rendererReady = false;
  status.rendererState = 'terminated';
  reason = null;
  assert.equal((await lifecycle.stop()).status, 'stopped');
  assert.equal(calls.includes('waitExit'), true);
});

test('remote dependencies are checked under the lifecycle lock before build, focus and restart', async (t) => {
  const { lifecycle, calls } = await setup(t);
  await lifecycle.startRemote();
  assert.deepEqual(calls.slice(0, 2), ['dependencies', 'prepare:remote']);
  calls.length = 0;
  await lifecycle.startRemote();
  assert.deepEqual(calls, ['dependencies', 'focus']);
  calls.length = 0;
  await lifecycle.restart('remote');
  assert.deepEqual(calls.slice(0, 2), ['dependencies', 'prepare:remote']);
  assert.equal(calls.filter(call => call === 'dependencies').length, 1);
});

test('failed dependency repair leaves the running window in place and remembers the requested mode', async (t) => {
  const { lifecycle, calls } = await setup(t, {
    ensureRendererDependencies() { throw Object.assign(new Error('install failed'), { exitCode: 2 }); },
  });
  await lifecycle.startLocal();
  const previous = await lifecycle.getState();
  calls.length = 0;
  await assert.rejects(lifecycle.startRemote(), { exitCode: 2 });
  await assert.rejects(lifecycle.restart(), { exitCode: 2 });
  assert.deepEqual(calls, []);
  const state = await lifecycle.getState();
  assert.equal(state.requestedMode, 'remote');
  assert.equal(state.runningMode, 'local');
  assert.deepEqual(state.processes, previous.processes);
  assert.deepEqual(state.previousSuccessfulBuild, previous.previousSuccessfulBuild);
});

test('cancelled mode switch retains the running mode and build failure preserves prior success', async (t) => {
  const ctx = await setup(t); const { lifecycle, setCancelClose, setFailPrepare, repoRealPath } = ctx;
  await lifecycle.startLocal();
  setCancelClose(true);
  await assert.rejects(lifecycle.startRemote(), { exitCode: 3 });
  assert.equal((await lifecycle.getState()).runningMode, 'local');
  setCancelClose(false); setFailPrepare(true);
  await assert.rejects(lifecycle.restart('remote'), { exitCode: 5 });
  const state = await lifecycle.getState();
  assert.equal(state.runningMode, 'local');
  assert.equal(state.requestedMode, 'remote');
  assert.equal(state.previousSuccessfulBuild.fingerprint, 'build-local');
  assert.equal(state.repoRealPath, repoRealPath);
});

test('a verified window exit remains recorded when helper removal fails, so the next command can retry', async (t) => {
  for (const operation of ['restart', 'switch', 'stop']) {
    await t.test(operation, async (t) => {
      let closeRequests = 0;
      let failRemoval = false;
      async function removeHelper() { if (failRemoval) throw Error('helper still unloading'); }
      const { lifecycle } = await setup(t, {
        requestNativeClose: async () => { closeRequests += 1; return { ok: true }; },
        startHelpers: async ({ mode }) => ({ processes: { 'mac-proxy': { ownership: 'owned', mode } } }),
        cleanupWindowHelpers: removeHelper,
        stopOwned: removeHelper,
      });
      await lifecycle.startLocal();
      failRemoval = true;
      const actions = { restart: () => lifecycle.restart('remote'), switch: lifecycle.startRemote, stop: lifecycle.stop };
      await assert.rejects(actions[operation](), /still unloading/);
      const state = await lifecycle.getState();
      assert.equal(state.runningMode, null);
      assert.equal(state.processes.app, undefined);
      assert.equal(state.processes['mac-proxy'].ownership, 'owned');
      assert.equal(state.previousSuccessfulBuild.fingerprint, 'build-local');
      failRemoval = false;
      assert.equal((await lifecycle.restart('remote')).status, 'started');
      assert.equal(closeRequests, 1);
    });
  }
});

test('stop keeps local API when activity cannot be confirmed and never signals borrowed helpers', async (t) => {
  const { lifecycle, calls, adapters } = await setup(t, { ensureConnection: async () => ({ backendIdentity: 'identity-local', processes: { 'local-api': { ownership: 'owned' }, tunnel: { ownership: 'borrowed' } } }) });
  await lifecycle.startLocal();
  const result = await lifecycle.stop();
  assert.deepEqual(result.retained, ['local-api']);
  assert.ok(calls.includes('stop:proxy'));
  assert.ok(!calls.includes('stop:tunnel'));
  assert.ok(!calls.includes('stop:local-api'));
  assert.equal((await lifecycle.getState()).runningMode, null);
  assert.equal(typeof adapters.stopOwned, 'function');
  adapters.localApiIdle = async () => true;
  const secondStop = await lifecycle.stop();
  assert.deepEqual(secondStop.retained, []);
  assert.ok(calls.includes('stop:local-api'));
});

test('mode switch waits for native exit before replacing helpers and same-mode unready sockets never spawn duplicates', async (t) => {
  const ctx = await setup(t); const { lifecycle, calls, setReady } = ctx;
  await lifecycle.startLocal();
  setReady(false);
  await assert.rejects(lifecycle.startLocal(), { exitCode: 5 });
  assert.equal(calls.filter((item) => item === 'prepare:local').length, 1);
  setReady(true);
  await lifecycle.startRemote();
  const exitIndex = calls.lastIndexOf('waitExit');
  const connectIndex = calls.lastIndexOf('connect:remote');
  assert.ok(exitIndex >= 0 && connectIndex > exitIndex);
  assert.equal((await lifecycle.getState()).runningMode, 'remote');
});

test('failed window startup retains an owned local API when task activity is unknown', async (t) => {
  const localApi = { ownership: 'owned', role: 'local-api', mode: 'local', repoRealPath: '', databaseIdentity: 'identity-local', pid: 81 };
  const ctx = await setup(t, {
    ensureConnection: async () => ({ backendIdentity: 'identity-local', processes: { 'local-api': { ...localApi } } }),
    openNative: async () => { throw Object.assign(new Error('native failed'), { exitCode: 5 }); },
    cleanupFailedStart: async () => ({ 'local-api': { ...localApi } }),
  });
  localApi.repoRealPath = ctx.repoRealPath;
  await assert.rejects(ctx.lifecycle.startLocal(), { exitCode: 5 });
  const state = await ctx.lifecycle.getState();
  assert.equal(state.runningMode, null);
  assert.equal(state.processes['local-api'].ownership, 'owned');
  assert.equal(state.backendIdentity, 'identity-local');
});

test('corrupt state and an existing lock reject mutations without guessing process identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mac-state-')); t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, 'state.json'); await writeFile(statePath, '{');
  await assert.rejects(readState(statePath, root), { exitCode: 4 });
  const lockPath = path.join(root, 'lock');
  const lock = await acquireLock(lockPath, { repoRealPath: root, operation: 'app' });
  await assert.rejects(acquireLock(lockPath, { repoRealPath: root, operation: 'stop_app' }), { exitCode: 4 });
  await lock.release();
  await writeState(statePath, { schemaVersion: 1, repoRealPath: root, requestedMode: null, runningMode: null, backendIdentity: null, buildFingerprint: null, previousSuccessfulBuild: null, processes: {} });
  assert.equal((await readState(statePath, root)).runningMode, null);
});

test('process signal requires matching repository, role, mode, start time and command; borrowed helpers are never signalled', async () => {
  const command = '/usr/bin/node /repo/desktop_mac/infrastructure/transport/server.mjs';
  const record = { ownership: 'owned', repoRealPath: '/repo', role: 'mac-proxy', mode: 'remote', pid: 42, startTime: 'Tue Nov  6 10:00:00 2026', commandIdentity: stableHash(command) };
  let signals = 0;
  const adapters = { inspectProcess: async () => ({ pid: 42, startTime: record.startTime, command }), kill: () => { signals += 1; } };
  const expected = { repoRealPath: '/repo', role: 'mac-proxy', mode: 'remote' };
  assert.equal(await processMatches(record, expected, adapters), true);
  const sshCommand = '/usr/bin/ssh -N -o BatchMode=yes -L 127.0.0.1:15173:127.0.0.1:18080 root@example.test';
  assert.equal(await processMatches({ ...record, role: 'tunnel', commandIdentity: stableHash(sshCommand) }, { repoRealPath: '/repo', role: 'tunnel', mode: 'remote' }, { ...adapters, inspectProcess: async () => ({ pid: 42, startTime: record.startTime, command: sshCommand }) }), true);
  assert.equal(await processMatches(record, { ...expected, mode: 'local' }, adapters), false);
  assert.equal(await processMatches(record, expected, { ...adapters, inspectProcess: async () => ({ pid: 42, startTime: 'reused-pid', command }) }), false);
  await assert.rejects(signalOwnedProcess(record, 'SIGTERM', { ...expected, repoRealPath: '/other' }, adapters), { exitCode: 4 });
  assert.equal(signals, 0);
  await assert.rejects(signalOwnedProcess({ ...record, ownership: 'borrowed' }, 'SIGTERM', expected, adapters), { exitCode: 4 });
  assert.equal(signals, 0);
});

test('failed renderer startup preserves a new window that refuses close and does not roll another window over it', async (t) => {
  let failHealth = false;
  let lastMode;
  const ctx = await setup(t, {
    openNative: async ({ mode }) => { lastMode = mode; return { process: { ownership: 'owned', mode } }; },
    waitRendererReady: async () => { if (failHealth) throw new Error('renderer failed'); },
    cleanupFailedStart: async () => ({ app: { ownership: 'owned', mode: lastMode, backendIdentity: `identity-${lastMode}` }, proxy: { ownership: 'owned', mode: lastMode } }),
    restorePrevious: async () => { throw new Error('must not replace the retained native window'); },
  });
  await ctx.lifecycle.startLocal();
  failHealth = true;
  await assert.rejects(ctx.lifecycle.restart('remote'), { exitCode: 5 });
  const state = await ctx.lifecycle.getState();
  assert.equal(state.runningMode, 'remote');
  assert.equal(state.backendIdentity, 'identity-remote');
  assert.equal(state.processes.app.mode, 'remote');
  assert.equal(state.previousSuccessfulBuild.fingerprint, 'build-local');
});

test('stop cleans a retained owned tunnel even when no window or local API remains', async (t) => {
  const ctx = await setup(t);
  await writeState(path.join(ctx.repoRealPath, '.runtime/desktop_mac/state.json'), {
    schemaVersion: 1, repoRealPath: ctx.repoRealPath, requestedMode: 'remote', runningMode: null,
    backendIdentity: null, buildFingerprint: null, previousSuccessfulBuild: null,
    processes: { tunnel: { ownership: 'owned', role: 'tunnel', mode: 'remote' } },
  });
  await ctx.lifecycle.stop();
  assert.ok(ctx.calls.includes('stop:tunnel'));
});

test('the renderer host must be healthy before the native window opens', async (t) => {
  const events=[];
  const ctx=await setup(t,{
    waitHealthy:async()=>events.push('http-ready'),
    openNative:async({mode})=>{events.push('open-window');return {process:{ownership:'owned',mode}};},
    waitRendererReady:async()=>events.push('renderer-ready'),
  });
  await ctx.lifecycle.startLocal();
  assert.deepEqual(events,['http-ready','open-window','renderer-ready']);
});

test('stop and start unload untracked helper agents after saving state', async (t) => {
  const seen = [];
  const { lifecycle } = await setup(t, { cleanupOrphanAgents: async (current) => { seen.push({ running: current.runningMode, roles: Object.keys(current.processes ?? {}) }); return []; } });
  await lifecycle.startLocal();
  await lifecycle.stop();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].running, null);
  assert.ok(!seen[1].roles.includes('app'));
});

test('a lock left by a dead process on this machine is reclaimed; a live owner still blocks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mac-lock-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'lock');
  await acquireLock(lockPath, { repoRealPath: root, operation: 'stop_app', pid: 999_999 });
  await assert.rejects(acquireLock(lockPath, { repoRealPath: root, operation: 'app', isPidAlive: () => true }), { exitCode: 4, lockBusy: true });
  const reclaimed = await acquireLock(lockPath, { repoRealPath: root, operation: 'app', isPidAlive: () => false });
  assert.equal(reclaimed.owner.operation, 'app');
  await reclaimed.release();
  await acquireLock(lockPath, { repoRealPath: '/other/repo', operation: 'stop_app', pid: 999_999 });
  await assert.rejects(acquireLock(lockPath, { repoRealPath: root, operation: 'app', isPidAlive: () => false }), { exitCode: 4 });
});

test('stale-lock detection uses the stable machine id when the network hostname changes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mac-lock-id-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'lock');
  await acquireLock(lockPath, { repoRealPath: root, operation: 'stop_app', pid: 999_999, currentMachineId: 'machine-a' });
  const ownerPath = path.join(lockPath, 'owner.json');
  const { readFile } = await import('node:fs/promises');
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  await writeFile(ownerPath, JSON.stringify({ ...owner, hostname: 'bogon' }));
  await assert.rejects(acquireLock(lockPath, { repoRealPath: root, operation: 'app', isPidAlive: () => false, currentMachineId: 'machine-b' }), { exitCode: 4 });
  const reclaimed = await acquireLock(lockPath, { repoRealPath: root, operation: 'app', isPidAlive: () => false, currentMachineId: 'machine-a' });
  await reclaimed.release();
});
