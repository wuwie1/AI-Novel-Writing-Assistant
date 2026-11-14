import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { localProxyLifecycle } from '../application/lifecycle.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'proxy-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'proxy'));
  await writeFile(path.join(root, 'proxy/config.toml'), '[openai]\nurl="https://example.com/v1"\n');
  const processes = new Map(); const signals = []; const launches = [];
  let pid = 100; let owner; let failRemote = false; let failLocal = false;
  const adapters = {
    readArgv: async id => processes.get(id), wait: async () => {},
    signalProcess: (id, signal) => { signals.push([id, signal]); processes.delete(id); },
    spawnProcess: (command, args, options) => {
      const child = Object.assign(new EventEmitter(), { pid: ++pid, unref() {} });
      processes.set(pid, [command, ...args]); launches.push({ pid, command, args, options });
      if (args[0].endsWith('server.mjs')) owner = args[1];
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    request: async () => Response.json({ service: 'ai-novel-local-proxy', owner: failLocal ? 'foreign' : owner }),
    execute: async (_command, args) => {
      if (args.includes('-G')) return { stdout: 'host server\nhostname server\nuser writer\nport 22\nlocalforward 80 localhost:80\n' };
      const target = args.at(-2);
      if (![...processes.values()].some(argv => argv[0] === 'autossh' && argv.at(-1) === target)) {
        return { stdout: '\n__AI_NOVEL_PROXY_HEALTH__\n' };
      }
      if (failRemote) throw new Error('remote unavailable');
      return { stdout: `LISTEN 0 128 127.0.0.1:14000 0.0.0.0:*\n__AI_NOVEL_PROXY_HEALTH__\n${JSON.stringify({ service: 'ai-novel-local-proxy', owner })}` };
    },
  };
  const config = { repoRealPath: root, sshTarget: 'server' };
  return { root, processes, signals, launches, config, adapters,
    lifecycle: localProxyLifecycle(config, adapters), failRemote: () => { failRemote = true; }, failLocal: () => { failLocal = true; } };
}

test('start is idempotent, status is read-only and restart/stop signal only recorded processes', async t => {
  const f = await fixture(t);
  assert.equal((await f.lifecycle.control('start')).status, 'started');
  assert.equal((await f.lifecycle.control('start')).status, 'ready');
  assert.equal((await f.lifecycle.control('status')).status, 'ready');
  assert.equal(f.launches.length, 2);
  assert.deepEqual(f.signals, []);
  for (const entry of f.launches) assert.equal(entry.options.stdio, 'ignore');
  assert.ok(f.launches[1].args.includes('127.0.0.1:14000:127.0.0.1:14000'));
  assert.equal(f.launches[1].options.env.AUTOSSH_LOGFILE, undefined);
  const owner = JSON.parse(await readFile(path.join(f.root, '.runtime/local-proxy/state.json'))).owner;
  await f.lifecycle.control('restart');
  assert.deepEqual(f.signals, [[102, 'SIGTERM'], [101, 'SIGTERM']]);
  assert.notEqual(JSON.parse(await readFile(path.join(f.root, '.runtime/local-proxy/state.json'))).owner, owner);
  await f.lifecycle.control('stop');
  assert.equal(f.processes.size, 0);
  await f.lifecycle.control('stop');
  assert.equal(f.signals.length, 4);
});

test('PID reuse never terminates an unrelated process, even when stopping', async t => {
  const f = await fixture(t); await f.lifecycle.control('start');
  f.processes.set(101, ['/usr/bin/node', '/other/service.mjs']);
  f.processes.set(102, ['/usr/bin/autossh', '-M', '0', 'other-server']);
  await f.lifecycle.control('stop');
  assert.deepEqual(f.signals, []);
  assert.equal(f.processes.size, 2);
});

test('failed reverse connection rolls back newly created processes without leaking raw errors', async t => {
  const f = await fixture(t); f.failRemote();
  await assert.rejects(f.lifecycle.control('start'), /服务器反向通道检查未完成/);
  assert.equal(f.processes.size, 0);
  assert.deepEqual(f.signals, [[102, 'SIGTERM'], [101, 'SIGTERM']]);
});

test('a foreign local listener is rejected before a reverse tunnel is started', async t => {
  const f = await fixture(t); f.failLocal();
  await assert.rejects(f.lifecycle.control('start'), /本机代理未启动/);
  assert.equal(f.launches.length, 1);
  assert.equal(f.processes.size, 0);
});

test('a server forcing the reverse port onto all interfaces is refused and rolled back', async t => {
  const f = await fixture(t);
  const execute = f.adapters.execute;
  f.adapters.execute = async (...args) => {
    const response = await execute(...args);
    return { stdout: response.stdout.replace('127.0.0.1:14000', '0.0.0.0:14000') };
  };
  await assert.rejects(localProxyLifecycle(f.config, f.adapters).control('start'), /GatewayPorts=no/);
  assert.equal(f.processes.size, 0);
});

test('configuration changes require explicit restart and broken config never prevents stop', async t => {
  const f = await fixture(t); await f.lifecycle.control('start');
  await writeFile(path.join(f.root, 'proxy/config.toml'), '[openai]\nurl="https://second.example.com/v1"\n');
  await assert.rejects(f.lifecycle.control('start'), /ssh_restart_server/);
  assert.equal(f.signals.length, 0);
  await writeFile(path.join(f.root, 'proxy/config.toml'), 'broken = ');
  await f.lifecycle.control('stop');
  assert.equal(f.processes.size, 0);
});

test('changing SSH destination replaces only the owned reverse tunnel', async t => {
  const f = await fixture(t); await f.lifecycle.control('start');
  const switched = localProxyLifecycle({ ...f.config, sshTarget: 'second-server' }, f.adapters);
  assert.equal((await switched.control('start')).status, 'started');
  assert.equal(f.launches.length, 3);
  assert.deepEqual(f.signals, [[102, 'SIGTERM']]);
  assert.equal(f.launches[2].args.at(-1), 'second-server');
});

test('an existing proxy from another workspace is diagnosed before launching or stopping anything', async t => {
  const f = await fixture(t);
  f.adapters.execute = async () => ({ stdout: 'LISTEN 0 128 127.0.0.1:14000 0.0.0.0:*\n__AI_NOVEL_PROXY_HEALTH__\n'
    + JSON.stringify({ service: 'ai-novel-local-proxy', owner: 'another-workspace' }) });
  const lifecycle = localProxyLifecycle(f.config, f.adapters);
  await assert.rejects(lifecycle.control('start'), /另一台电脑或另一个工作区.*原电脑.*make ssh_stop_server/);
  assert.deepEqual(f.launches, []);
  assert.deepEqual(f.signals, []);
  const state = JSON.parse(await readFile(path.join(f.root, '.runtime/local-proxy/state.json')));
  assert.equal(state.proxy, undefined);
  assert.equal(state.tunnel, undefined);
  const status = await lifecycle.control('status');
  assert.equal(status.status, 'unavailable');
  assert.match(status.reason, /另一台电脑或另一个工作区/);
});

test('a conflict on a new SSH destination preserves the existing proxy and tunnel', async t => {
  const f = await fixture(t);
  await f.lifecycle.control('start');
  const execute = f.adapters.execute;
  f.adapters.execute = async (...args) => {
    if (args[1].at(-2) !== 'second-server') return execute(...args);
    return { stdout: 'LISTEN 0 128 127.0.0.1:14000 0.0.0.0:*\n__AI_NOVEL_PROXY_HEALTH__\n{"service":"other"}' };
  };
  const switched = localProxyLifecycle({ ...f.config, sshTarget: 'second-server' }, f.adapters);
  await assert.rejects(switched.control('start'), /非本次管理的连接占用/);
  assert.equal(f.launches.length, 2);
  assert.deepEqual(f.signals, []);
  assert.equal((await f.lifecycle.control('status')).status, 'ready');
});

test('a port claimed between preflight and startup rolls back only the new processes', async t => {
  const f = await fixture(t);
  const execute = f.adapters.execute;
  f.adapters.execute = async (...args) => {
    const response = await execute(...args);
    return { stdout: response.stdout.replace(/"owner":"[^"]+"/, '"owner":"foreign-owner"') };
  };
  await assert.rejects(localProxyLifecycle(f.config, f.adapters).control('start'), /另一台电脑或另一个工作区/);
  assert.deepEqual(f.signals, [[102, 'SIGTERM'], [101, 'SIGTERM']]);
  assert.equal(f.processes.size, 0);
});

test('preflight SSH failure reports connection diagnosis without leaking command output', async t => {
  const f = await fixture(t);
  f.adapters.execute = async () => { throw Object.assign(new Error('secret connection details'), { code: 255 }); };
  await assert.rejects(localProxyLifecycle(f.config, f.adapters).control('start'), error => {
    assert.match(error.message, /SSH 健康检查连接失败/);
    assert.doesNotMatch(error.message, /secret|GatewayPorts/);
    return true;
  });
  assert.deepEqual(f.launches, []);
});

test('restart tolerates the remote listener briefly outliving its verified SSH process', async t => {
  const f = await fixture(t);
  await f.lifecycle.control('start');
  const execute = f.adapters.execute;
  let closing = true;
  f.adapters.execute = async (...args) => {
    if (closing && f.processes.size === 0) {
      closing = false;
      throw Object.assign(new Error('curl target closed'), { code: 71,
        stdout: 'LISTEN 0 128 127.0.0.1:14000 0.0.0.0:*\n__AI_NOVEL_PROXY_HEALTH__\n' });
    }
    return execute(...args);
  };
  assert.equal((await localProxyLifecycle(f.config, f.adapters).control('restart')).status, 'started');
  assert.equal(closing, false);
  assert.equal(f.launches.length, 4);
  assert.deepEqual(f.signals, [[102, 'SIGTERM'], [101, 'SIGTERM']]);
});
