import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRepoPaths, loadConfig } from '../../../desktop_mac/infrastructure/processes/config.mjs';
import { acquireLock, writeState } from '../../../desktop_mac/infrastructure/processes/lock.mjs';
import { resolveSshEndpoint } from '../../../desktop_mac/infrastructure/transport/ssh-identity.mjs';
import { localTunnel } from './local.mjs';

function alternatePort(config) {
  // Skip ports reserved by the desktop even when its windows are closed.
  const reserved = new Set([config.localApiPort, config.devUiPort, config.appUiPort, config.remoteWebPort,
    config.maintenanceProbePort, config.qdrantTunnelPort]);
  let port = config.tunnelPort;
  do { port = port === 65535 ? 1024 : port + 1; } while (reserved.has(port));
  return port;
}

export async function ensureWebTunnel(config, io, rememberedPort, action = 'start') {
  const primary = config.tunnelPort;
  const alternate = alternatePort(config);
  let port = rememberedPort === alternate ? alternate : primary;
  let state = await io.inspect(port);
  if (port === primary && state.owner === 'desktop') {
    port = alternate;
    state = await io.inspect(port);
  }
  return manageForward(config, io, 'web', port, state, action);
}

export async function ensureQdrantTunnel(config, io, action = 'start') {
  const port = config.qdrantTunnelPort;
  if ([config.tunnelPort, config.localApiPort, config.appUiPort, config.devUiPort].includes(port)) {
    throw new Error(`端口 ${port} 已分配给 Web 或桌面，请用 QDRANT_TUNNEL_PORT 指定空闲端口。`);
  }
  return manageForward(config, io, 'qdrant', port, await io.inspect(port), action);
}

async function manageForward(config, io, service, port, state, action) {
  const isWeb = service === 'web';
  const url = `http://127.0.0.1:${port}${isWeb ? '/' : '/dashboard/'}`;
  const label = isWeb ? '独立 Web 隧道' : 'Qdrant 隧道';
  const log = path.join(config.repoRealPath, '.logs', isWeb ? 'tunnel.log' : 'qdrant-tunnel.log');
  const result = status => ({ url, port, status });
  if (action === 'stop') {
    if (state.manager) await io.control('stop', port);
    return result('stopped');
  }
  if (state.owner === 'other' || state.owner === 'desktop') {
    throw new Error(`端口 ${port} 由其他进程使用。请用 ${isWeb ? 'TUNNEL_PORT' : 'QDRANT_TUNNEL_PORT'} 指定空闲端口后重试。`);
  }
  if (state.owner === service && action !== 'restart') {
    if (await io.healthy(url)) return result('ready');
    // A working SSH listener can outlive an optional Qdrant instance.
    if (!isWeb) return result('unavailable');
  }
  if (action === 'status') throw new Error(`${label}尚未就绪，请运行 make ssh_server 检查连接。日志 ${log}`);

  const operation = state.manager ? 'restart' : 'start';
  try { await io.control(operation, port); }
  catch (error) { throw new Error(`${label}连接失败。${error.stderr?.trim() || error.message}（日志 ${log}）`); }
  if ((await io.inspect(port)).owner === service) {
    if (await io.healthy(url)) return result(operation === 'restart' ? 'restored' : 'started');
    if (!isWeb) return result('unavailable');
  }
  throw new Error(`${label}未通过${isWeb ? '网页和 API 检查' : '转发归属检查'}，请检查 SSH 连接和远端服务。日志 ${log}`);
}

export async function loadWebConfig(repoRoot, environment = process.env) {
  const env = {
    ...environment,
    SSH_TARGET: environment.SSH_TARGET || environment.AI_NOVEL_SSH_TARGET,
    TUNNEL_PORT: environment.TUNNEL_PORT || environment.AI_NOVEL_LOCAL_PORT,
    REMOTE_WEB_PORT: environment.REMOTE_WEB_PORT || environment.AI_NOVEL_REMOTE_PORT,
  };
  const config = await loadConfig({ repoRoot, env });
  if (env.SSH_TARGET) return config;
  let saved;
  try { saved = (await readFile(path.join(config.repoRealPath, '.runtime/tunnel/target'), 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!saved || saved === config.sshTarget) return config;
  const legacy = await loadConfig({ repoRoot, env, fallbackSshTarget: saved });
  if (legacy.sshTarget === config.sshTarget) return config; // Explicit desktop config wins.
  const [desktop, web] = await Promise.all([resolveSshEndpoint(config.sshTarget), resolveSshEndpoint(legacy.sshTarget)]);
  // Use the desktop profile for an equivalent endpoint; a legacy alias may also forward unrelated ports.
  return JSON.stringify(desktop) === JSON.stringify(web) ? config : legacy;
}

async function main() {
  const action = process.argv[2] ?? 'start';
  if (!['start', 'stop', 'restart', 'status'].includes(action)) throw new Error('Usage: tunnel.sh start|stop|restart|status|pid');
  const config = await loadWebConfig(fileURLToPath(new URL('../../../', import.meta.url)));
  if (Math.min(config.tunnelPort, config.remoteWebPort, config.qdrantTunnelPort, config.remoteQdrantPort) < 1024) {
    throw new Error('隧道端口需在 1024 到 65535 之间。');
  }
  const { lifecycleLock } = getRepoPaths(config.repoRealPath);
  const guard = await acquireLock(lifecycleLock, { repoRealPath: config.repoRealPath, operation: 'ssh_server' });
  try {
    const portFile = path.join(config.repoRealPath, '.runtime/tunnel', `${config.tunnelPort}.browser-port`);
    let rememberedPort;
    try { rememberedPort = Number((await readFile(portFile, 'utf8')).trim()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const message = { ready: '通畅', started: '已建立', restored: '已恢复' };
    try {
      const { port, url, status } = await ensureWebTunnel(config, localTunnel(config), rememberedPort, action);
      if (['start', 'restart'].includes(action) && port !== config.tunnelPort && port !== rememberedPort) await writeState(portFile, port);
      console.log(status === 'stopped' ? '独立 Web 隧道已停止。' : `独立 Web 隧道${message[status]}，浏览器访问 ${url}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
    const { url, status } = await ensureQdrantTunnel(config, localTunnel(config, 'qdrant'), action);
    if (status === 'unavailable') {
      console.warn(`Qdrant 隧道已连接，管理页尚未就绪。请检查服务器的 Qdrant 服务（端口 ${config.remoteQdrantPort}）。`);
    } else {
      console.log(status === 'stopped' ? 'Qdrant 隧道已停止。' : `Qdrant 隧道${message[status]}，管理页 ${url}`);
    }
  } finally { await guard.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.lockBusy ? '桌面连接命令正在运行，请稍后重试 make ssh_server。' : error.message);
    process.exitCode = error.exitCode ?? 1;
  });
}
