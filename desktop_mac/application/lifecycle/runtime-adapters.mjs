import { execFile, spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { prepareDesktopBuild } from '../../infrastructure/builds/index.mjs';
import { runUntimed } from './timings.mjs';
export { sourceFingerprint } from '../../infrastructure/builds/index.mjs';
import { ensureRendererDependencies } from '../../infrastructure/dependencies/renderer.mjs';
import { appendRoleLog } from '../../infrastructure/processes/logging.mjs';
import { createLaunchdPlist, isMissingAgent, launchAgent, launchdLabel, printAgent, stopAgent, waitForAgentIdentity } from '../../infrastructure/processes/launchd.mjs';
import { inspectProcess, processMatches, stableHash } from '../../infrastructure/processes/identity.mjs';
import { readProcessArgv } from '../../infrastructure/processes/argv.mjs';
import { nativeSocketPath, sendNativeCommand } from '../../infrastructure/processes/native-socket.mjs';
import { backendIdentity as makeBackendIdentity } from '../../infrastructure/processes/identity.mjs';
import { inspectSqliteQuiescence, resolveLocalDatabasePath } from '../../infrastructure/processes/quiescence.mjs';
import { selectServerNode } from '../../infrastructure/processes/launchers/server-node.mjs';
import { tunnelMatches } from '../../infrastructure/transport/ssh-identity.mjs';

const exec = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const internalError = (message, exitCode = 5) => Object.assign(new Error(message), { exitCode });

function requireMacOS() {
  if (process.platform !== 'darwin') throw internalError('Mac lifecycle commands require macOS', 2);
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      const owners = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim().split(/\s+/).filter(Boolean);
      reject(internalError(`Port ${port} is unavailable${owners.length ? ` (pid ${owners.join(', ')})` : ''}; no process was stopped`, 4));
    });
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

function absolutePnpm() {
  const result = spawnSync('/usr/bin/which', ['pnpm'], { encoding: 'utf8' });
  const pnpm = result.stdout.trim();
  if (result.status !== 0 || !path.isAbsolute(pnpm)) throw internalError('pnpm was not found in the current PATH; install the repository-pinned pnpm and retry', 2);
  return pnpm;
}

function parsePid(output) {
  const match = output.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

async function validateLocalDatabase(repoRoot) {
  let resolved;
  try { resolved = await resolveLocalDatabasePath({ repoRoot }); }
  catch (error) { throw internalError(`Local database could not be verified: ${error.message}`, 2); }
  let info;
  try { info = await stat(resolved); } catch { throw internalError('The local SQLite test database is missing; no migration or database creation was attempted', 2); }
  if (!info.isFile() || info.size === 0) throw internalError('The local SQLite test database is empty or not a regular file; no database maintenance was attempted', 2);
  return resolved;
}

function listenPid(port) {
  const output = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  return output.status === 0 ? output.stdout.trim().split(/\s+/).map(Number).filter(Number.isInteger) : [];
}

async function workingDirectory(pid) {
  const result = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  return result.stdout.split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1) ?? null;
}

export function createRuntimeAdapters(config, measure = runUntimed) {
  const repoRoot = config.repoRealPath;
  const runtime = path.join(repoRoot, '.runtime/desktop_mac');
  const logs = path.join(repoRoot, '.logs/desktop_mac');
  const agents = path.join(runtime, 'agents');
  const pnpm = absolutePnpm();
  const pathValue = [path.dirname(process.execPath), path.dirname(pnpm), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const createdRecords = new Set();

  const unload = (label, role) => measure(`等待服务注销 ${role}`, () => stopAgent(label));

  async function startAgent({ role, mode, executable, args, workingDirectory = repoRoot, environment = {} }) {
    const label = launchdLabel({ repoRealPath: repoRoot, mode, role });
    const outPath = path.join(logs, `${role}.log`); const errPath = path.join(logs, `${role}.error.log`);
    await mkdir(agents, { recursive: true, mode: 0o700 }); await mkdir(logs, { recursive: true, mode: 0o700 });
    await writeFile(outPath, '', { flag: 'a', mode: 0o600 }); await writeFile(errPath, '', { flag: 'a', mode: 0o600 });
    const plistPath = path.join(agents, `${label}.plist`);
    const supervisor = path.join(repoRoot, 'desktop_mac/infrastructure/processes/launchers/supervisor.mjs');
    const supervisorArgs = [supervisor, role, outPath, errPath, executable, ...args];
    const plist = createLaunchdPlist({ label, executable: process.execPath, args: supervisorArgs, workingDirectory, logPath: '/dev/null', errorPath: errPath, pathValue, environment: { ...environment, MAC_LAUNCHD_LABEL: label } });
    await writeFile(plistPath, plist, { mode: 0o600 });
    try { await launchAgent(label, plistPath); }
    catch (error) {
      if (error.stage) throw error;
      throw internalError(`Failed to start ${role}: ${error.stderr?.trim() || error.message}`);
    }
    let processInfo;
    try { processInfo = await waitForAgentIdentity(label, [process.execPath, ...supervisorArgs]); }
    catch {
      await unload(label, role).catch(() => {});
      throw internalError(`Failed to verify ${role} process identity; inspect ${errPath} and retry`);
    }
    const pid = processInfo.pid;
    const record = { ownership: 'owned', role, mode, repoRealPath: repoRoot, pid, startTime: processInfo.startTime, command: processInfo.command, commandIdentity: stableHash(processInfo.command), label, logPath: outPath, errorLogPath: errPath, plistPath };
    createdRecords.add(record);
    return record;
  }

  const supervisorPath = path.join(repoRoot, 'desktop_mac/infrastructure/processes/launchers/supervisor.mjs');

  /** A repository-scoped launchd label is ours only while it still runs our supervisor for that role. */
  async function inspectOwnAgent(label, role) {
    let agent;
    try { agent = await printAgent(label); } catch (error) {
      if (isMissingAgent(error, label)) return { loaded: false, owned: false, pid: null };
      throw error;
    }
    const pid = parsePid(agent.stdout);
    if (!pid) return { loaded: true, owned: true, pid: null };
    const argv = await readProcessArgv(pid);
    return { loaded: true, owned: Array.isArray(argv) && argv[1] === supervisorPath && argv[2] === role, pid };
  }

  async function descendsFrom(pid, ancestorPid) {
    let current = pid;
    for (let depth = 0; current > 1 && depth < 12; depth += 1) {
      if (current === ancestorPid) return true;
      try { current = Number((await exec('/bin/ps', ['-o', 'ppid=', '-p', String(current)])).stdout.trim()); }
      catch { return false; }
    }
    return false;
  }

  /** ts-node-dev respawns the API with a new PID; the listener still belongs to our launchd supervisor. */
  async function adoptOwnAgentForListener(role, mode, listenerPid) {
    const label = launchdLabel({ repoRealPath: repoRoot, mode, role });
    const agent = await inspectOwnAgent(label, role);
    if (!agent.loaded || !agent.owned || !agent.pid || !await descendsFrom(listenerPid, agent.pid)) return null;
    const info = await inspectProcess(agent.pid);
    if (!info) return null;
    return {
      ownership: 'owned', role, mode, repoRealPath: repoRoot, pid: agent.pid, startTime: info.startTime, command: info.command,
      commandIdentity: stableHash(info.command), label, logPath: path.join(logs, `${role}.log`), errorLogPath: path.join(logs, `${role}.error.log`),
      plistPath: path.join(agents, `${label}.plist`),
    };
  }

  async function stopRecord(role, record, expected) {
    const label = launchdLabel({ repoRealPath: expected.repoRealPath, mode: expected.mode ?? record.mode, role });
    if (record.label !== label) throw internalError(`Refusing to stop ${role}: launchd label does not match`, 4);
    if (!await inspectProcess(record.pid)) {
      // A dead job can be unloaded only if launchd has not assigned it a new PID.
      let inactive;
      try { inactive = await printAgent(label); } catch (error) { if (isMissingAgent(error, label)) return; throw error; }
      if (parsePid(inactive.stdout)) throw internalError(`Refusing to stop ${role}: launchd identity changed`, 4);
      await unload(label, role);
      return;
    }
    if (!await processMatches(record, { ...expected, role })) {
      // A different start time or command proves the recorded PID was reused by another program.
      // Never signal that PID; only unload the label if it still runs this repository's supervisor.
      const agent = await inspectOwnAgent(label, role);
      if (!agent.loaded) return;
      if (!agent.owned) throw internalError(`Refusing to stop ${role}: process ownership could not be verified`, 4);
      await unload(label, role);
      return;
    }
    let agent;
    try { agent = await printAgent(label); } catch { throw internalError(`Refusing to stop ${role}: launchd ownership could not be verified`, 4); }
    if (parsePid(agent.stdout) !== record.pid) throw internalError(`Refusing to stop ${role}: launchd PID does not match the recorded process`, 4);
    await unload(record.label, role);
  }

  async function waitHttp(url, timeoutMs, { accept = (response) => response.ok } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5_000);
        try { const response = await fetch(url, { signal: controller.signal }); const accepted = await accept(response); await response.body?.cancel(); if (accepted) return response; }
        finally { clearTimeout(timer); }
      } catch {}
      await delay(500);
    }
    throw internalError(`Health check timed out for ${new URL(url).pathname}; inspect ${logs} and retry`);
  }

  return {
    async beginStart() { createdRecords.clear(); },
    async commitStart() { createdRecords.clear(); },
    ensureRendererDependencies() {
      requireMacOS();
      ensureRendererDependencies(repoRoot, pnpm);
    },
    async nativeStatus() {
      try { return await sendNativeCommand(nativeSocketPath(repoRoot), 'status'); } catch { return null; }
    },
    async nativeProcessAlive(current) {
      const record = current.processes?.app;
      if (!record) return false;
      const actual = await inspectProcess(record.pid);
      return Boolean(actual && actual.startTime === record.startTime && stableHash(actual.command) === record.commandIdentity);
    },
    async focus(current) {
      const result = await sendNativeCommand(nativeSocketPath(repoRoot), 'focus');
      if (!result.ok || result.repo !== repoRoot || result.mode !== current.runningMode || result.backendIdentity !== current.backendIdentity) throw internalError('Existing native window identity does not match the saved state', 4);
    },
    async requestNativeClose(current) {
      const status = await sendNativeCommand(nativeSocketPath(repoRoot), 'status');
      if (status.repo !== repoRoot || status.mode !== current.runningMode || status.backendIdentity !== current.backendIdentity) throw internalError('Native window identity does not match the saved state', 4);
      return sendNativeCommand(nativeSocketPath(repoRoot), 'close', { timeoutMs: 60_000 });
    },
    async prepare({ mode, development }) {
      requireMacOS();
      if (mode === 'local' && listenPid(config.localApiPort).length === 0) {
        await measure('准备本机后端依赖', async () => {
          await validateLocalDatabase(repoRoot);
          const node = selectServerNode(repoRoot);
          process.stdout.write(`[local-api] Node: ${node}\n`);
          const sharedBuild = spawnSync(pnpm, ['--filter', '@ai-novel/shared', 'build'], { cwd: repoRoot, env: process.env, stdio: 'inherit' });
          if (sharedBuild.status !== 0) throw internalError(`Shared package build failed; inspect ${logs} and retry`);
        });
      }
      return prepareDesktopBuild({ repoRoot, buildsDir: path.join(runtime, 'builds'), mode, development, pnpm, measure });
    },
    async ensureConnection({ mode, current }) {
      let localDbPath = null;
      let targetIdentity;
      if (mode === 'local') {
        localDbPath = await validateLocalDatabase(repoRoot);
        targetIdentity = path.relative(repoRoot, localDbPath);
      } else targetIdentity = `${config.sshTarget}\0${config.serverDir}\0${config.remoteWebPort}`;
      const backendIdentity = makeBackendIdentity({ mode, repoRealPath: repoRoot, target: targetIdentity });
      const processes = {};
      if (mode === 'local') {
        let existing = current?.processes?.['local-api'];
        if (existing?.ownership === 'borrowed' && existing.databaseIdentity && existing.databaseIdentity !== backendIdentity) {
          throw internalError('The borrowed local API is configured for a different local database; it was left running', 4);
        }
        if (existing?.ownership === 'owned' && existing.databaseIdentity === backendIdentity && await processMatches(existing, { repoRealPath: repoRoot, role: 'local-api', mode })) {
          processes['local-api'] = existing;
        } else {
          if (existing?.ownership === 'owned' && await processMatches(existing, { repoRealPath: repoRoot, role: 'local-api', mode })) {
            const idle = existing.databasePath ? await inspectSqliteQuiescence({ dbPath: existing.databasePath }) : { safeToStop: false };
            if (idle.safeToStop !== true) throw internalError('Local database settings changed while the owned API is active or cannot be verified idle; the existing service remains running', 4);
            await stopRecord('local-api', existing, { repoRealPath: repoRoot, mode });
          }
          const pids = listenPid(config.localApiPort);
          if (pids.length > 1) throw internalError(`Several processes own local API port ${config.localApiPort}; inspect the listeners`, 4);
          if (pids.length === 1) {
            const pid = pids[0];
            const adopted = await adoptOwnAgentForListener('local-api', mode, pid);
            if (adopted) processes['local-api'] = { ...adopted, databaseIdentity: backendIdentity, databasePath: localDbPath };
            else {
              const info = await inspectProcess(pid); const cwd = await workingDirectory(pid);
              const verifiedEntry = info && (/(?:@ai-novel\/server|server\/(?:src|dist)|dev:api)/.test(info.command) || info.command.includes('ts-node-dev') && info.command.includes('src/app.ts'));
              if (!info || cwd !== path.join(repoRoot, 'server') || !verifiedEntry) throw internalError(`Port ${config.localApiPort} belongs to an unverified process (pid ${pid}); stop or inspect it manually`, 4);
              processes['local-api'] = { ownership: 'borrowed', role: 'local-api', mode, repoRealPath: repoRoot, pid, startTime: info.startTime, command: info.command, commandIdentity: stableHash(info.command), cwd, databaseIdentity: backendIdentity, databasePath: localDbPath };
            }
          } else {
            const launcher = path.join(repoRoot, 'desktop_mac/infrastructure/processes/server-launcher.mjs');
            const node = selectServerNode(repoRoot);
            processes['local-api'] = Object.assign(await startAgent({ role: 'local-api', mode, executable: node, args: [launcher], environment: { PATH: `${path.dirname(node)}:${pathValue}`, MAC_LOCAL_API_PORT: String(config.localApiPort), MAC_DATABASE_URL: `file:${localDbPath}` } }), { databaseIdentity: backendIdentity, databasePath: localDbPath });
          }
        }
      } else {
        let existing = current?.processes?.tunnel;
        const targetMatches = existing?.sshTarget === config.sshTarget && existing?.localPort === config.tunnelPort && existing?.remotePort === config.remoteWebPort;
        const ownedExisting = existing?.ownership === 'owned' && await processMatches(existing, { repoRealPath: repoRoot, role: 'tunnel', mode });
        if (ownedExisting && targetMatches) processes.tunnel = existing;
        else {
          if (ownedExisting && !targetMatches) await stopRecord('tunnel', existing, { repoRealPath: repoRoot, mode });
          const pids = listenPid(config.tunnelPort);
          if (pids.length > 1) throw internalError(`Several processes own tunnel port ${config.tunnelPort}; inspect the listeners`, 4);
          if (pids.length === 1) {
            const pid = pids[0]; const info = await inspectProcess(pid);
            if (!info || !await tunnelMatches({ pid, sshTarget: config.sshTarget, localPort: config.tunnelPort, remotePort: config.remoteWebPort })) throw internalError(`Port ${config.tunnelPort} belongs to an SSH process whose complete tunnel target could not be verified (pid ${pid}); inspect the SSH destination or choose another TUNNEL_PORT`, 4);
            processes.tunnel = { ownership: 'borrowed', role: 'tunnel', mode, repoRealPath: repoRoot, pid, startTime: info.startTime, command: info.command, commandIdentity: stableHash(info.command), sshTarget: config.sshTarget, localPort: config.tunnelPort, remotePort: config.remoteWebPort };
          } else {
            const sshArgs = ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-L', `127.0.0.1:${config.tunnelPort}:127.0.0.1:${config.remoteWebPort}`, config.sshTarget];
            processes.tunnel = { ...(await startAgent({ role: 'tunnel', mode, executable: '/usr/bin/ssh', args: sshArgs })), sshTarget: config.sshTarget, localPort: config.tunnelPort, remotePort: config.remoteWebPort };
          }
        }
      }
      const apiTarget = `http://127.0.0.1:${mode === 'local' ? config.localApiPort : config.tunnelPort}`;
      const deadline = Date.now() + 120_000;
      await waitHttp(`${apiTarget}/api/health`, deadline - Date.now(), { accept: async (response) => { const body = await response.clone().json(); return response.ok && body.success === true && body.data?.status === 'ok'; } });
      await waitHttp(`${apiTarget}/api/novels?page=1&limit=1`, deadline - Date.now(), { accept: async (response) => response.ok && (await response.clone().json()).success === true });
      return { backendIdentity, processes, apiTarget };
    },
    async startHelpers({ mode, development, paths, build, connection }) {
      if (development) {
        await assertPortFree(config.devUiPort);
        const workspace = path.join(repoRoot, 'desktop_mac');
        const vite = path.join(workspace, 'node_modules/.bin/vite');
        try { await access(vite, constants.X_OK); }
        catch { throw internalError('找不到可执行的 Vite，请按 Mac 源码启动说明安装桌面开发依赖。', 2); }
        // The workspace shim execs Vite, so the supervisor can signal the actual HTTP server.
        const args = ['--config', 'renderer/vite.config.ts', '--host', '127.0.0.1', '--port', String(config.devUiPort), '--strictPort'];
        const viteRecord = await startAgent({ role: 'vite', mode, executable: vite, args, workingDirectory: workspace, environment: { MAC_APP_MODE: mode, MAC_API_TARGET: connection.apiTarget } });
        return { processes: { vite: viteRecord }, uiUrl: `http://127.0.0.1:${config.devUiPort}` };
      }
      const port = config.appUiPort; await assertPortFree(port);
      const serverModule = path.join(repoRoot, 'desktop_mac/infrastructure/transport/server.mjs');
      const proxyRecord = await startAgent({ role: 'mac-proxy', mode, executable: process.execPath, args: [serverModule], environment: {
        MAC_API_TARGET: connection.apiTarget, MAC_RENDERER_ROOT: build.rendererRoot, MAC_MODE: mode,
        MAC_BACKEND_IDENTITY: connection.backendIdentity, MAC_PORT: String(port), MAC_APP_VERSION: JSON.parse(await readFile(path.join(repoRoot, 'desktop/package.json'), 'utf8')).version,
      } });
      return { processes: { 'mac-proxy': proxyRecord }, uiUrl: `http://127.0.0.1:${port}` };
    },
    async openNative({ mode, build, connection, helpers }) {
      const socketPath = nativeSocketPath(repoRoot);
      const args = ['--url', helpers.uiUrl, '--repo', repoRoot, '--mode', mode, '--backend-identity', connection.backendIdentity, '--socket', socketPath];
      const child = spawn(build.executable, args, { cwd: repoRoot, detached: true, stdio: 'ignore' }); child.unref();
      const processInfo = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('spawn', async () => { await delay(200); const inspected = await inspectProcess(child.pid); inspected ? resolve(inspected) : reject(new Error('Native process could not be verified')); });
      }).catch(() => { throw internalError(`Could not launch AI Novel Mac; inspect ${logs} and retry`); });
      const record = { ownership: 'owned', role: 'app', mode, backendIdentity: connection.backendIdentity, repoRealPath: repoRoot, pid: child.pid, startTime: processInfo.startTime, command: processInfo.command, commandIdentity: stableHash(processInfo.command), socketPath, executable: build.executable };
      createdRecords.add(record);
      return { pid: child.pid, process: record };
    },
    async waitRendererReady(windowInfo, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try { const status = await sendNativeCommand(nativeSocketPath(repoRoot), 'status', { timeoutMs: 1000 }); if (status.rendererReady === true && status.pid === windowInfo.pid && status.repo === repoRoot) return; } catch {}
        await delay(250);
      }
      throw internalError(`Renderer did not become ready within ${timeoutMs / 1000}s; inspect ${logs} and retry`);
    },
    async waitHealthy({ mode, development, config: cfg, timeoutMs }) {
      const port = development ? cfg.devUiPort : cfg.appUiPort;
      await waitHttp(`http://127.0.0.1:${port}/__mac/health`, timeoutMs);
      await waitHttp(`http://127.0.0.1:${port}/api/health`, timeoutMs);
    },
    async waitAppExited(current, timeoutMs) {
      const record = current.processes?.app;
      if (!record) return;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { const actual = await inspectProcess(record.pid); if (!actual || actual.startTime !== record.startTime || stableHash(actual.command) !== record.commandIdentity) return; await delay(200); }
      throw internalError(`Native app did not exit within ${timeoutMs / 1000}s; helpers remain running`, 3);
    },
    async localApiIdle(record) {
      const result = record?.databasePath ? await inspectSqliteQuiescence({ dbPath: record.databasePath }) : { safeToStop: false, reason: 'owned database identity is missing' };
      if (!result.safeToStop) await appendRoleLog(logs, 'local-api', `retained because task state could not be confirmed idle: ${result.reason}`);
      return result.safeToStop === true;
    },
    async stopOwned(role, record, expected) { return stopRecord(role, record, expected); },
    /** Unload window helpers that run this repository's supervisor but are missing from state. */
    async cleanupOrphanAgents(current) {
      const tracked = new Set(Object.values(current?.processes ?? {}).map((record) => record?.label).filter(Boolean));
      const stopped = [];
      for (const mode of ['local', 'remote']) {
        for (const role of ['mac-proxy', 'vite', 'native-watcher']) {
          const label = launchdLabel({ repoRealPath: repoRoot, mode, role });
          if (tracked.has(label)) continue;
          const agent = await inspectOwnAgent(label, role);
          if (!agent.loaded || !agent.owned) continue;
          await unload(label, role);
          stopped.push(`${mode}/${role}`);
        }
      }
      return stopped;
    },
    async cleanupWindowHelpers(current) {
      for (const [role, record] of Object.entries(current.processes ?? {})) if (!['app', 'local-api', 'tunnel'].includes(role) && record.ownership === 'owned' && await processMatches(record, { repoRealPath: repoRoot, role, mode: record.mode ?? current.runningMode })) await stopRecord(role, record, { repoRealPath: repoRoot, mode: record.mode ?? current.runningMode });
    },
    async cleanupPreviousHelpers({ current, nextProcesses }) {
      const retained = {};
      for (const [role, record] of Object.entries(current.processes ?? {})) {
        if (role === 'app') continue;
        const replacement = nextProcesses[role];
        if (replacement?.pid === record.pid && replacement?.startTime === record.startTime) continue;
        if (record.ownership === 'borrowed' || role === 'local-api' && record.ownership === 'owned') retained[role] = record;
        else if (record.ownership === 'owned' && await processMatches(record, { repoRealPath: repoRoot, role, mode: record.mode ?? current.runningMode })) await stopRecord(role, record, { repoRealPath: repoRoot, mode: record.mode ?? current.runningMode });
      }
      return retained;
    },
    async restorePrevious({ current }) {
      if (!current.runningMode || !current.previousSuccessfulBuild) return null;
      await this.cleanupWindowHelpers(current);
      const connection = await this.ensureConnection({ mode: current.runningMode, config, current });
      const helpers = await this.startHelpers({ mode: current.runningMode, development: current.previousSuccessfulBuild.development === true, config, paths: { repoRoot, runtimeDir: runtime }, build: current.previousSuccessfulBuild, connection });
      await this.waitHealthy({ mode: current.runningMode, development: current.previousSuccessfulBuild.development === true, config, timeoutMs: 120_000 });
      const windowInfo = await this.openNative({ mode: current.runningMode, config, paths: { repoRoot, runtimeDir: runtime }, build: current.previousSuccessfulBuild, connection, helpers });
      await this.waitRendererReady(windowInfo, 30_000);
      const watcher = await this.watchNativeExit(windowInfo, { mode: current.runningMode, backendIdentity: connection.backendIdentity });
      return { ...current, runningMode: current.runningMode, backendIdentity: connection.backendIdentity, buildFingerprint: current.previousSuccessfulBuild.fingerprint, processes: { ...connection.processes, ...helpers.processes, app: windowInfo.process, 'native-watcher': watcher } };
    },
    async cleanupFailedStart() {
      const retained = {};
      const app = [...createdRecords].find((record) => record.role === 'app');
      if (app) {
        const failed = { runningMode: app.mode, backendIdentity: app.backendIdentity, processes: { app } };
        try {
          if (await this.nativeProcessAlive(failed)) {
            const result = await this.requestNativeClose(failed);
            if (!result.ok) throw internalError('Close was cancelled', 3);
            await this.waitAppExited(failed, 60_000);
          }
          createdRecords.delete(app);
        } catch {
          // Preserve the complete usable window environment on cancellation/timeout.
          return Object.fromEntries([...createdRecords].map((record) => [record.role, record]));
        }
      }
      for (const record of [...createdRecords].reverse()) {
        if (record.role === 'local-api') {
          let idle = false;
          try { idle = await this.localApiIdle(record); } catch {}
          if (!idle) { retained[record.role] = record; continue; }
        }
        try { await stopRecord(record.role, record, { repoRealPath: repoRoot, mode: record.mode }); createdRecords.delete(record); }
        catch { retained[record.role] = record; }
      }
      return retained;
    },
    async watchNativeExit(windowInfo, { mode, backendIdentity }) {
      const watcherPath = path.join(repoRoot, 'desktop_mac/infrastructure/processes/native-exit-watcher.mjs');
      const label = launchdLabel({ repoRealPath: repoRoot, mode, role: 'native-watcher' });
      return startAgent({ role: 'native-watcher', mode, executable: process.execPath, args: [watcherPath], environment: {
        MAC_REPO_ROOT: repoRoot,
        MAC_MODE: mode,
        MAC_BACKEND_IDENTITY: backendIdentity,
        MAC_NATIVE_PID: String(windowInfo.process.pid),
        MAC_NATIVE_START_TIME: windowInfo.process.startTime,
        MAC_NATIVE_COMMAND_ID: windowInfo.process.commandIdentity,
        MAC_WATCHER_LABEL: label,
      } });
    },
    async report(message) { process.stdout.write(`${message}\n`); },
  };
}
