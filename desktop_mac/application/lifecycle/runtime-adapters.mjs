import { createHash } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { appendRoleLog } from '../../infrastructure/processes/logging.mjs';
import { createLaunchdPlist, launchAgent, launchdLabel, printAgent, stopAgent, waitForAgentIdentity } from '../../infrastructure/processes/launchd.mjs';
import { inspectProcess, processMatches, stableHash } from '../../infrastructure/processes/identity.mjs';
import { nativeSocketPath, sendNativeCommand } from '../../infrastructure/processes/native-socket.mjs';
import { backendIdentity as makeBackendIdentity } from '../../infrastructure/processes/identity.mjs';
import { inspectSqliteQuiescence, resolveLocalDatabasePath } from '../../infrastructure/processes/quiescence.mjs';
import { selectServerNode } from '../../infrastructure/processes/launchers/server-node.mjs';
import { tunnelMatches } from '../../infrastructure/transport/ssh-identity.mjs';

const exec = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const internalError = (message, exitCode = 5) => Object.assign(new Error(message), { exitCode });

export async function sourceFingerprint(repoRoot, { toolVersions = true } = {}) {
  const hash = createHash('sha256');
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (["node_modules", "dist", ".git", ".runtime"].includes(entry.name)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) { hash.update(path.relative(repoRoot, full)); hash.update(await readFile(full)); }
    }
  }
  for (const relative of ['desktop_mac/native', 'desktop_mac/renderer', 'client/src', 'shared']) await walk(path.join(repoRoot, relative));
  for (const relative of ['desktop_mac/package.json', 'desktop/package.json', 'shared/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json']) {
    try { hash.update(relative); hash.update(await readFile(path.join(repoRoot, relative))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  hash.update(process.version); hash.update(os.arch());
  if (toolVersions) for (const [bin, args] of [['pnpm', ['--version']], ['xcrun', ['swiftc', '--version']]]) {
    const result = spawnSync(bin, args, { cwd: repoRoot, encoding: 'utf8' });
    if (result.status !== 0) throw internalError(`${bin} prerequisite check failed`);
    hash.update(result.stdout.trim());
  }
  return hash.digest('hex');
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

export function createRuntimeAdapters(config) {
  const repoRoot = config.repoRealPath;
  const runtime = path.join(repoRoot, '.runtime/desktop_mac');
  const logs = path.join(repoRoot, '.logs/desktop_mac');
  const agents = path.join(runtime, 'agents');
  const pnpm = absolutePnpm();
  const pathValue = [path.dirname(process.execPath), path.dirname(pnpm), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const createdRecords = new Set();

  async function startAgent({ role, mode, executable, args, environment = {} }) {
    const label = launchdLabel({ repoRealPath: repoRoot, mode, role });
    const outPath = path.join(logs, `${role}.log`); const errPath = path.join(logs, `${role}.error.log`);
    await mkdir(agents, { recursive: true, mode: 0o700 }); await mkdir(logs, { recursive: true, mode: 0o700 });
    await writeFile(outPath, '', { flag: 'a', mode: 0o600 }); await writeFile(errPath, '', { flag: 'a', mode: 0o600 });
    const plistPath = path.join(agents, `${label}.plist`);
    const supervisor = path.join(repoRoot, 'desktop_mac/infrastructure/processes/launchers/supervisor.mjs');
    const supervisorArgs = [supervisor, role, outPath, errPath, executable, ...args];
    const plist = createLaunchdPlist({ label, executable: process.execPath, args: supervisorArgs, repoRealPath: repoRoot, logPath: '/dev/null', errorPath: errPath, pathValue, environment: { ...environment, MAC_LAUNCHD_LABEL: label } });
    await writeFile(plistPath, plist, { mode: 0o600 });
    try { await launchAgent(plistPath); } catch (error) { throw internalError(`Failed to start ${role}; inspect ${errPath} and retry (${error.code ?? 'launchd'})`); }
    let processInfo;
    try { processInfo = await waitForAgentIdentity(label, [process.execPath, ...supervisorArgs]); }
    catch {
      await stopAgent(label).catch(() => {});
      throw internalError(`Failed to verify ${role} process identity; inspect ${errPath} and retry`);
    }
    const pid = processInfo.pid;
    const record = { ownership: 'owned', role, mode, repoRealPath: repoRoot, pid, startTime: processInfo.startTime, command: processInfo.command, commandIdentity: stableHash(processInfo.command), label, logPath: outPath, errorLogPath: errPath, plistPath };
    createdRecords.add(record);
    return record;
  }

  async function stopRecord(role, record, expected) {
    const label = launchdLabel({ repoRealPath: expected.repoRealPath, mode: expected.mode ?? record.mode, role });
    if (record.label !== label) throw internalError(`Refusing to stop ${role}: launchd label does not match`, 4);
    if (!await inspectProcess(record.pid)) {
      // A dead job can be unloaded only if launchd has not assigned it a new PID.
      let inactive;
      try { inactive = await printAgent(label); } catch { return; }
      if (parsePid(inactive.stdout)) throw internalError(`Refusing to stop ${role}: launchd identity changed`, 4);
      await stopAgent(label);
      return;
    }
    if (!await processMatches(record, { ...expected, role })) throw internalError(`Refusing to stop ${role}: process ownership could not be verified`, 4);
    let agent;
    try { agent = await printAgent(label); } catch { throw internalError(`Refusing to stop ${role}: launchd ownership could not be verified`, 4); }
    if (parsePid(agent.stdout) !== record.pid) throw internalError(`Refusing to stop ${role}: launchd PID does not match the recorded process`, 4);
    try { await stopAgent(record.label); } catch (error) { throw internalError(`Could not stop owned ${role}; inspect ${record.errorLogPath}`); }
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
      if (process.platform !== 'darwin') throw internalError('Mac lifecycle commands require macOS', 2);
      if (mode === 'local' && listenPid(config.localApiPort).length === 0) {
        await validateLocalDatabase(repoRoot);
        const node = selectServerNode(repoRoot);
        process.stdout.write(`[local-api] Node: ${node}\n`);
        const sharedBuild = spawnSync(pnpm, ['--filter', '@ai-novel/shared', 'build'], { cwd: repoRoot, env: process.env, stdio: 'inherit' });
        if (sharedBuild.status !== 0) throw internalError(`Shared package build failed; inspect ${logs} and retry`);
      }
      const fingerprint = await sourceFingerprint(repoRoot);
      const outDir = path.join(runtime, 'builds', fingerprint);
      const rendererRoot = path.join(outDir, 'renderer'); const nativeRoot = path.join(outDir, 'native');
      await mkdir(path.dirname(rendererRoot), { recursive: true, mode: 0o700 });
      if (!development) {
        const env = { ...process.env, MAC_RENDERER_OUT_DIR: rendererRoot };
        const rendererBuild = spawnSync(pnpm, ['--filter', '@ai-novel/desktop-mac', 'run', 'build:renderer'], { cwd: repoRoot, env, stdio: 'inherit' });
        if (rendererBuild.status !== 0) throw internalError(`Renderer build failed; previous app remains available; inspect ${logs} and retry`);
      }
      const nativeBuild = spawnSync(process.execPath, [path.join(repoRoot, 'desktop_mac/native/build.mjs'), '--out-dir', nativeRoot], { cwd: repoRoot, stdio: 'inherit' });
      if (nativeBuild.status !== 0) throw internalError(`Native build failed; previous app remains available; inspect ${logs} and retry`);
      const appPath = path.join(nativeRoot, 'AI Novel Mac.app');
      const executable = path.join(appPath, 'Contents/MacOS/AI-Novel-Mac');
      return { fingerprint, rendererRoot, executable, appPath, development, mode };
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
            const pid = pids[0]; const info = await inspectProcess(pid); const cwd = await workingDirectory(pid);
            const verifiedEntry = info && (/(?:@ai-novel\/server|server\/(?:src|dist)|dev:api)/.test(info.command) || info.command.includes('ts-node-dev') && info.command.includes('src/app.ts'));
            if (!info || cwd !== path.join(repoRoot, 'server') || !verifiedEntry) throw internalError(`Port ${config.localApiPort} belongs to an unverified process (pid ${pid}); stop or inspect it manually`, 4);
            processes['local-api'] = { ownership: 'borrowed', role: 'local-api', mode, repoRealPath: repoRoot, pid, startTime: info.startTime, command: info.command, commandIdentity: stableHash(info.command), cwd, databaseIdentity: backendIdentity, databasePath: localDbPath };
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
        const args = ['--filter', '@ai-novel/desktop-mac', 'exec', 'vite', '--config', 'renderer/vite.config.ts', '--host', '127.0.0.1', '--port', String(config.devUiPort), '--strictPort'];
        const viteRecord = await startAgent({ role: 'vite', mode, executable: pnpm, args, environment: { MAC_APP_MODE: mode, MAC_API_TARGET: connection.apiTarget } });
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
