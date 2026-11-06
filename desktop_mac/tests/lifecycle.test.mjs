import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLifecycle } from '../application/lifecycle/index.mjs';
import { readState, writeState, acquireLock } from '../infrastructure/processes/lock.mjs';
import { processMatches, signalOwnedProcess, stableHash } from '../infrastructure/processes/identity.mjs';

async function setup(t, overrides = {}) {
  const repoRealPath = await mkdtemp(path.join(os.tmpdir(), 'mac-life-'));
  t.after(() => rm(repoRealPath, { recursive: true, force: true }));
  const calls = [];
  let ready = true;
  let failPrepare = false;
  let cancelClose = false;
  const adapters = {
    nativeStatus: async (current) => current?.runningMode ? ({ rendererReady: ready, repo: repoRealPath, mode: current.runningMode, backendIdentity: current.backendIdentity, pid: current.processes?.app?.pid }) : null, focus: async () => calls.push('focus'),
    requestNativeClose: async () => ({ ok: !cancelClose }), waitAppExited: async () => calls.push('waitExit'),
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

test('failed health check preserves a new window that refuses close and does not roll another window over it', async (t) => {
  let failHealth = false;
  let lastMode;
  const ctx = await setup(t, {
    openNative: async ({ mode }) => { lastMode = mode; return { process: { ownership: 'owned', mode } }; },
    waitHealthy: async () => { if (failHealth) throw new Error('health failed'); },
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
