import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureWebTunnel, loadWebConfig } from '../../infra/server/tunnel/ensure.mjs';
import { webHealthy } from '../../infra/server/tunnel/local.mjs';
import { defaultConfigValues } from '../infrastructure/processes/config.mjs';

const config = { ...defaultConfigValues, repoRealPath: '/test/checkout' };
const primary = config.tunnelPort;
const alternate = 15176;
const ready = { owner: 'web', manager: 8 };
const free = { owner: 'free', manager: null };

test('the saved independent server is respected unless desktop settings or an explicit target override it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'web-tunnel-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.runtime/tunnel'), { recursive: true });
  await writeFile(path.join(root, '.runtime/tunnel/target'), 'writer@127.0.0.10\n');
  assert.equal((await loadWebConfig(root, {})).sshTarget, 'writer@127.0.0.10');
  await mkdir(path.join(root, '.runtime/desktop_mac'));
  await writeFile(path.join(root, '.runtime/desktop_mac/config.json'), '{"sshTarget":"writer@127.0.0.11"}', { mode: 0o600 });
  assert.equal((await loadWebConfig(root, {})).sshTarget, 'writer@127.0.0.11');
  assert.equal((await loadWebConfig(root, { SSH_TARGET: 'web-profile' })).sshTarget, 'web-profile');
});

function fixture(initial, afterControl = ready) {
  const ports = new Map(initial);
  const actions = [];
  const io = {
    inspect: async (port) => ports.get(port) ?? free,
    healthy: async () => true,
    control: async (action, port) => { actions.push([action, port]); ports.set(port, afterControl); },
  };
  return { io, actions, ports };
}

test('an independent healthy Web tunnel returns its URL without restarting', async () => {
  const { io, actions } = fixture([[primary, ready]]);
  const result = await ensureWebTunnel(config, io);
  assert.equal(result.url, 'http://127.0.0.1:15173/');
  assert.equal(result.status, 'ready');
  assert.deepEqual(actions, []);
});

test('missing tunnel starts; a retrying manager without a listener recovers', async () => {
  for (const [initial, action] of [[free, 'start'], [{ owner: 'free', manager: 9 }, 'restart'], [{ owner: 'stale', manager: 9 }, 'restart']]) {
    const { io, actions } = fixture([[primary, initial]]);
    await ensureWebTunnel(config, io);
    assert.deepEqual(actions, [[action, primary]]);
  }
});

test('a failed Web probe restarts the verified manager once and rechecks', async () => {
  const { io, actions } = fixture([[primary, ready]]);
  let probes = 0;
  io.healthy = async () => ++probes === 2;
  assert.equal((await ensureWebTunnel(config, io)).status, 'restored');
  assert.deepEqual(actions, [['restart', primary]]);
  io.healthy = async () => false;
  await assert.rejects(ensureWebTunnel(config, io), /未通过网页和 API 检查/);
});

test('a desktop-first session keeps its own forward and the independent browser address survives its exit', async () => {
  const { io, actions, ports } = fixture([[primary, { owner: 'desktop' }]]);
  const opened = await ensureWebTunnel(config, io);
  assert.equal(opened.port, alternate);
  assert.deepEqual(actions, [['start', alternate]]);
  ports.delete(primary); // stop_app releases only its own tunnel.
  assert.equal((await ensureWebTunnel(config, io, opened.port)).url, opened.url);
  assert.deepEqual(actions, [['start', alternate]]);
});

test('an unrelated listener is never stopped or accepted, including on the alternate port', async () => {
  for (const entries of [[[primary, { owner: 'other' }]], [[primary, { owner: 'desktop' }], [alternate, { owner: 'other' }]]]) {
    const { io, actions } = fixture(entries);
    await assert.rejects(ensureWebTunnel(config, io), /由其他进程使用/);
    assert.deepEqual(actions, []);
  }
  const { io } = fixture([], { owner: 'desktop' });
  await assert.rejects(ensureWebTunnel(config, io), /未通过网页和 API 检查/);
});

test('readiness requires an HTML homepage and the application health response', async () => {
  const probe = (page, health) => webHealthy('http://127.0.0.1:15173/', async (url) => new URL(url).pathname === '/' ? page : health);
  const page = (status = 200) => new Response('<!doctype html><html lang="zh"></html>', { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const health = () => Response.json({ success: true, data: { status: 'ok' } });
  assert.equal(await probe(page(), health()), true);
  assert.equal(await probe(page(503), health()), false);
  assert.equal(await probe(new Response('OK'), health()), false);
  assert.equal(await probe(page(), page()), false);
  assert.equal(await probe(page(), Response.json({ success: false, data: { status: 'ok' } })), false);
});
