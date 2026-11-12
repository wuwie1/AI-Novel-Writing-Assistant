import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readProcessArgv } from '../../desktop_mac/infrastructure/processes/argv.mjs';
import { writeState } from '../../desktop_mac/infrastructure/processes/lock.mjs';
import { loadProxyConfig, PROXY_BASE_URL, PROXY_PORT } from '../infrastructure/config.mjs';

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const forward = `127.0.0.1:${PROXY_PORT}:127.0.0.1:${PROXY_PORT}`;

export function ownedProcess(record, argv) {
  return Boolean(record && Array.isArray(argv) && argv.length === record.args.length + 1
    && path.basename(argv[0]) === record.executable
    && record.args.every((arg, index) => arg === argv[index + 1]));
}

export function isolatedSshProfile(profile, target) {
  const lines = profile.split(/\r?\n/).filter(line => !/^(localforward|remoteforward|dynamicforward)\s/.test(line));
  // Preserve jump-host identity from the original configuration without importing its forwards here.
  return `${lines.join('\n')}\nHost * !${target.split('@').at(-1)}\n  Include ~/.ssh/config /etc/ssh/ssh_config\n`;
}

export function localProxyLifecycle(config, {
  execute = exec, readArgv = readProcessArgv, request = fetch, spawnProcess = spawn,
  signalProcess = (pid, signal) => process.kill(pid, signal), wait = pause,
} = {}) {
  const root = config.repoRealPath;
  const runtime = path.join(root, '.runtime/local-proxy');
  const stateFile = path.join(runtime, 'state.json');
  const serverScript = path.join(root, 'proxy/server.mjs');

  async function state() {
    try {
      const value = JSON.parse(await readFile(stateFile, 'utf8'));
      if (value.root !== root || !value.owner || value.version !== 1) throw new Error();
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, root, owner: randomUUID() };
      throw new Error('本机代理的进程归属记录无效，请检查 .runtime/local-proxy/state.json。');
    }
  }
  async function alive(record) {
    return record && ownedProcess(record, await readArgv(record.pid));
  }
  async function stopRecord(record) {
    if (!await alive(record)) return;
    try { signalProcess(record.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (let i = 0; i < 50; i++) { if (!await alive(record)) return; await wait(100); }
    throw new Error('本机代理或反向通道仍在停止中；未强制终止进程。');
  }
  async function launch(command, args, env = process.env) {
    const child = spawnProcess(command, args, { cwd: root, env, detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { pid: child.pid, executable: path.basename(command), args };
  }
  async function localHealth(owner) {
    try {
      const response = await request(`http://127.0.0.1:${PROXY_PORT}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      const value = await response.json();
      return response.ok && value.service === 'ai-novel-local-proxy' && value.owner === owner;
    } catch { return false; }
  }
  async function remoteHealth(owner) {
    try {
      const { stdout } = await execute('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes',
        '-o', 'ConnectTimeout=5', config.sshTarget,
        `ss -H -ltn 'sport = :${PROXY_PORT}' && curl --noproxy '*' -fsS --max-time 3 http://127.0.0.1:${PROXY_PORT}/health`], { timeout: 10_000 });
      const lines = stdout.trim().split('\n');
      const value = JSON.parse(lines.pop());
      // GatewayPorts=yes can override -R's requested bind address. Refuse a public listener.
      if (!lines.length || lines.some(line => ![`127.0.0.1:${PROXY_PORT}`, `[::1]:${PROXY_PORT}`].includes(line.trim().split(/\s+/)[3]))) return false;
      return value.service === 'ai-novel-local-proxy' && value.owner === owner;
    } catch { return false; }
  }

  async function control(action) {
    const current = await state();
    if (action === 'stop' || action === 'restart') {
      // Disconnect the server before stopping the local target. Never signal unverified PIDs.
      await stopRecord(current.tunnel);
      await stopRecord(current.proxy);
      delete current.tunnel; delete current.proxy;
      await writeState(stateFile, current);
      if (action === 'stop') return { status: 'stopped', url: PROXY_BASE_URL };
    }
    if (action === 'status') {
      const ready = await alive(current.proxy) && await alive(current.tunnel)
        && await localHealth(current.owner) && await remoteHealth(current.owner);
      return { status: ready ? 'ready' : 'unavailable', url: PROXY_BASE_URL };
    }
    const proxyConfig = await loadProxyConfig(path.join(root, 'proxy/config.toml'));
    const signature = createHash('sha256').update(JSON.stringify(proxyConfig)).digest('hex');
    const proxyAlive = await alive(current.proxy);
    if (proxyAlive && signature !== current.signature) {
      throw new Error('本机代理配置已修改，请运行 make ssh_restart_server 使其生效。');
    }
    let startedProxy = false;
    let startedTunnel = false;
    try {
      if (!proxyAlive) {
        // Give each new process its own identity so a stale remote listener cannot pass readiness.
        await stopRecord(current.tunnel);
        delete current.tunnel;
        current.owner = randomUUID();
        current.proxy = await launch(process.execPath, [serverScript, current.owner]);
        startedProxy = true;
        current.signature = signature;
        await writeState(stateFile, current);
        for (let i = 0; i < 30 && !await localHealth(current.owner); i++) {
          if (!await alive(current.proxy)) break;
          await wait(100);
        }
      }
      if (!await alive(current.proxy) || !await localHealth(current.owner)) {
        throw new Error(`本机代理未启动，请检查配置及本机端口 ${PROXY_PORT} 是否被占用。`);
      }
      if (await alive(current.tunnel) && current.target !== config.sshTarget) {
        await stopRecord(current.tunnel);
        delete current.tunnel;
      }
      if (!await alive(current.tunnel)) {
        await mkdir(runtime, { recursive: true, mode: 0o700 });
        const profileFile = path.join(runtime, `ssh-${current.owner}.conf`);
        const { stdout } = await execute('/usr/bin/ssh', ['-G', config.sshTarget], { timeout: 5000 });
        await writeFile(profileFile, isolatedSshProfile(stdout, config.sshTarget), { mode: 0o600 });
        const args = ['-M', '0', '-N', '-T', '-R', forward, '-F', profileFile,
          '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
          '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=5', '-o', 'ControlMaster=no',
          '-o', 'ControlPath=none', '-o', 'ClearAllForwardings=no', '-o', 'PermitLocalCommand=no', config.sshTarget];
        const env = { ...process.env, AUTOSSH_GATETIME: '0', AUTOSSH_POLL: '15' };
        // Inherited autossh logging/PID options must not leak into this independent manager.
        delete env.AUTOSSH_LOGFILE; delete env.AUTOSSH_PIDFILE; delete env.AUTOSSH_DEBUG;
        current.tunnel = await launch('autossh', args, env);
        startedTunnel = true;
        current.target = config.sshTarget;
        await writeState(stateFile, current);
      }
      for (let i = 0; i < 3; i++) {
        if (await remoteHealth(current.owner)) return { status: startedProxy || startedTunnel ? 'started' : 'ready', url: PROXY_BASE_URL };
        await wait(500);
      }
      throw new Error(`服务器无法通过回环反向通道连接本机代理，请检查 SSH 转发权限、GatewayPorts=no 及远端端口 ${PROXY_PORT}。`);
    } catch (error) {
      // Roll back only processes created by this attempt, preserving pre-existing working services.
      if (startedTunnel) { await stopRecord(current.tunnel); delete current.tunnel; }
      if (startedProxy) { await stopRecord(current.proxy); delete current.proxy; }
      await writeState(stateFile, current);
      // Do not print exec errors, SSH profiles, upstream URLs or model credentials.
      throw new Error(error.message.startsWith('本机') || error.message.startsWith('服务器')
        ? error.message : '无法启动本机代理通道，请确认免密 SSH 可用且本机已安装 autossh。');
    }
  }
  return { control };
}
