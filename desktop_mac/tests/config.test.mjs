import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, getRepoPaths } from '../infrastructure/processes/config.mjs';
import { backendIdentity } from '../infrastructure/processes/identity.mjs';

test('config defaults, JSON and environment priority are validated', async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'mac-config-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await mkdir(path.join(repoRoot, '.runtime/desktop_mac'), { recursive: true });
  await writeFile(path.join(repoRoot, '.runtime/desktop_mac/config.json'), JSON.stringify({ devUiPort: 17000, sshTarget: 'deploy@example.test' }), { mode: 0o600 });
  const config = await loadConfig({ repoRoot, env: { DEV_UI_PORT: '17001' } });
  assert.equal(config.devUiPort, 17001);
  assert.equal(config.appUiPort, 15175);
  assert.equal(config.sshTarget, 'deploy@example.test');
  assert.equal(config.repoRealPath, await import('node:fs/promises').then(({ realpath }) => realpath(repoRoot)));
  assert.equal(getRepoPaths(config.repoRealPath).stateFile, path.join(config.repoRealPath, '.runtime/desktop_mac/state.json'));
});

test('backend identity follows the data source rather than local listener ports', () => {
  const repoRealPath = '/repo';
  const localA = backendIdentity({ mode: 'local', repoRealPath, target: 'server/dev.db' });
  const localB = backendIdentity({ mode: 'local', repoRealPath, target: 'server/dev.db' });
  const differentLocalDb = backendIdentity({ mode: 'local', repoRealPath, target: 'server/other.db' });
  const remoteTarget = ['root@host', '/data/book', '18080'].join('\0');
  const remoteA = backendIdentity({ mode: 'remote', repoRealPath, target: remoteTarget });
  const remoteB = backendIdentity({ mode: 'remote', repoRealPath, target: remoteTarget });
  assert.equal(localA, localB);
  assert.notEqual(localA, differentLocalDb);
  assert.equal(remoteA, remoteB);
});

test('config rejects duplicate ports and unsafe SSH arguments', async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'mac-config-invalid-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await assert.rejects(loadConfig({ repoRoot, env: { DEV_UI_PORT: '15175' } }), { exitCode: 2 });
  await assert.rejects(loadConfig({ repoRoot, env: { SSH_TARGET: 'host;rm -rf /' } }), { exitCode: 2 });
  await assert.rejects(loadConfig({ repoRoot, env: { LOCAL_API_PORT: '0' } }), { exitCode: 2 });
});
