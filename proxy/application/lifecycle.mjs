import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readProcessArgv } from '../../desktop_mac/infrastructure/processes/argv.mjs';
import { writeState } from '../../desktop_mac/infrastructure/processes/lock.mjs';
import { loadProxyConfig, PROXY_BASE_URL, PROXY_PORT } from '../infrastructure/config.mjs';
import { inspectRemoteProxy } from '../infrastructure/remote-probe.mjs';

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const forward = `127.0.0.1:${PROXY_PORT}:127.0.0.1:${PROXY_PORT}`;

function remoteFailure(status) {
  if (status === 'foreign_proxy') return `服务器端口 ${PROXY_PORT} 被另一台电脑或另一个工作区的模型代理占用。请在原电脑的对应工作区运行 make ssh_stop_server，再在本机运行 make ssh_server；如需保留原连接，请继续使用原代理。`;
  if (status === 'occupied' || status === 'ready') return `服务器端口 ${PROXY_PORT} 被非本次管理的连接占用。请确认连接归属并在原启动位置停止后重试。`;
  if (status === 'unsafe') return `服务器端口 ${PROXY_PORT} 未仅绑定回环地址，请检查 GatewayPorts=no。`;
  if (status === 'ssh_failed') return '服务器 SSH 健康检查连接失败，请检查网络与免交互 SSH 登录。';
  if (status === 'probe_failed') return '服务器反向通道检查未完成，请检查 SSH 连接及远端 ss、curl 命令是否可用。';
  if (status === 'unresponsive') return `服务器端口 ${PROXY_PORT} 存在监听，但本机代理健康检查未通过，请检查通道目标及本机代理。`;
  return `服务器反向通道未建立，端口 ${PROXY_PORT} 没有监听，请检查 SSH 远程转发权限及 autossh 连接。`;
}

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
  const remoteStatus = owner => inspectRemoteProxy(config.sshTarget, owner, execute);

  async function control(action) {
    const current = await state();
    let stoppedOwnedTunnel = false;
    if (action === 'stop' || action === 'restart') {
      // Disconnect the server before stopping the local target. Never signal unverified PIDs.
      stoppedOwnedTunnel = await alive(current.tunnel);
      await stopRecord(current.tunnel);
      await stopRecord(current.proxy);
      delete current.tunnel; delete current.proxy;
      await writeState(stateFile, current);
      if (action === 'stop') return { status: 'stopped', url: PROXY_BASE_URL };
    }
    if (action === 'status') {
      const localReady = await alive(current.proxy) && await alive(current.tunnel) && await localHealth(current.owner);
      const remote = await remoteStatus(current.owner);
      return { status: localReady && remote === 'ready' ? 'ready' : 'unavailable', url: PROXY_BASE_URL,
        reason: remote === 'ready' && localReady ? undefined : remoteFailure(remote) };
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
      // Check before launching anything when no verified tunnel owns this destination.
      // A different owner is not reusable: its upstream and credentials contract may differ.
      if (!await alive(current.tunnel) || current.target !== config.sshTarget) {
        let remote = await remoteStatus(current.owner);
        // sshd may need a moment to release a just-closed, verified connection.
        for (let i = 0; i < 3 && stoppedOwnedTunnel && current.target === config.sshTarget
          && ['ready', 'unresponsive'].includes(remote); i++) {
          await wait(500);
          remote = await remoteStatus(current.owner);
        }
        if (remote !== 'free') throw new Error(remoteFailure(remote === 'unresponsive' ? 'occupied' : remote));
      }
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
      let remote;
      for (let i = 0; i < 3; i++) {
        remote = await remoteStatus(current.owner);
        if (remote === 'ready') return { status: startedProxy || startedTunnel ? 'started' : 'ready', url: PROXY_BASE_URL };
        if (remote === 'foreign_proxy' || remote === 'unsafe') break;
        await wait(500);
      }
      throw new Error(remoteFailure(remote));
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
